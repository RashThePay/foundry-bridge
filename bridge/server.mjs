/**
 * Tiny WebSocket relay:
 *   Foundry module  ↔  this bridge  ↔  player test clients
 *
 * Protocol (JSON text frames):
 *   { type: 'hello', role: 'foundry' | 'player', name?: string }
 *   { type: 'chat', text: string, speaker?: string }
 *   { type: 'move', tokenId?: string, tokenName?: string, x: number, y: number }
 *   { type: 'intent', verb: string, target?: string, text: string, player?: string }
 *   { type: 'state', ... }  // foundry → players
 *   { type: 'ack' | 'error' | 'info', ... }
 */
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.BRIDGE_PORT || 3847)

/** @type {import('ws').WebSocket | null} */
let foundrySocket = null
/** @type {Set<import('ws').WebSocket>} */
const players = new Set()

function send(ws, payload) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(payload))
}

function broadcastPlayers(payload) {
  const raw = JSON.stringify(payload)
  for (const ws of players) {
    if (ws.readyState === 1) ws.send(raw)
  }
}

function status() {
  return {
    type: 'info',
    foundryConnected: !!foundrySocket && foundrySocket.readyState === 1,
    players: players.size,
  }
}

const httpServer = createServer(async (req, res) => {
  const url = req.url || '/'
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(status()))
    return
  }

  // Serve the test client from / or /client/
  let file = 'index.html'
  if (url.startsWith('/client/') && url !== '/client/') {
    file = url.slice('/client/'.length)
  } else if (url === '/client') {
    res.writeHead(302, { Location: '/client/' })
    res.end()
    return
  }

  try {
    const path = join(__dirname, '..', 'client', file === '/' || file === '' ? 'index.html' : file)
    const data = await readFile(path)
    const type = path.endsWith('.js')
      ? 'text/javascript'
      : path.endsWith('.css')
        ? 'text/css'
        : 'text/html'
    res.writeHead(200, { 'Content-Type': type })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
})

const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

wss.on('connection', (ws) => {
  /** @type {'foundry' | 'player' | null} */
  let role = null
  let name = 'anon'

  send(ws, { type: 'welcome', ...status().foundryConnected !== undefined ? status() : {} })
  send(ws, status())

  ws.on('message', (buf) => {
    let msg
    try {
      msg = JSON.parse(String(buf))
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON' })
      return
    }

    if (msg.type === 'hello') {
      role = msg.role === 'foundry' ? 'foundry' : 'player'
      name = String(msg.name || (role === 'foundry' ? 'Foundry' : 'Player')).slice(0, 40)

      if (role === 'foundry') {
        if (foundrySocket && foundrySocket !== ws) {
          try {
            foundrySocket.close()
          } catch {
            /* ignore */
          }
        }
        foundrySocket = ws
        console.log('[bridge] Foundry connected')
        broadcastPlayers({ type: 'info', message: 'Foundry DM panel online', foundryConnected: true })
      } else {
        players.add(ws)
        console.log(`[bridge] Player connected: ${name} (${players.size} total)`)
        send(foundrySocket, { type: 'player-join', name })
      }

      send(ws, { type: 'hello-ok', role, name, ...status() })
      return
    }

    if (!role) {
      send(ws, { type: 'error', message: 'Send hello first' })
      return
    }

    // Player → Foundry
    if (role === 'player') {
      if (!foundrySocket || foundrySocket.readyState !== 1) {
        send(ws, { type: 'error', message: 'Foundry is not connected. Open a world with lpc-bridge enabled.' })
        return
      }

      const forward = { ...msg, player: name, from: 'player' }
      if (
        msg.type === 'chat' ||
        msg.type === 'move' ||
        msg.type === 'intent' ||
        msg.type === 'ping' ||
        msg.type === 'request-state'
      ) {
        send(foundrySocket, forward)
        send(ws, { type: 'ack', for: msg.type })
        // Echo chat to other players immediately for snappy UX; Foundry confirm is skipped client-side.
        if (msg.type === 'chat') {
          broadcastPlayers({
            type: 'chat',
            text: String(msg.text || ''),
            speaker: name,
            source: 'player',
          })
        }
        return
      }

      send(ws, { type: 'error', message: `Unknown type: ${msg.type}` })
      return
    }

    // Foundry → players
    if (role === 'foundry') {
      if (msg.type === 'state' || msg.type === 'chat' || msg.type === 'info' || msg.type === 'ack' || msg.type === 'error') {
        broadcastPlayers(msg)
        return
      }
      if (msg.type === 'pong') {
        send(ws, { type: 'ack', for: 'pong' })
        return
      }
      console.log('[bridge] foundry message', msg.type)
    }
  })

  ws.on('close', () => {
    if (role === 'foundry' && foundrySocket === ws) {
      foundrySocket = null
      console.log('[bridge] Foundry disconnected')
      broadcastPlayers({ type: 'info', message: 'Foundry DM panel offline', foundryConnected: false })
    }
    if (role === 'player') {
      players.delete(ws)
      console.log(`[bridge] Player left: ${name} (${players.size} left)`)
      send(foundrySocket, { type: 'player-leave', name })
    }
  })
})

httpServer.listen(PORT, () => {
  console.log(`[bridge] http://localhost:${PORT}/  (test client)`)
  console.log(`[bridge] ws://localhost:${PORT}/ws`)
  console.log(`[bridge] Foundry module should connect as role=foundry`)
})
