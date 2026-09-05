import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'

export const PROTOCOL_VERSION = 1
const DEFAULT_PORT = 3847
const DEFAULT_ROOM = 'default'
const MAX_FRAME_BYTES = 256 * 1024
const ALLOWED_PLAYER_COMMANDS = new Set([
  'world.getSnapshot',
  'token.move',
  'chat.send',
  'intent.submit',
  'connection.ping',
])

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientRoot = normalize(join(__dirname, '..', 'client'))

function envelope(kind, type, payload = {}, extra = {}) {
  return { v: PROTOCOL_VERSION, kind, type, ...extra, payload }
}

function send(ws, message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

function parseFrame(data) {
  if (Buffer.byteLength(data) > MAX_FRAME_BYTES) return { error: 'FRAME_TOO_LARGE' }
  try {
    const message = JSON.parse(String(data))
    if (!message || typeof message !== 'object' || Array.isArray(message)) return { error: 'INVALID_MESSAGE' }
    return { message }
  } catch {
    return { error: 'INVALID_JSON' }
  }
}

function sanitizeRoomId(value) {
  const roomId = String(value || DEFAULT_ROOM).trim()
  return /^[a-zA-Z0-9_-]{1,64}$/.test(roomId) ? roomId : null
}

function normalizeLegacy(message, connection) {
  if (message.v === PROTOCOL_VERSION && message.kind && message.type) return message
  if (message.type === 'hello') {
    return envelope('hello', 'connection.hello', {
      role: message.role,
      roomId: message.roomId || DEFAULT_ROOM,
      name: message.name,
      accessKey: message.accessKey,
      capabilities: [],
    })
  }
  const legacyTypes = {
    'request-state': 'world.getSnapshot',
    move: 'token.move',
    chat: 'chat.send',
    intent: 'intent.submit',
    ping: 'connection.ping',
    state: 'world.snapshot',
    pong: 'connection.pong',
  }
  const type = legacyTypes[message.type]
  if (!type) return message
  const payload = { ...message }
  delete payload.type
  if (message.type === 'move' && !payload.destination) {
    payload.destination = { x: Number(payload.x), y: Number(payload.y) }
  }
  return envelope(
    connection?.role === 'foundry' ? 'event' : 'command',
    type,
    payload,
    connection?.role === 'foundry' ? {} : { id: message.id || randomUUID() },
  )
}

function roomStatus(room) {
  return {
    foundryConnected: room.foundry?.readyState === WebSocket.OPEN,
    players: [...room.clients].filter((client) => client.meta.role === 'player').length,
    spectators: [...room.clients].filter((client) => client.meta.role === 'spectator').length,
  }
}

export function createBridgeServer(options = {}) {
  const port = Number(options.port ?? process.env.BRIDGE_PORT ?? DEFAULT_PORT)
  const host = options.host ?? process.env.BRIDGE_HOST ?? '0.0.0.0'
  const secret = options.secret ?? process.env.BRIDGE_SECRET ?? ''
  const logger = options.logger ?? console
  const rooms = new Map()

  function getRoom(roomId) {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, { foundry: null, clients: new Set(), latestSnapshot: null, pending: new Map() })
    }
    return rooms.get(roomId)
  }

  function broadcast(room, message, except = null) {
    const raw = JSON.stringify(message)
    for (const client of room.clients) {
      if (client !== except && client.readyState === WebSocket.OPEN) client.send(raw)
    }
  }

  function systemError(ws, code, message, replyTo) {
    send(ws, envelope('system', 'connection.error', { code, message }, replyTo ? { replyTo } : {}))
  }

  const httpServer = createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (requestUrl.pathname === '/health') {
      const roomData = Object.fromEntries([...rooms].map(([id, room]) => [id, roomStatus(room)]))
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION, rooms: roomData }))
      return
    }

    let relative = requestUrl.pathname === '/' ? 'index.html' : requestUrl.pathname.replace(/^\/client\/?/, '')
    if (!relative) relative = 'index.html'
    const path = normalize(join(clientRoot, relative))
    if (path !== clientRoot && !path.startsWith(`${clientRoot}${sep}`)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }
    try {
      const data = await readFile(path)
      const mime = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
      }[extname(path)] || 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': mime })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end('Not found')
    }
  })

  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: MAX_FRAME_BYTES })

  wss.on('connection', (ws) => {
    ws.meta = { id: randomUUID(), role: null, roomId: null, name: 'anonymous' }
    send(ws, envelope('system', 'connection.welcome', { protocolVersion: PROTOCOL_VERSION }))

    ws.on('message', (data) => {
      const parsed = parseFrame(data)
      if (parsed.error) {
        systemError(ws, parsed.error, 'The WebSocket frame is not a valid protocol message.')
        return
      }
      const message = normalizeLegacy(parsed.message, ws.meta)

      if (!ws.meta.role) {
        if (message.kind !== 'hello' || message.type !== 'connection.hello') {
          systemError(ws, 'HELLO_REQUIRED', 'Send connection.hello before any other message.')
          return
        }
        const payload = message.payload || {}
        const roomId = sanitizeRoomId(payload.roomId)
        const role = ['foundry', 'player', 'spectator'].includes(payload.role) ? payload.role : null
        if (!roomId || !role) {
          systemError(ws, 'INVALID_HELLO', 'A valid role and roomId are required.')
          return
        }
        if (secret && payload.accessKey !== secret) {
          systemError(ws, 'AUTH_FAILED', 'The access key is invalid.')
          ws.close(1008, 'Authentication failed')
          return
        }

        const room = getRoom(roomId)
        ws.meta = {
          id: ws.meta.id,
          role,
          roomId,
          name: String(payload.name || role).slice(0, 60),
          capabilities: Array.isArray(payload.capabilities) ? payload.capabilities : [],
        }
        if (role === 'foundry') {
          if (room.foundry && room.foundry !== ws) room.foundry.close(1012, 'Replaced by a new Foundry session')
          room.foundry = ws
          logger.log(`[bridge] Foundry connected to room ${roomId}`)
          broadcast(room, envelope('system', 'room.status', roomStatus(room)))
        } else {
          room.clients.add(ws)
          logger.log(`[bridge] ${role} ${ws.meta.name} connected to room ${roomId}`)
          if (room.foundry) {
            send(room.foundry, envelope('event', 'client.connected', {
              connectionId: ws.meta.id,
              role,
              name: ws.meta.name,
            }))
          }
        }
        send(ws, envelope('system', 'connection.ready', {
          connectionId: ws.meta.id,
          role,
          roomId,
          protocolVersion: PROTOCOL_VERSION,
          ...roomStatus(room),
        }))
        if (role !== 'foundry' && room.latestSnapshot) send(ws, room.latestSnapshot)
        return
      }

      const room = rooms.get(ws.meta.roomId)
      if (!room) return

      if (ws.meta.role !== 'foundry') {
        if (ws.meta.role === 'spectator' && message.type !== 'world.getSnapshot' && message.type !== 'connection.ping') {
          systemError(ws, 'PERMISSION_DENIED', 'Spectators cannot send gameplay commands.', message.id)
          return
        }
        if (message.kind !== 'command' || !message.id || !ALLOWED_PLAYER_COMMANDS.has(message.type)) {
          systemError(ws, 'UNSUPPORTED_COMMAND', `Unsupported command: ${message.type || 'unknown'}`, message.id)
          return
        }
        if (!room.foundry || room.foundry.readyState !== WebSocket.OPEN) {
          systemError(ws, 'FOUNDRY_OFFLINE', 'The authoritative Foundry session is not connected.', message.id)
          return
        }
        room.pending.set(message.id, { ws, createdAt: Date.now() })
        send(room.foundry, {
          ...message,
          roomId: ws.meta.roomId,
          source: { connectionId: ws.meta.id, role: ws.meta.role, name: ws.meta.name },
        })
        return
      }

      if (message.kind === 'response' && message.replyTo) {
        const pending = room.pending.get(message.replyTo)
        if (pending) {
          send(pending.ws, message)
          room.pending.delete(message.replyTo)
        }
        return
      }
      if (message.kind === 'event' || message.kind === 'system') {
        const routedMessage = { ...message, roomId: ws.meta.roomId }
        if (message.type === 'world.snapshot') room.latestSnapshot = routedMessage
        broadcast(room, routedMessage)
        return
      }
      systemError(ws, 'INVALID_FOUNDRY_MESSAGE', 'Foundry must send a response, event, or system message.')
    })

    ws.on('close', () => {
      const room = ws.meta.roomId ? rooms.get(ws.meta.roomId) : null
      if (!room) return
      if (ws.meta.role === 'foundry' && room.foundry === ws) {
        room.foundry = null
        for (const [id, pending] of room.pending) {
          systemError(pending.ws, 'FOUNDRY_OFFLINE', 'Foundry disconnected before answering.', id)
        }
        room.pending.clear()
        broadcast(room, envelope('system', 'room.status', roomStatus(room)))
      } else {
        room.clients.delete(ws)
        if (room.foundry) {
          send(room.foundry, envelope('event', 'client.disconnected', {
            connectionId: ws.meta.id,
            role: ws.meta.role,
            name: ws.meta.name,
          }))
        }
      }
      if (!room.foundry && room.clients.size === 0) rooms.delete(ws.meta.roomId)
    })
  })

  const pendingCleanup = setInterval(() => {
    const now = Date.now()
    for (const room of rooms.values()) {
      for (const [id, pending] of room.pending) {
        if (now - pending.createdAt > 30_000) {
          systemError(pending.ws, 'COMMAND_TIMEOUT', 'Foundry did not answer within 30 seconds.', id)
          room.pending.delete(id)
        }
      }
    }
  }, 5_000)
  pendingCleanup.unref()

  return {
    httpServer,
    rooms,
    async listen() {
      if (httpServer.listening) return httpServer.address()
      await new Promise((resolve) => httpServer.listen(port, host, resolve))
      return httpServer.address()
    },
    async close() {
      clearInterval(pendingCleanup)
      for (const client of wss.clients) client.terminate()
      await new Promise((resolve) => wss.close(resolve))
      if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve))
    },
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const bridge = createBridgeServer()
  const address = await bridge.listen()
  const port = typeof address === 'object' ? address.port : DEFAULT_PORT
  console.log(`[bridge] HTTP client: http://localhost:${port}/`)
  console.log(`[bridge] WebSocket: ws://localhost:${port}/ws`)
  console.log(`[bridge] Protocol v${PROTOCOL_VERSION}`)
}
