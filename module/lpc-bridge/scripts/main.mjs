const MODULE_ID = 'lpc-bridge'

/**
 * Foundry side of the spike.
 * Opens a WebSocket to the local bridge and applies player chat / moves / intents.
 */
class LpcBridge {
  constructor() {
    this.ws = null
    this.reconnectTimer = null
    this.manualClose = false
  }

  get url() {
    return game.settings.get(MODULE_ID, 'bridgeUrl')
  }

  get enabled() {
    return game.settings.get(MODULE_ID, 'enabled')
  }

  connect() {
    if (!this.enabled) {
      ui.notifications?.info('LPC Bridge is disabled in module settings.')
      return
    }
    if (!game.user?.isGM) {
      console.log(`${MODULE_ID} | Only the GM client connects to the bridge.`)
      return
    }

    this.manualClose = false
    this.disconnect(false)

    const url = this.url
    console.log(`${MODULE_ID} | Connecting to ${url}`)
    try {
      this.ws = new WebSocket(url)
    } catch (err) {
      console.error(`${MODULE_ID} | WebSocket create failed`, err)
      ui.notifications?.error('LPC Bridge: bad WebSocket URL')
      this.scheduleReconnect()
      return
    }

    this.ws.addEventListener('open', () => {
      console.log(`${MODULE_ID} | Connected`)
      ui.notifications?.info('LPC Bridge connected')
      this.send({ type: 'hello', role: 'foundry', name: game.user.name })
      this.pushState()
    })

    this.ws.addEventListener('message', (ev) => this.onMessage(ev.data))

    this.ws.addEventListener('close', () => {
      console.log(`${MODULE_ID} | Disconnected`)
      this.ws = null
      if (!this.manualClose && this.enabled) this.scheduleReconnect()
    })

    this.ws.addEventListener('error', (err) => {
      console.warn(`${MODULE_ID} | Socket error`, err)
    })
  }

  disconnect(manual = true) {
    this.manualClose = manual
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 2500)
  }

  send(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }

  async onMessage(raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    switch (msg.type) {
      case 'welcome':
      case 'hello-ok':
      case 'info':
      case 'ack':
        return
      case 'player-join':
        ui.notifications?.info(`LPC player joined: ${msg.name}`)
        return
      case 'player-leave':
        ui.notifications?.warn(`LPC player left: ${msg.name}`)
        return
      case 'chat':
        await this.handleChat(msg)
        return
      case 'move':
        await this.handleMove(msg)
        return
      case 'intent':
        await this.handleIntent(msg)
        return
      case 'ping':
        this.send({ type: 'pong' })
        return
      default:
        console.log(`${MODULE_ID} | Unhandled`, msg)
    }
  }

  async handleChat(msg) {
    const text = String(msg.text || '').trim()
    if (!text) return
    const speakerName = String(msg.speaker || msg.player || 'Player').slice(0, 60)

    await ChatMessage.create({
      content: text,
      speaker: { alias: `[LPC] ${speakerName}` },
      type: CONST.CHAT_MESSAGE_STYLES?.OTHER ?? CONST.CHAT_MESSAGE_TYPES?.OTHER ?? 0,
    })

    this.send({
      type: 'chat',
      text,
      speaker: speakerName,
      source: 'foundry-confirm',
    })
  }

  async handleMove(msg) {
    const x = Number(msg.x)
    const y = Number(msg.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      this.send({ type: 'error', message: 'move requires numeric x,y' })
      return
    }

    const token = this.findToken(msg.tokenId, msg.tokenName)
    if (!token) {
      this.send({
        type: 'error',
        message: 'No matching token on the current scene. Place a token or pass tokenName.',
      })
      ui.notifications?.warn('LPC Bridge: move failed — no token matched')
      return
    }

    await token.document.update({ x, y })
    ui.notifications?.info(`LPC Bridge: moved ${token.name} → (${x}, ${y})`)
    this.pushState()
    this.send({
      type: 'ack',
      for: 'move',
      tokenId: token.id,
      tokenName: token.name,
      x,
      y,
    })
  }

  async handleIntent(msg) {
    const player = msg.player || 'Player'
    const verb = msg.verb || 'custom'
    const target = msg.target || 'something'
    const text = msg.text || ''

    await ChatMessage.create({
      content: `<div class="lpc-intent"><strong>${foundry.utils.escapeHTML(player)}</strong> wants to <em>${foundry.utils.escapeHTML(verb)}</em> <strong>${foundry.utils.escapeHTML(target)}</strong>${text ? `: ${foundry.utils.escapeHTML(text)}` : ''}</div>`,
      speaker: { alias: 'LPC Intent' },
      whisper: ChatMessage.getWhisperRecipients('GM').map((u) => u.id),
    })

    ui.notifications?.info(`LPC intent from ${player}: ${verb} ${target}`)
    this.send({ type: 'ack', for: 'intent' })
  }

  findToken(tokenId, tokenName) {
    const tokens = canvas?.tokens?.placeables || []
    if (tokenId) {
      const byId = tokens.find((t) => t.id === tokenId || t.document?.id === tokenId)
      if (byId) return byId
    }
    if (tokenName) {
      const needle = String(tokenName).toLowerCase()
      const byName = tokens.find((t) => t.name?.toLowerCase() === needle)
      if (byName) return byName
    }
    // Fallback: controlled token, else first owned/player token, else first token
    const controlled = canvas?.tokens?.controlled?.[0]
    if (controlled) return controlled
    return tokens[0] || null
  }

  pushState() {
    const tokens = (canvas?.tokens?.placeables || []).map((t) => ({
      id: t.id,
      name: t.name,
      x: t.document.x,
      y: t.document.y,
      actorId: t.actor?.id || null,
    }))

    this.send({
      type: 'state',
      scene: canvas?.scene?.name || null,
      sceneId: canvas?.scene?.id || null,
      tokens,
      foundryConnected: true,
    })
  }
}

const bridge = new LpcBridge()

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'enabled', {
    name: 'Enable bridge',
    hint: 'GM client connects to the external WebSocket bridge when a world loads.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
    onChange: (enabled) => {
      if (enabled) bridge.connect()
      else bridge.disconnect()
    },
  })

  game.settings.register(MODULE_ID, 'bridgeUrl', {
    name: 'Bridge WebSocket URL',
    hint: 'Default ws://127.0.0.1:3847/ws — run `npm run bridge` in foundry-bridge.',
    scope: 'world',
    config: true,
    type: String,
    default: 'ws://127.0.0.1:3847/ws',
    onChange: () => {
      if (bridge.enabled) bridge.connect()
    },
  })
})

Hooks.once('ready', () => {
  if (!game.user.isGM) return

  // Sidebar button to reconnect / push state
  Hooks.on('getSceneControlButtons', (controls) => {
    // Foundry v13 may use object or array — support both lightly
    const tokenControls = Array.isArray(controls)
      ? controls.find((c) => c.name === 'token')
      : controls.tokens
    if (!tokenControls) return
    const tools = tokenControls.tools
    const tool = {
      name: 'lpc-bridge',
      title: 'LPC Bridge: reconnect + push state',
      icon: 'fas fa-plug',
      button: true,
      onClick: () => {
        bridge.connect()
        setTimeout(() => bridge.pushState(), 400)
      },
    }
    if (Array.isArray(tools)) tools.push(tool)
    else if (tools && typeof tools === 'object') tools['lpc-bridge'] = tool
  })

  bridge.connect()
  Hooks.on('canvasReady', () => bridge.pushState())
  Hooks.on('updateToken', () => bridge.pushState())
})

window.lpcBridge = bridge
