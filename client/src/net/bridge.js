export class Bridge extends EventTarget {
  constructor() {
    super()
    this.ws = null
    this.pending = new Map()
    this.connectionId = null
    this.revision = 0
    this.ready = false
    this.config = null
    this.reconnectTimer = null
    this.reconnectAttempt = 0
    this.manualClose = false
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN
  }

  connect({ url, campaignId, sessionToken }) {
    this.manualClose = false
    this.config = { url, campaignId, sessionToken }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.open()
  }

  open() {
    const { url, campaignId, sessionToken } = this.config || {}
    if (!url || !campaignId || !sessionToken) return
    const socket = new WebSocket(url)
    this.ws = socket
    this.ws.addEventListener('open', () => {
      this.send({
        v: 2,
        kind: 'hello',
        type: 'connection.hello',
        payload: {
          role: 'player',
          campaignId,
          sessionToken,
        },
      })
    })
    this.ws.addEventListener('message', (event) => this.onMessage(event.data))
    this.ws.addEventListener('close', () => {
      if (this.ws !== socket) return
      this.ready = false
      this.emit('disconnected', {})
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(Object.assign(new Error('Connection lost.'), { code: 'DISCONNECTED' }))
        this.pending.delete(id)
      }
      if (!this.manualClose) this.scheduleReconnect()
    })
    this.ws.addEventListener('error', () => this.emit('socket-error', {}))
  }

  close() {
    this.manualClose = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.ws?.close()
    this.ws = null
    this.ready = false
  }

  scheduleReconnect() {
    if (this.reconnectTimer || !this.config) return
    const delay = Math.min(15000, 800 * (2 ** this.reconnectAttempt++))
    this.emit('reconnecting', { delay })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message))
  }

  command(type, payload = {}) {
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Foundry did not answer.'))
      }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ v: 2, kind: 'command', type, id, idempotencyKey: crypto.randomUUID(), payload })
    })
  }

  onMessage(raw) {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    this.emit('frame', message)
    if (message.kind === 'response' && message.replyTo && this.pending.has(message.replyTo)) {
      const pending = this.pending.get(message.replyTo)
      this.pending.delete(message.replyTo)
      clearTimeout(pending.timer)
      if (message.payload?.ok === false) pending.reject(Object.assign(new Error(message.payload.error?.message || 'Command failed'), { code: message.payload.error?.code }))
      else pending.resolve(message.payload || {})
      return
    }
    if (message.type === 'connection.ready') {
      this.connectionId = message.payload?.connectionId
      this.ready = true
      this.reconnectAttempt = 0
    }
    if (message.type === 'connection.error') {
      this.emit('error', message.payload || {})
    }
    const revision = Number(message.payload?.revision)
    if (Number.isFinite(revision)) {
      if (this.revision && revision > this.revision + 1 && message.type !== 'world.snapshot') {
        this.command('world.snapshot.request').catch(() => {})
      }
      this.revision = Math.max(this.revision, revision)
    }
    this.emit(message.type, message.payload || {}, message)
  }

  emit(type, detail, message) {
    this.dispatchEvent(new CustomEvent(type, { detail: { ...detail, _message: message } }))
  }

  on(type, handler) {
    const wrapped = (event) => handler(event.detail, event)
    this.addEventListener(type, wrapped)
    return () => this.removeEventListener(type, wrapped)
  }
}

export function assetUrl(path) {
  if (!path) return null
  if (path.startsWith('data:') || path.startsWith('blob:')) return path
  const url = new URL(/^https?:/i.test(path) ? path : (path.startsWith('/') ? path : `/${path}`), location.origin)
  const sessionToken = localStorage.getItem('fb.sessionToken') || ''
  if (url.pathname.includes('/assets/') && sessionToken) url.searchParams.set('session', sessionToken)
  return url.toString()
}
