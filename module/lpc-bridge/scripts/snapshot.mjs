export const MODULE_ID = 'lpc-bridge'
export const PROTOCOL_VERSION = 2
export const FACINGS = ['down', 'left', 'right', 'up']

export const DEFAULT_WORLD_2D = Object.freeze({
  enabled: true,
  mapId: null,
  tilesetId: null,
  unitsPerGridSquare: 1,
  lighting: {},
  fog: {},
  camera: {},
})

export const DEFAULT_ENTITY_2D = Object.freeze({
  spriteId: null,
  entityType: null,
  visible: true,
  selectable: true,
  facing: 'down',
  scale: { x: 1, y: 1 },
  interaction: {},
  controllers: [],
  claimable: false,
  playerSelectable: null,
})

export function clone(value) {
  return value == null ? value : structuredClone(value)
}

export function mergeDefaults(defaults, value) {
  const target = clone(defaults)
  for (const [key, next] of Object.entries(value || {})) {
    const current = target[key]
    const objects = current && next && typeof current === 'object' && typeof next === 'object'
      && !Array.isArray(current) && !Array.isArray(next)
    target[key] = objects ? mergeDefaults(current, next) : clone(next)
  }
  return target
}

export function envelope(kind, type, payload = {}, extra = {}) {
  return { v: PROTOCOL_VERSION, kind, type, ...extra, payload }
}

export function migrateWorld2d(stored) {
  if (!stored) return {}
  const preset = stored.camera?.preset === 'isometric' ? 'top-down' : stored.camera?.preset
  return {
    enabled: stored.enabled !== false,
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

export function migrateEntity2d(stored) {
  if (!stored) return {}
  return {
    spriteId: stored.spriteId ?? null,
    entityType: stored.entityType,
    visible: stored.visible,
    selectable: stored.selectable,
    facing: FACINGS.includes(stored.facing) ? stored.facing : 'down',
    scale: { x: stored.scale?.x ?? 1, y: stored.scale?.y ?? 1 },
    interaction: stored.interaction,
    controllers: stored.controllers,
    claimable: stored.claimable,
    playerSelectable: typeof stored.playerSelectable === 'boolean' ? stored.playerSelectable : null,
  }
}

export function facingFromDelta(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'down' : 'up'
}

export function movementAnimationSpeed({ movement, gridDistance, roundSeconds = 6, worldUnits = 1 } = {}) {
  const walk = Number(movement?.walk)
  const distance = Number(gridDistance)
  const seconds = Number(roundSeconds)
  const units = Number(worldUnits)
  if (![walk, distance, seconds, units].every((value) => Number.isFinite(value) && value > 0)) return Math.max(0.25, units || 1)
  return Math.max(0.25, (walk / distance / seconds) * units)
}

export function doorKind(value) {
  const door = Number(value ?? 0)
  if (door === (CONST?.WALL_DOOR_TYPES?.SECRET ?? 2)) return 'secret'
  if (door === (CONST?.WALL_DOOR_TYPES?.DOOR ?? 1)) return 'door'
  return 'none'
}

export function doorState(value) {
  const state = Number(value ?? 0)
  if (state === (CONST?.WALL_DOOR_STATES?.OPEN ?? 1)) return 'open'
  if (state === (CONST?.WALL_DOOR_STATES?.LOCKED ?? 2)) return 'locked'
  return 'closed'
}

export function serializeWall(document, toWorld) {
  const [x1, y1, x2, y2] = document.c || []
  return {
    wallId: document.id,
    a: toWorld(x1, y1),
    b: toWorld(x2, y2),
    move: Number(document.move ?? 1) !== (CONST?.WALL_MOVEMENT_TYPES?.NONE ?? 0),
    door: doorKind(document.door),
    doorState: doorState(document.ds),
  }
}

export function serializeCombat() {
  const combat = game.combat
  if (!combat) {
    return { started: false, round: 0, turn: 0, combatantId: null, combatants: [] }
  }
  const combatants = [...(combat.combatants?.contents || combat.combatants || [])].map((combatant) => {
    const actor = combatant.actor
    return {
      id: combatant.id,
      tokenId: combatant.tokenId || combatant.token?.id || null,
      name: combatant.name,
      initiative: combatant.initiative ?? null,
      defeated: !!(combatant.defeated || combatant.isDefeated),
      isPC: actor?.type === 'character',
    }
  })
  return {
    started: !!combat.started,
    round: Number(combat.round || 0),
    turn: Number(combat.turn || 0),
    combatantId: combat.combatant?.id || combat.current?.combatantId || null,
    combatants,
  }
}

export function sceneBackgroundSrc(scene) {
  return scene?.background?.src || scene?.img || null
}

export function tokenTextureSrc(document) {
  return document?.texture?.src || document?.actor?.img || null
}

export function tileTextureSrc(document) {
  return document?.texture?.src || null
}

export function isPlayableToken(document, config) {
  if (typeof config?.playerSelectable === 'boolean') return config.playerSelectable
  if (config?.claimable) return true
  return document?.actor?.type === 'character'
}

export function tokenDisplayName(document) {
  return document?.name || document?.actor?.name || null
}

export function entityDisplayName(bridge, entityId, fallback = 'the world') {
  if (!entityId) return fallback
  const raw = String(entityId)
  const scene = bridge.activeScene?.() || canvas?.scene
  if (!scene) return fallback
  const tokenId = raw.replace(/^Token\./, '')
  const token = scene.tokens?.get(tokenId)
  if (token) return tokenDisplayName(token) || fallback
  if (raw.startsWith('Tile.')) {
    const tile = scene.tiles?.get(raw.slice(5))
    if (tile) return tile.name || 'an object'
  }
  const tile = scene.tiles?.get(raw)
  if (tile) return tile.name || 'an object'
  return fallback
}

export function characterNameFor(bridge, connectionId, fallback = 'Someone') {
  const client = bridge.clients?.get(connectionId)
  if (client?.characterName) return client.characterName
  const tokenId = client?.claimedTokenId
  const token = tokenId ? bridge.activeScene()?.tokens?.get(tokenId) : null
  return tokenDisplayName(token) || fallback
}

export function claimantOf(document, config, clients) {
  const controllers = config?.controllers || []
  const character = tokenDisplayName(document)
  for (const [connectionId, client] of clients || []) {
    if (client.claimedTokenId === document.id) {
      return { claimedByConnectionId: connectionId, claimedByName: character }
    }
    if (controllers.includes(connectionId) || controllers.includes(client.name)) {
      return { claimedByConnectionId: connectionId, claimedByName: character }
    }
  }
  return {
    claimedByConnectionId: controllers.find((value) => [...(clients || new Map()).keys()].includes(value)) || null,
    claimedByName: character && controllers.length ? character : null,
  }
}
