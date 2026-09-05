import { handleActionPreflight, handleActionUse, handleInitiative, buildActorSheet, extractRolls, installBridgeChatNotificationFilter } from './actions.mjs'
import { AssetGateway } from './assets.mjs'
import { AssetRegistry, installAuthoring, refreshSceneControls } from './authoring.mjs'
import { forwardFoundryChat, handleChat, handleIntent, partyConnectionIds } from './chat.mjs'
import { installGmPanel } from './gm-panel.mjs'
import {
  DEFAULT_ENTITY_2D,
  DEFAULT_WORLD_2D,
  MODULE_ID,
  claimantOf,
  envelope,
  facingFromDelta,
  isPlayableToken,
  mergeDefaults,
  migrateEntity2d,
  migrateWorld2d,
  sceneBackgroundSrc,
  serializeCombat,
  serializeWall,
  movementAnimationSpeed,
  tileTextureSrc,
  tokenDisplayName,
  tokenTextureSrc,
} from './snapshot.mjs'

const REVISIONED_EVENTS = new Set([
  'token.moved', 'entity.created', 'entity.updated', 'entity.deleted',
  'wall.updated', 'wall.deleted', 'scene.updated', 'scene.activated',
  'actor.updated', 'combat.updated',
])

class FoundryBridge {
  constructor(assetRegistry) {
    this.assetRegistry = assetRegistry
    this.assets = new AssetGateway()
    this.ws = null
    this.reconnectTimer = null
    this.manualClose = false
    this.revision = 0
    this.clients = new Map()
    this.intents = new Map()
    this.npcThreads = new Map()
    this.gmPanel = null
    this.keepAliveWorker = null
    this.pendingMovementTokens = new Set()
    this.resolutions = []
  }

  get enabled() {
    return game.settings.get(MODULE_ID, 'enabled')
  }

  get url() {
    return game.settings.get(MODULE_ID, 'bridgeUrl')
  }

  get roomId() {
    return game.settings.get(MODULE_ID, 'campaignId') || 'default'
  }

  get accessKey() {
    return game.settings.get(MODULE_ID, 'foundryCredential') || ''
  }

  gatewayHttp() {
    return String(this.url || '').replace(/^ws/i, 'http').replace(/\/ws\/?$/, '')
  }

  async api(path, { method = 'GET', credential = this.accessKey, body } = {}) {
    const response = await fetch(`${this.gatewayHttp()}${path}`, {
      method,
      headers: { authorization: `Bearer ${credential}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error?.message || `Bridge request failed (${response.status})`)
    return result
  }

  async createCampaign(ownerCredential) {
    const result = await this.api('/api/v2/campaigns', { method: 'POST', credential: ownerCredential, body: { name: game.world.title, worldId: game.world.id } })
    await game.settings.set(MODULE_ID, 'campaignId', result.campaignId)
    await game.settings.set(MODULE_ID, 'foundryCredential', result.foundryCredential)
    await game.settings.set(MODULE_ID, 'inviteUrl', result.inviteUrl)
    this.connect()
    return result
  }

  async setCharacterPin(token, pin) {
    if (!token?.actor) throw new Error('Select a token with an actor.')
    return this.api(`/api/v2/campaigns/${encodeURIComponent(this.roomId)}/characters`, { method: 'PUT', body: { actorId: token.actor.id, tokenId: token.id, name: token.name || token.actor.name, pin } })
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
        campaignId: this.roomId,
        credential: this.accessKey,
        capabilities: [
          'world.snapshot',
          'entity.events',
          'token.move',
          'door.toggle',
          'actor.claim',
          'chat.send',
          'intent.submit',
          'action.use',
          'combat.updated',
        ],
      }))
      ui.notifications?.info(`Foundry Bridge connected (${this.roomId})`)
      this.startKeepAlive()
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
    this.stopKeepAlive()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.ws) this.ws.close()
    this.ws = null
  }

  startKeepAlive() {
    this.stopKeepAlive()
    try {
      const blob = new Blob(['setInterval(() => postMessage(1), 200)'], { type: 'text/javascript' })
      const url = URL.createObjectURL(blob)
      this.keepAliveWorker = new Worker(url)
      this.keepAliveWorker.onmessage = () => {}
      this.keepAliveUrl = url
    } catch (error) {
      console.warn(`${MODULE_ID} | keep-alive worker unavailable`, error)
    }
  }

  stopKeepAlive() {
    if (this.keepAliveWorker) {
      this.keepAliveWorker.terminate()
      this.keepAliveWorker = null
    }
    if (this.keepAliveUrl) {
      URL.revokeObjectURL(this.keepAliveUrl)
      this.keepAliveUrl = null
    }
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

  emit(type, payload = {}, extra = {}) {
    const versionedPayload = REVISIONED_EVENTS.has(type)
      ? { revision: ++this.revision, ...payload }
      : payload
    this.send(envelope('event', type, versionedPayload, extra))
  }

  threadFor(entityId, connectionId = null) {
    const id = entityId || 'world'
    const key = `${id}::${connectionId || 'public'}`
    if (!this.npcThreads.has(key)) this.npcThreads.set(key, {
      key,
      entityId: id,
      connectionId,
      playerName: connectionId ? this.clients.get(connectionId)?.characterName || this.clients.get(connectionId)?.name || 'Player' : null,
      messages: [],
    })
    return this.npcThreads.get(key)
  }

  recordResolution(data) {
    if (!data?.activity) return null
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const deltas = data.usage?.message?.system?.deltas || data.usage?.message?.data?.system?.deltas || null
    const actors = (data.actors || []).filter((state) => state?.after
      && (state.hp !== state.after.hp || state.tempHp !== state.after.tempHp || state.tempMax !== state.after.tempMax))
    if (!actors.length && !deltas) return null
    const resolution = {
      id,
      label: data.label || 'Remote action',
      createdAt: Date.now(),
      undoneAt: null,
      activity: data.activity,
      deltas,
      actors,
      applied: data.applied || [],
      saves: data.saves || [],
    }
    this.resolutions.unshift(resolution)
    this.resolutions = this.resolutions.slice(0, 12)
    this.gmPanel?.render?.({ force: true })
    return resolution
  }

  async undoResolution(id) {
    const resolution = this.resolutions.find((entry) => entry.id === id)
    if (!resolution || resolution.undoneAt) throw new Error('That resolution is no longer available to undo.')
    for (const state of resolution.actors) {
      const hp = state.actor?.system?.attributes?.hp
      if (!hp || Number(hp.value) !== state.after.hp || Number(hp.temp || 0) !== state.after.tempHp) {
        throw new Error(`${state.actorName}'s HP changed after this action. Undo was stopped to avoid overwriting newer play.`)
      }
    }
    if (resolution.deltas && resolution.activity?.refund) await resolution.activity.refund(resolution.deltas)
    for (const state of resolution.actors) {
      await state.actor.update({
        'system.attributes.hp.value': state.hp,
        'system.attributes.hp.temp': state.tempHp,
        'system.attributes.hp.tempmax': state.tempMax,
      })
    }
    resolution.undoneAt = Date.now()
    this.emit('action.undone', {
      resolutionId: resolution.id,
      label: resolution.label,
      createdAt: resolution.undoneAt,
    }, { audience: { connectionIds: partyConnectionIds(this) } })
    this.gmPanel?.render?.({ force: true })
    return resolution
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
      if (message.type === 'client.connected') this.onClientConnected(message.payload || {})
      if (message.type === 'client.disconnected') this.onClientDisconnected(message.payload || {})
      return
    }

    try {
      switch (message.type) {
        case 'world.snapshot.request':
          await this.pushSnapshot()
          this.respond(message, { revision: this.revision })
          return
        case 'actor.claim':
          await this.handleClaim(message)
          return
        case 'actor.release':
          await this.handleRelease(message)
          return
        case 'movement.request':
          await this.handleTokenMove(message)
          return
        case 'door.toggle':
          await this.handleDoorToggle(message)
          return
        case 'chat.send':
          await handleChat(this, message)
          return
        case 'intent.submit':
          await handleIntent(this, message)
          return
        case 'action.execute':
          await handleActionUse(this, message)
          return
        case 'action.preflight':
          await handleActionPreflight(this, message)
          return
        case 'combat.rollInitiative':
          await handleInitiative(this, message)
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

  onClientConnected(payload) {
    const connectionId = payload.connectionId
    if (!connectionId) return
    this.clients.set(connectionId, {
      name: payload.name || 'Player',
      role: payload.role || 'player',
      claimedTokenId: payload.tokenId || null,
      actorId: payload.actorId || null,
      characterName: payload.name || null,
    })
    const restored = this.activeScene()?.tokens?.get(payload.tokenId) || this.findRestorableToken(payload)
    if (restored) this.claimToken(connectionId, restored, { reconnect: true }).catch((error) => {
      console.warn(`${MODULE_ID} | reconnect claim failed`, error)
    })
    this.gmPanel?.render?.({ force: true })
  }

  onClientDisconnected(payload) {
    const client = this.clients.get(payload.connectionId)
    if (client?.claimedTokenId) {
      const token = this.activeScene()?.tokens?.get(client.claimedTokenId)
      if (token) {
        const config = this.entity2d(token)
        token.setFlag(MODULE_ID, 'entity2d', {
          ...config,
          controllers: [client.name].filter(Boolean),
        }).catch(() => null)
      }
    }
    this.clients.delete(payload.connectionId)
    this.gmPanel?.render?.({ force: true })
  }

  findRestorableToken(payload) {
    const scene = this.activeScene()
    if (!scene) return null
    if (payload.claimedTokenId) {
      const token = scene.tokens.get(payload.claimedTokenId)
      if (token && this.isAvailableFor(token, payload)) return token
    }
    return [...scene.tokens].find((token) => {
      const config = this.entity2d(token)
      return (config.controllers || []).includes(payload.name) && this.isAvailableFor(token, payload)
    }) || null
  }

  isAvailableFor(token, payload) {
    for (const [id, client] of this.clients) {
      if (id !== payload.connectionId && client.claimedTokenId === token.id) return false
    }
    return isPlayableToken(token, this.entity2d(token))
  }

  activeScene() {
    return canvas?.scene || game.scenes?.active || null
  }

  world2d(scene) {
    const stored = scene?.getFlag(MODULE_ID, 'world2d')
    return mergeDefaults(DEFAULT_WORLD_2D, migrateWorld2d(stored))
  }

  entity2d(document) {
    const stored = document?.getFlag(MODULE_ID, 'entity2d')
      || document?.actor?.prototypeToken?.getFlag?.(MODULE_ID, 'entity2d')
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
    const conditions = [...(actor?.statuses || [])].map((status) => String(status))
    if (!conditions.length && actor?.effects) {
      for (const effect of actor.effects) {
        if (!effect.disabled && effect.name) conditions.push(effect.name)
      }
    }
    const claim = claimantOf(document, config, this.clients)
    return {
      id: `Token.${document.id}`,
      documentType: 'Token',
      documentId: document.id,
      entityType: config.entityType || (actor?.type === 'npc' ? 'npc' : actor ? 'actor' : 'token'),
      name: document.name,
      spriteId: config.spriteId,
      textureUrl: tokenTextureSrc(document),
      transform: {
        position: this.canvasToWorld(scene, document.x, document.y),
        facing: config.facing,
        scale: config.scale,
        width: Math.max(0.25, Number(document.width) || 1) * this.worldUnits(scene),
        height: Math.max(0.25, Number(document.height) || 1) * this.worldUnits(scene),
      },
      visible: config.visible !== false && !document.hidden,
      selectable: config.selectable !== false,
      interaction: config.interaction,
      disposition: document.disposition,
      claimable: isPlayableToken(document, config),
      ...claim,
      actor: actor ? {
        id: actor.id,
        type: actor.type,
        hp: hp?.value ?? null,
        maxHp: hp?.max ?? null,
        tempHp: hp?.temp ?? 0,
        conditions,
        dead: conditions.includes('dead') || Number(hp?.value) <= 0,
      } : null,
    }
  }

  tileEntity(document) {
    const scene = document.parent
    const config = this.entity2d(document)
    const textureUrl = tileTextureSrc(document)
    if (!config.spriteId && !textureUrl) return null
    const grid = this.gridSize(scene)
    return {
      id: `Tile.${document.id}`,
      documentType: 'Tile',
      documentId: document.id,
      entityType: config.entityType || 'prop',
      name: textureUrl?.split('/').pop() || 'World object',
      spriteId: config.spriteId,
      textureUrl,
      transform: {
        position: this.canvasToWorld(scene, document.x, document.y),
        facing: config.facing,
        scale: config.scale,
        width: Number(document.width || grid) / grid * this.worldUnits(scene),
        height: Number(document.height || grid) / grid * this.worldUnits(scene),
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

  playableCharacters(scene) {
    if (!scene) return []
    return [...scene.tokens]
      .filter((document) => isPlayableToken(document, this.entity2d(document)))
      .map((document) => {
        const config = this.entity2d(document)
        const claim = claimantOf(document, config, this.clients)
        return {
          tokenId: document.id,
          actorId: document.actorId || document.actor?.id || null,
          name: document.name,
          textureUrl: tokenTextureSrc(document),
          ...claim,
        }
      })
  }

  combatState() {
    return serializeCombat()
  }

  snapshot() {
    const scene = this.activeScene()
    const map = this.world2d(scene)
    const toWorld = (x, y) => this.canvasToWorld(scene, x, y)
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
        map: {
          ...map,
          backgroundUrl: sceneBackgroundSrc(scene),
        },
        // Foundry owns collision. The client receives only doors it can
        // interact with, never the scene's wall mesh.
        walls: [...(scene.walls || [])]
          .filter((wall) => {
            const kind = Number(wall.door || 0)
            const normal = CONST?.WALL_DOOR_TYPES?.DOOR ?? 1
            const secret = CONST?.WALL_DOOR_TYPES?.SECRET ?? 2
            const open = CONST?.WALL_DOOR_STATES?.OPEN ?? 1
            return kind === normal || (kind === secret && wall.ds === open)
          })
          .map((wall) => serializeWall(wall, toWorld)),
      } : null,
      combat: this.combatState(),
      playableCharacters: this.playableCharacters(scene),
      entities,
      assets: this.assetRegistry.snapshot(),
    }
  }

  async pushSnapshot() {
    const payload = this.snapshot()
    await this.assets.rewriteSnapshot(this, payload)
    this.send(envelope('event', 'world.snapshot', payload))
  }

  pushCombat() {
    this.emit('combat.updated', this.combatState())
    this.gmPanel?.render?.({ force: true })
  }

  async pushActorSheet(token, connectionId) {
    const sheet = buildActorSheet(token?.actor, token)
    if (!sheet) return
    await this.assets.rewriteActorSheet(this, sheet)
    const extra = connectionId ? { audience: { connectionIds: [connectionId] } } : {}
    this.emit('actor.sheet', { tokenId: token.id, sheet }, extra)
  }

  canControl(document, source) {
    const client = this.clients.get(source?.connectionId)
    if (client?.claimedTokenId === document.id) return true
    const controllers = this.entity2d(document).controllers || []
    return controllers.includes(source?.connectionId) || controllers.includes(source?.name)
  }

  async claimToken(connectionId, token, { reconnect = false } = {}) {
    const client = this.clients.get(connectionId)
    if (!client) return
    if (client.claimedTokenId && client.claimedTokenId !== token.id) {
      await this.releaseConnection(connectionId, { silent: true })
    }
    const config = this.entity2d(token)
    await token.setFlag(MODULE_ID, 'entity2d', {
      ...config,
      controllers: [connectionId, client.name].filter(Boolean),
    })
    client.claimedTokenId = token.id
    client.characterName = tokenDisplayName(token)
    this.emit('entity.updated', { entity: this.tokenEntity(token) })
    await this.pushActorSheet(token, connectionId)
    this.gmPanel?.render?.({ force: true })
    if (!reconnect) ui.notifications?.info(`${client.characterName} is in play`)
  }

  async handleClaim(command) {
    const tokenId = command.payload?.tokenId
    const scene = this.activeScene()
    const token = scene?.tokens?.get(tokenId)
    if (!token) {
      this.reject(command, 'TOKEN_NOT_FOUND', `Token ${tokenId} is not in the active scene.`)
      return
    }
    if (!isPlayableToken(token, this.entity2d(token))) {
      this.reject(command, 'PERMISSION_DENIED', 'That token is not a playable character.')
      return
    }
    if (!this.isAvailableFor(token, command.source || {})) {
      this.reject(command, 'PERMISSION_DENIED', 'That character is already claimed.')
      return
    }
    this.clients.set(command.source.connectionId, {
      name: command.source.name,
      role: command.source.role || 'player',
      claimedTokenId: this.clients.get(command.source.connectionId)?.claimedTokenId || null,
      characterName: this.clients.get(command.source.connectionId)?.characterName || null,
    })
    await this.claimToken(command.source.connectionId, token)
    this.respond(command, { tokenId, actorId: token.actorId || token.actor?.id || null })
  }

  async releaseConnection(connectionId, { silent = false } = {}) {
    const client = this.clients.get(connectionId)
    if (!client?.claimedTokenId) return
    const token = this.activeScene()?.tokens?.get(client.claimedTokenId)
    client.claimedTokenId = null
    client.characterName = null
    if (token) {
      const config = this.entity2d(token)
      await token.setFlag(MODULE_ID, 'entity2d', { ...config, controllers: [] })
      this.emit('entity.updated', { entity: this.tokenEntity(token) })
    }
    if (!silent) this.gmPanel?.render?.({ force: true })
  }

  async handleRelease(command) {
    await this.releaseConnection(command.source?.connectionId)
    this.respond(command, { ok: true })
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
    if (document.locked) {
      this.reject(command, 'TOKEN_LOCKED', 'That token is locked in Foundry.')
      return
    }
    if (this.pendingMovementTokens.has(tokenId)) {
      this.reject(command, 'MOVEMENT_BUSY', 'That character is already moving.')
      return
    }

    const placeable = document.object || canvas.tokens?.get(tokenId)
    if (!placeable?.findMovementPath || typeof document.move !== 'function') {
      this.reject(command, 'MOVEMENT_UNAVAILABLE', 'Foundry movement is not ready for that token.')
      return
    }

    const requested = this.worldToCanvas(scene, { x, y })
    const snapped = document.getSnappedPosition?.(requested) || requested
    const origin = { x: Number(document.x), y: Number(document.y) }
    if (Math.hypot(snapped.x - origin.x, snapped.y - origin.y) < 0.5) {
      this.reject(command, 'ALREADY_THERE', 'The character is already there.')
      return
    }

    const job = placeable.findMovementPath([
      { ...origin, explicit: true },
      { x: snapped.x, y: snapped.y, explicit: true },
    ], {
      constrainOptions: { ignoreWalls: false, ignoreCost: false },
      delay: 0,
    })
    const foundryPath = await job.promise
    const reached = foundryPath?.at(-1)
    if (!foundryPath || foundryPath.length < 2 || !reached
      || Math.hypot(Number(reached.x) - snapped.x, Number(reached.y) - snapped.y) > 1) {
      this.reject(command, 'PATH_BLOCKED', 'Foundry could not find an unobstructed path to that point.')
      return
    }

    this.pendingMovementTokens.add(tokenId)
    let completed = false
    try {
      completed = await document.move(foundryPath.slice(1), {
        animate: false,
        pan: false,
        showRuler: false,
        constrainOptions: { ignoreWalls: false, ignoreCost: false },
      })
    } finally {
      this.pendingMovementTokens.delete(tokenId)
    }
    if (!completed) {
      await this.onDocumentUpdated(document, { x: document.x, y: document.y })
      this.reject(command, 'MOVEMENT_REJECTED', 'Foundry prevented or interrupted that movement.')
      return
    }

    const worldPath = []
    let previous = origin
    for (const point of foundryPath.slice(1)) {
      if (![Number(point.x), Number(point.y)].every(Number.isFinite)) continue
      const facing = facingFromDelta(Number(point.x) - previous.x, Number(point.y) - previous.y)
      worldPath.push({ ...this.canvasToWorld(scene, point.x, point.y), facing })
      previous = { x: Number(point.x), y: Number(point.y) }
    }
    const authoritativeDestination = this.canvasToWorld(scene, document.x, document.y)
    const last = worldPath.at(-1)
    const facing = last?.facing || this.entity2d(document).facing
    if (!last || Math.hypot(last.x - authoritativeDestination.x, last.y - authoritativeDestination.y) > 0.001) {
      worldPath.push({ ...authoritativeDestination, facing })
    }
    const movementSpeed = movementAnimationSpeed({
      movement: document.actor?.system?.attributes?.movement,
      gridDistance: scene.grid?.distance,
      roundSeconds: CONFIG?.time?.roundTime || 6,
      worldUnits: this.worldUnits(scene),
    })
    this.emit('token.moved', { tokenId, path: worldPath, destination: authoritativeDestination, facing, movementSpeed })
    const config = this.entity2d(document)
    await document.setFlag(MODULE_ID, 'entity2d', { ...config, facing })
    this.respond(command, { tokenId, path: worldPath, destination: authoritativeDestination, facing, movementSpeed })
  }

  async handleDoorToggle(command) {
    const wallId = command.payload?.wallId
    const scene = this.activeScene()
    const wall = scene?.walls?.get(wallId)
    if (!wall) {
      this.reject(command, 'WALL_NOT_FOUND', `Wall ${wallId} is not in the active scene.`)
      return
    }
    const kind = Number(wall.door || 0)
    if (kind === (CONST?.WALL_DOOR_TYPES?.NONE ?? 0)) {
      this.reject(command, 'NOT_A_DOOR', 'That wall is not a door.')
      return
    }
    if (kind === (CONST?.WALL_DOOR_TYPES?.SECRET ?? 2) && wall.ds === (CONST?.WALL_DOOR_STATES?.CLOSED ?? 0)) {
      this.reject(command, 'PERMISSION_DENIED', 'That door cannot be used.')
      return
    }
    if (wall.ds === (CONST?.WALL_DOOR_STATES?.LOCKED ?? 2)) {
      this.reject(command, 'PERMISSION_DENIED', 'That door is locked.')
      return
    }
    const client = this.clients.get(command.source?.connectionId)
    if (!client?.claimedTokenId) {
      this.reject(command, 'PERMISSION_DENIED', 'Claim a character before interacting with doors.')
      return
    }
    const closed = CONST?.WALL_DOOR_STATES?.CLOSED ?? 0
    const open = CONST?.WALL_DOOR_STATES?.OPEN ?? 1
    const next = wall.ds === open ? closed : open
    await wall.update({ ds: next }, { animate: false, diff: false })
    this.respond(command, { wallId, doorState: next === open ? 'open' : 'closed' })
  }

  async onDocumentCreated(document) {
    const entity = this.documentEntity(document)
    if (entity && document.parent?.id === this.activeScene()?.id) {
      await this.assets.rewriteEntity(this, entity)
      this.emit('entity.created', { entity })
    }
  }

  async onDocumentUpdated(document, changes) {
    if (document?.documentName === 'Token' && this.pendingMovementTokens.has(document.id)
      && ('x' in (changes || {}) || 'y' in (changes || {}))) return
    const entity = this.documentEntity(document)
    if (entity && document.parent?.id === this.activeScene()?.id) {
      await this.assets.rewriteEntity(this, entity)
      this.emit('entity.updated', { entity, changes })
    }
  }

  onDocumentDeleted(document) {
    if (document.parent?.id !== this.activeScene()?.id) return
    this.emit('entity.deleted', { entityId: `${document.documentName}.${document.id}` })
  }

  onWallChanged(document) {
    if (document.parent?.id !== this.activeScene()?.id) return
    const kind = Number(document.door || 0)
    const normal = CONST?.WALL_DOOR_TYPES?.DOOR ?? 1
    const secret = CONST?.WALL_DOOR_TYPES?.SECRET ?? 2
    const open = CONST?.WALL_DOOR_STATES?.OPEN ?? 1
    if (kind !== normal && !(kind === secret && document.ds === open)) {
      this.emit('wall.deleted', { wallId: document.id })
      return
    }
    const wall = serializeWall(document, (x, y) => this.canvasToWorld(document.parent, x, y))
    this.emit('wall.updated', { wall })
  }

  onWallDeleted(document) {
    if (document.parent?.id !== this.activeScene()?.id) return
    this.emit('wall.deleted', { wallId: document.id })
  }

  onActorUpdated(actor, changes) {
    const scene = this.activeScene()
    if (!scene) return
    const tokens = scene.tokens.filter((token) => token.actorId === actor.id)
    const tokenIds = tokens.map((token) => token.id)
    const hp = actor.system?.attributes?.hp
    const conditions = [...(actor.statuses || [])].map((status) => String(status))
    if (!conditions.length && actor.effects) {
      for (const effect of actor.effects) {
        if (!effect.disabled && effect.name) conditions.push(effect.name)
      }
    }
    if (tokenIds.length) this.emit('actor.updated', {
      actorId: actor.id,
      tokenIds,
      hp: hp?.value ?? null,
      maxHp: hp?.max ?? null,
      tempHp: hp?.temp ?? 0,
      conditions,
      dead: conditions.includes('dead') || Number(hp?.value) <= 0,
    })
    for (const token of tokens) {
      const owner = [...this.clients.entries()].find(([, client]) => client.claimedTokenId === token.id)
      if (owner) void this.pushActorSheet(token, owner[0])
    }
  }

  onActorContentUpdated(document) {
    const parent = document?.parent
    const actor = parent?.documentName === 'Actor' ? parent : parent?.actor
    if (actor) this.onActorUpdated(actor, {})
  }

  forwardChat(message) {
    forwardFoundryChat(this, message)
    const rolls = extractRolls(message)
    if (rolls && message.getFlag?.(MODULE_ID, 'fromClient')) {
      const channel = message.getFlag(MODULE_ID, 'channel') === 'private' ? 'private' : 'party'
      const connectionId = message.getFlag(MODULE_ID, 'connectionId')
      const connectionIds = channel === 'private'
        ? [connectionId].filter(Boolean)
        : partyConnectionIds(this)
      this.emit('roll.result', {
        messageId: message.id,
        channel,
        speaker: message.speaker?.alias || 'Someone',
        ...rolls,
        targetIds: [],
      }, { audience: { connectionIds } })
    }
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
  game.settings.register(MODULE_ID, 'campaignId', {
    name: 'Bridge campaign ID',
    hint: 'Created by the remote bridge service.',
    scope: 'world',
    config: true,
    type: String,
    default: 'default',
    onChange: reconnect,
  })
  game.settings.register(MODULE_ID, 'foundryCredential', {
    name: 'Foundry campaign credential',
    hint: 'Private credential returned when this campaign is created.',
    scope: 'world',
    config: true,
    type: String,
    default: '',
    onChange: reconnect,
  })
  game.settings.register(MODULE_ID, 'inviteUrl', { name: 'Player invite URL', scope: 'world', config: false, type: String, default: '' })
  installGmPanel(bridge)
  installAuthoring(bridge, assetRegistry)
})

Hooks.once('ready', () => {
  if (!game.user?.isGM) return
  installBridgeChatNotificationFilter()
  bridge.connect()
  refreshSceneControls()

  Hooks.on('canvasReady', () => {
    const scene = bridge.activeScene()
    if (scene) bridge.emit('scene.activated', { sceneId: scene.id, name: scene.name })
    bridge.pushSnapshot()
  })
  Hooks.on('createToken', (document) => bridge.onDocumentCreated(document))
  Hooks.on('updateToken', (document, changes) => bridge.onDocumentUpdated(document, changes))
  Hooks.on('deleteToken', (document) => bridge.onDocumentDeleted(document))
  Hooks.on('createTile', (document) => bridge.onDocumentCreated(document))
  Hooks.on('updateTile', (document, changes) => bridge.onDocumentUpdated(document, changes))
  Hooks.on('deleteTile', (document) => bridge.onDocumentDeleted(document))
  Hooks.on('createWall', (document) => bridge.onWallChanged(document))
  Hooks.on('updateWall', (document, changes) => {
    void changes
    bridge.onWallChanged(document)
  })
  Hooks.on('deleteWall', (document) => bridge.onWallDeleted(document))
  Hooks.on('updateActor', (actor, changes) => bridge.onActorUpdated(actor, changes))
  Hooks.on('createActiveEffect', (document) => bridge.onActorContentUpdated(document))
  Hooks.on('updateActiveEffect', (document) => bridge.onActorContentUpdated(document))
  Hooks.on('deleteActiveEffect', (document) => bridge.onActorContentUpdated(document))
  Hooks.on('createItem', (document) => bridge.onActorContentUpdated(document))
  Hooks.on('updateItem', (document) => bridge.onActorContentUpdated(document))
  Hooks.on('deleteItem', (document) => bridge.onActorContentUpdated(document))
  Hooks.on('updateScene', (scene, changes) => {
    if (scene.id === bridge.activeScene()?.id) {
      bridge.emit('scene.updated', { sceneId: scene.id, changes })
      if (changes.background || changes.img) bridge.pushSnapshot()
    }
  })
  Hooks.on('createCombat', () => bridge.pushCombat())
  Hooks.on('updateCombat', () => bridge.pushCombat())
  Hooks.on('deleteCombat', () => bridge.pushCombat())
  Hooks.on('combatStart', () => bridge.pushCombat())
  Hooks.on('combatTurnChange', () => bridge.pushCombat())
  Hooks.on('createChatMessage', (message) => bridge.forwardChat(message))
})

window.foundryBridge = bridge
export { FoundryBridge }
