import { AssetRegistry, installAuthoring } from './authoring.mjs'

const MODULE_ID = 'lpc-bridge'
const PROTOCOL_VERSION = 1

const FACINGS = ['down', 'left', 'right', 'up']

const DEFAULT_WORLD_2D = Object.freeze({
  mapId: null,
  tilesetId: null,
  unitsPerGridSquare: 1,
  lighting: {},
  fog: {},
  camera: {},
})

const DEFAULT_ENTITY_2D = Object.freeze({
  spriteId: null,
  entityType: null,
  visible: true,
  selectable: true,
  facing: 'down',
  scale: { x: 1, y: 1 },
  interaction: {},
  controllers: [],
})

function migrateWorld2d(stored) {
  if (!stored) return {}
  const preset = stored.camera?.preset === 'isometric' ? 'top-down' : stored.camera?.preset
  return {
    mapId: stored.environmentId ?? stored.mapId ?? null,
    tilesetId: stored.tilesetId ?? null,
    unitsPerGridSquare: stored.unitsPerGridSquare ?? stored.worldUnitsPerGridSquare ?? 1,
    lighting: {
      preset: stored.lighting?.preset,
      ambient: stored.lighting?.ambient,
      color: stored.lighting?.color,
    },
    fog: stored.fog,
    camera: { preset: preset || 'follow' },
  }
}

function migrateEntity2d(stored) {
  if (!stored) return {}
  return {
    spriteId: stored.spriteId ?? stored.prefabId ?? null,
    entityType: stored.entityType,
    visible: stored.visible,
    selectable: stored.selectable,
    facing: FACINGS.includes(stored.facing) ? stored.facing : 'down',
    scale: { x: stored.scale?.x ?? 1, y: stored.scale?.y ?? 1 },
    interaction: stored.interaction,
    controllers: stored.controllers,
  }
}

function envelope(kind, type, payload = {}, extra = {}) {
  return { v: PROTOCOL_VERSION, kind, type, ...extra, payload }
}

function clone(value) {
  return value == null ? value : structuredClone(value)
}

function mergeDefaults(defaults, value) {
  const target = clone(defaults)
  for (const [key, next] of Object.entries(value || {})) {
    const current = target[key]
    const objects = current && next && typeof current === 'object' && typeof next === 'object'
      && !Array.isArray(current) && !Array.isArray(next)
    target[key] = objects ? mergeDefaults(current, next) : clone(next)
  }
  return target
}

class FoundryBridge {
  constructor(assetRegistry) {
    this.assetRegistry = assetRegistry
    this.ws = null
    this.reconnectTimer = null
    this.manualClose = false
    this.revision = 0
  }

  get enabled() {
    return game.settings.get(MODULE_ID, 'enabled')
  }

  get url() {
    return game.settings.get(MODULE_ID, 'bridgeUrl')
  }

  get roomId() {
    return game.settings.get(MODULE_ID, 'roomId') || 'default'
  }

  get accessKey() {
    return game.settings.get(MODULE_ID, 'accessKey') || ''
  }

  connect() {
    if (!this.enabled || !game.user?.isGM) return
    this.manualClose = false
    this.disconnect(false)

    try {
      this.ws = new WebSocket(this.url)
    } catch (error) {
      console.error(`${MODULE_ID} | WebSocket creation failed`, error)
      ui.notifications?.error('Foundry Bridge: invalid WebSocket URL')
      this.scheduleReconnect()
      return
    }

    this.ws.addEventListener('open', () => {
      this.send(envelope('hello', 'connection.hello', {
        role: 'foundry',
        roomId: this.roomId,
        name: game.user.name,
        accessKey: this.accessKey,
        capabilities: [
          'world.snapshot',
          'entity.events',
          'token.move',
          'chat.send',
          'intent.submit',
        ],
      }))
      ui.notifications?.info(`Foundry Bridge connected (${this.roomId})`)
    })
    this.ws.addEventListener('message', (event) => this.onMessage(event.data))
    this.ws.addEventListener('close', () => {
      this.ws = null
      if (!this.manualClose && this.enabled) this.scheduleReconnect()
    })
    this.ws.addEventListener('error', (error) => console.warn(`${MODULE_ID} | Socket error`, error))
  }

  disconnect(manual = true) {
    this.manualClose = manual
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.ws) this.ws.close()
    this.ws = null
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 2500)
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message))
  }

  respond(command, payload) {
    this.send(envelope('response', `${command.type}.result`, { ok: true, ...payload }, { replyTo: command.id }))
  }

  reject(command, code, message, details) {
    this.send(envelope('response', `${command.type}.result`, {
      ok: false,
      error: { code, message, ...(details ? { details } : {}) },
    }, { replyTo: command.id }))
  }

  emit(type, payload = {}) {
    this.send(envelope('event', type, { revision: ++this.revision, ...payload }))
  }

  async onMessage(raw) {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }

    if (message.kind !== 'command') {
      if (message.type === 'connection.ready') this.pushSnapshot()
      return
    }

    try {
      switch (message.type) {
        case 'world.getSnapshot':
          this.pushSnapshot()
          this.respond(message, { revision: this.revision })
          return
        case 'token.move':
          await this.handleTokenMove(message)
          return
        case 'chat.send':
          await this.handleChat(message)
          return
        case 'intent.submit':
          await this.handleIntent(message)
          return
        case 'connection.ping':
          this.respond(message, { pong: true, receivedAt: Date.now() })
          return
        default:
          this.reject(message, 'UNSUPPORTED_COMMAND', `Unsupported command: ${message.type}`)
      }
    } catch (error) {
      console.error(`${MODULE_ID} | Command failed`, message, error)
      this.reject(message, 'INTERNAL_ERROR', error?.message || 'The Foundry command failed.')
    }
  }

  activeScene() {
    return canvas?.scene || game.scenes?.active || null
  }

  world2d(scene) {
    const stored = scene?.getFlag(MODULE_ID, 'world2d') || scene?.getFlag(MODULE_ID, 'world3d')
    return mergeDefaults(DEFAULT_WORLD_2D, migrateWorld2d(stored))
  }

  entity2d(document) {
    const stored = document?.getFlag(MODULE_ID, 'entity2d') || document?.getFlag(MODULE_ID, 'entity3d')
    return mergeDefaults(DEFAULT_ENTITY_2D, migrateEntity2d(stored))
  }

  gridSize(scene) {
    return Number(scene?.grid?.size || scene?.grid?.sizeX || 100) || 100
  }

  worldUnits(scene) {
    return Number(this.world2d(scene).unitsPerGridSquare) || 1
  }

  canvasToWorld(scene, x, y) {
    const factor = this.worldUnits(scene) / this.gridSize(scene)
    return {
      x: Number(x || 0) * factor,
      y: Number(y || 0) * factor,
    }
  }

  worldToCanvas(scene, position) {
    const factor = this.gridSize(scene) / this.worldUnits(scene)
    const y = Number.isFinite(Number(position.y)) ? Number(position.y) : Number(position.z)
    return {
      x: Number(position.x) * factor,
      y: y * factor,
    }
  }

  tokenEntity(document) {
    const scene = document.parent
    const config = this.entity2d(document)
    const actor = document.actor
    const hp = actor?.system?.attributes?.hp
    return {
      id: `Token.${document.id}`,
      documentType: 'Token',
      documentId: document.id,
      entityType: config.entityType || (actor ? 'actor' : 'token'),
      name: document.name,
      spriteId: config.spriteId,
      transform: {
        position: this.canvasToWorld(scene, document.x, document.y),
        facing: config.facing,
        scale: config.scale,
      },
      visible: config.visible !== false && !document.hidden,
      selectable: config.selectable !== false,
      interaction: config.interaction,
      disposition: document.disposition,
      actor: actor ? {
        id: actor.id,
        hp: hp?.value ?? null,
        maxHp: hp?.max ?? null,
      } : null,
    }
  }

  tileEntity(document) {
    const scene = document.parent
    const config = this.entity2d(document)
    if (!config.spriteId) return null
    return {
      id: `Tile.${document.id}`,
      documentType: 'Tile',
      documentId: document.id,
      entityType: config.entityType || 'prop',
      name: document.texture?.src?.split('/').pop() || 'World object',
      spriteId: config.spriteId,
      transform: {
        position: this.canvasToWorld(scene, document.x, document.y),
        facing: config.facing,
        scale: config.scale,
      },
      visible: config.visible !== false && !document.hidden,
      selectable: config.selectable !== false,
      interaction: config.interaction,
    }
  }

  documentEntity(document) {
    if (document?.documentName === 'Token') return this.tokenEntity(document)
    if (document?.documentName === 'Tile') return this.tileEntity(document)
    return null
  }

  snapshot() {
    const scene = this.activeScene()
    const map = this.world2d(scene)
    const entities = scene
      ? [
          ...scene.tokens.map((document) => this.tokenEntity(document)),
          ...scene.tiles.map((document) => this.tileEntity(document)).filter(Boolean),
        ]
      : []
    return {
      revision: ++this.revision,
      generatedAt: Date.now(),
      world: {
        id: game.world?.id || null,
        title: game.world?.title || null,
        system: game.system?.id || null,
        systemVersion: game.system?.version || null,
      },
      scene: scene ? {
        id: scene.id,
        name: scene.name,
        active: !!scene.active,
        dimensions: {
          width: scene.width / this.gridSize(scene) * this.worldUnits(scene),
          height: scene.height / this.gridSize(scene) * this.worldUnits(scene),
          gridSize: this.gridSize(scene),
        },
        map,
      } : null,
      entities,
      assets: this.assetRegistry.snapshot(),
    }
  }

  pushSnapshot() {
    this.send(envelope('event', 'world.snapshot', this.snapshot()))
  }

  canControl(document, source) {
    const controllers = this.entity2d(document).controllers || []
    if (!controllers.length) return true
    return controllers.includes(source?.connectionId) || controllers.includes(source?.name)
  }

  async handleTokenMove(command) {
    const { tokenId, destination } = command.payload || {}
    const x = Number(destination?.x)
    const y = Number.isFinite(Number(destination?.y)) ? Number(destination.y) : Number(destination?.z)
    if (!tokenId || !destination || ![x, y].every(Number.isFinite)) {
      this.reject(command, 'INVALID_ARGUMENT', 'tokenId and finite destination.x/destination.y are required.')
      return
    }
    const scene = this.activeScene()
    const document = scene?.tokens?.get(tokenId)
    if (!document) {
      this.reject(command, 'TOKEN_NOT_FOUND', `Token ${tokenId} is not in the active scene.`)
      return
    }
    if (!this.canControl(document, command.source)) {
      this.reject(command, 'PERMISSION_DENIED', 'This client may not control that token.')
      return
    }
    const resolved = { x, y }
    await document.update(this.worldToCanvas(scene, resolved))
    this.respond(command, { tokenId, destination: resolved })
  }

  async handleChat(command) {
    const text = String(command.payload?.text || '').trim()
    if (!text) {
      this.reject(command, 'INVALID_ARGUMENT', 'Chat text is required.')
      return
    }
    const speaker = String(command.source?.name || 'Player').slice(0, 60)
    const created = await ChatMessage.create({
      content: foundry.utils.escapeHTML(text),
      speaker: { alias: `[Bridge] ${speaker}` },
      style: CONST.CHAT_MESSAGE_STYLES.OTHER,
      flags: { [MODULE_ID]: { fromClient: true, connectionId: command.source?.connectionId } },
    })
    this.respond(command, { messageId: created?.id || null })
  }

  async handleIntent(command) {
    const payload = command.payload || {}
    const text = String(payload.text || '').trim()
    if (!text) {
      this.reject(command, 'INVALID_ARGUMENT', 'Intent text is required.')
      return
    }
    const player = foundry.utils.escapeHTML(command.source?.name || 'Player')
    const verb = foundry.utils.escapeHTML(payload.verb || 'do something')
    const target = foundry.utils.escapeHTML(payload.targetEntityId || 'the world')
    const created = await ChatMessage.create({
      content: `<div class="lpc-intent"><strong>${player}</strong> wants to <em>${verb}</em> <strong>${target}</strong>: ${foundry.utils.escapeHTML(text)}</div>`,
      speaker: { alias: 'Player Intent' },
      style: CONST.CHAT_MESSAGE_STYLES.OTHER,
      whisper: ChatMessage.getWhisperRecipients('GM').map((user) => user.id),
      flags: { [MODULE_ID]: { fromClient: true, intent: true, payload: clone(payload) } },
    })
    ui.notifications?.info(`Intent from ${command.source?.name || 'Player'}`)
    this.respond(command, { messageId: created?.id || null })
  }

  onDocumentCreated(document) {
    const entity = this.documentEntity(document)
    if (entity && document.parent?.id === this.activeScene()?.id) this.emit('entity.created', { entity })
  }

  onDocumentUpdated(document, changes) {
    const entity = this.documentEntity(document)
    if (entity && document.parent?.id === this.activeScene()?.id) this.emit('entity.updated', { entity, changes })
  }

  onDocumentDeleted(document) {
    if (document.parent?.id !== this.activeScene()?.id) return
    this.emit('entity.deleted', { entityId: `${document.documentName}.${document.id}` })
  }

  onActorUpdated(actor, changes) {
    const scene = this.activeScene()
    if (!scene) return
    const tokenIds = scene.tokens.filter((token) => token.actorId === actor.id).map((token) => token.id)
    if (tokenIds.length) this.emit('actor.updated', {
      actorId: actor.id,
      tokenIds,
      changes,
      hp: actor.system?.attributes?.hp?.value ?? null,
      maxHp: actor.system?.attributes?.hp?.max ?? null,
    })
  }

  forwardFoundryChat(message) {
    if (!message || message.getFlag?.(MODULE_ID, 'fromClient') || message.whisper?.length) return
    const container = document.createElement('div')
    container.innerHTML = message.content || ''
    const text = (container.textContent || '').replace(/\s+/g, ' ').trim()
    if (!text) return
    const speaker = message.speaker?.alias || message.author?.name || game.users?.get(message.author)?.name || 'Foundry'
    this.send(envelope('event', 'chat.message', {
      messageId: message.id,
      speaker,
      text,
      createdAt: Date.now(),
    }))
  }
}

const assetRegistry = new AssetRegistry()
const bridge = new FoundryBridge(assetRegistry)

Hooks.once('init', () => {
  assetRegistry.registerSetting()
  const reconnect = () => bridge.enabled && bridge.connect()
  game.settings.register(MODULE_ID, 'enabled', {
    name: 'Enable bridge',
    hint: 'Connect the active GM client to the external game gateway.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
    onChange: (enabled) => enabled ? bridge.connect() : bridge.disconnect(),
  })
  game.settings.register(MODULE_ID, 'bridgeUrl', {
    name: 'Bridge WebSocket URL',
    scope: 'world',
    config: true,
    type: String,
    default: 'ws://127.0.0.1:3847/ws',
    onChange: reconnect,
  })
  game.settings.register(MODULE_ID, 'roomId', {
    name: 'Bridge room ID',
    hint: 'Letters, numbers, hyphens, and underscores only.',
    scope: 'world',
    config: true,
    type: String,
    default: 'default',
    onChange: reconnect,
  })
  game.settings.register(MODULE_ID, 'accessKey', {
    name: 'Bridge access key',
    hint: 'Must match BRIDGE_SECRET when the gateway is protected.',
    scope: 'world',
    config: true,
    type: String,
    default: '',
    onChange: reconnect,
  })
})

Hooks.once('ready', () => {
  if (!game.user?.isGM) return
  bridge.connect()
  installAuthoring(bridge, assetRegistry)

  Hooks.on('canvasReady', () => bridge.pushSnapshot())
  Hooks.on('createToken', (document) => bridge.onDocumentCreated(document))
  Hooks.on('updateToken', (document, changes) => bridge.onDocumentUpdated(document, changes))
  Hooks.on('deleteToken', (document) => bridge.onDocumentDeleted(document))
  Hooks.on('createTile', (document) => bridge.onDocumentCreated(document))
  Hooks.on('updateTile', (document, changes) => bridge.onDocumentUpdated(document, changes))
  Hooks.on('deleteTile', (document) => bridge.onDocumentDeleted(document))
  Hooks.on('updateActor', (actor, changes) => bridge.onActorUpdated(actor, changes))
  Hooks.on('updateScene', (scene, changes) => {
    if (scene.id === bridge.activeScene()?.id) bridge.emit('scene.updated', { sceneId: scene.id, changes })
  })
  Hooks.on('createChatMessage', (message) => bridge.forwardFoundryChat(message))

})

window.foundryBridge = bridge
