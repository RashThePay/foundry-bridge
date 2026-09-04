const MODULE_ID = 'lpc-bridge'

/**
 * Foundry side of the spike.
 * Player → Foundry: chat / move / intent
 * Foundry → players: live token state, scene, public chat, HP snapshots
 */
class LpcBridge {
  constructor() {
    this.ws = null
    this.reconnectTimer = null
    this.manualClose = false
    this.stateTimer = null
    this.suppressChatEcho = false
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
      this.schedulePushState(true)
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
    if (this.stateTimer) {
      clearTimeout(this.stateTimer)
      this.stateTimer = null
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

  /** Debounce rapid Foundry updates (token drag fires many times). */
  schedulePushState(immediate = false) {
    if (immediate) {
      if (this.stateTimer) {
        clearTimeout(this.stateTimer)
        this.stateTimer = null
      }
      this.pushState()
      return
    }
    if (this.stateTimer) return
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null
      this.pushState()
    }, 80)
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
        this.schedulePushState(true)
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
      case 'request-state':
        this.schedulePushState(true)
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

    this.suppressChatEcho = true
    try {
      await ChatMessage.create({
        content: text,
        speaker: { alias: `[LPC] ${speakerName}` },
        type: CONST.CHAT_MESSAGE_STYLES?.OTHER ?? CONST.CHAT_MESSAGE_TYPES?.OTHER ?? 0,
        flags: {
          [MODULE_ID]: { fromClient: true, speaker: speakerName },
        },
      })
    } finally {
      // Allow the createChatMessage hook to see the flag; clear on next tick.
      setTimeout(() => {
        this.suppressChatEcho = false
      }, 0)
    }

    // Client already got a local echo from the bridge; Foundry confirm is optional.
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

    const token = this.findToken(msg.tokenId, msg.tokenName, msg.player)
    if (!token) {
      this.send({
        type: 'error',
        message: 'No matching token on the current scene. Place a token or pass tokenName.',
      })
      ui.notifications?.warn('LPC Bridge: move failed — no token matched')
      return
    }

    await token.document.update({ x, y })
    // updateToken hook will push state to all clients
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
      flags: {
        [MODULE_ID]: { fromClient: true, intent: true },
      },
    })

    ui.notifications?.info(`LPC intent from ${player}: ${verb} ${target}`)
    this.send({ type: 'ack', for: 'intent' })
  }

  findToken(tokenId, tokenName, playerName) {
    const tokens = canvas?.tokens?.placeables || []
    if (tokenId) {
      const byId = tokens.find((t) => t.id === tokenId || t.document?.id === tokenId)
      if (byId) return byId
    }
    const nameCandidates = [tokenName, playerName].filter(Boolean).map((n) => String(n).toLowerCase())
    for (const needle of nameCandidates) {
      const byName = tokens.find((t) => t.name?.toLowerCase() === needle)
      if (byName) return byName
    }
    const controlled = canvas?.tokens?.controlled?.[0]
    if (controlled) return controlled
    return tokens[0] || null
  }

  tokenPayload(t) {
    const actor = t.actor
    const hp = actor?.system?.attributes?.hp
    return {
      id: t.id,
      name: t.name,
      x: t.document.x,
      y: t.document.y,
      actorId: actor?.id || null,
      hp: hp?.value ?? null,
      maxHp: hp?.max ?? null,
      hidden: !!t.document.hidden,
      disposition: t.document.disposition,
    }
  }

  pushState() {
    const tokens = (canvas?.tokens?.placeables || []).map((t) => this.tokenPayload(t))

    this.send({
      type: 'state',
      scene: canvas?.scene?.name || null,
      sceneId: canvas?.scene?.id || null,
      tokens,
      foundryConnected: true,
      at: Date.now(),
    })
  }

  /** Forward Foundry-originated public chat to external clients. */
  forwardFoundryChat(message) {
    if (!message) return
    if (message.getFlag?.(MODULE_ID, 'fromClient')) return
    if (message.whisper?.length) return // keep GM whispers private

    const speaker =
      message.speaker?.alias ||
      game.actors?.get(message.speaker?.actor)?.name ||
      game.users?.get(message.author?.id || message.user)?.name ||
      'Foundry'

    const text = this.plainText(message.content || '')
    if (!text) return

    this.send({
      type: 'chat',
      text,
      speaker,
      source: 'foundry',
      messageId: message.id,
    })
  }

  plainText(html) {
    const tmp = document.createElement('div')
    tmp.innerHTML = html
    return (tmp.textContent || tmp.innerText || '').replace(/\s+/g, ' ').trim()
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

  Hooks.on('getSceneControlButtons', (controls) => {
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

  // --- Foundry → clients ---
  Hooks.on('canvasReady', () => bridge.schedulePushState(true))
  Hooks.on('createToken', () => bridge.schedulePushState(true))
  Hooks.on('deleteToken', () => bridge.schedulePushState(true))
  Hooks.on('updateToken', () => bridge.schedulePushState(false))
  Hooks.on('updateActor', () => bridge.schedulePushState(false))

  Hooks.on('createChatMessage', (message) => {
    bridge.forwardFoundryChat(message)
  })
})

window.lpcBridge = bridge
