import Phaser from 'phaser'
import {
  LEGACY_DIRS,
  actionAnimFor,
  animKey,
  frameRange,
  resolveAnim,
  resolveSheetAnims,
} from '../../../module/lpc-bridge/scripts/lpc.mjs'
import { assetUrl } from '../net/bridge.js'

const UNIT = 64
const DEFAULT_WORLD_UNITS_PER_SECOND = 1

export class WorldScene extends Phaser.Scene {
  constructor() {
    super('world')
  }

  create() {
    this.bridge = this.game.registry.get('bridge')
    this.ui = this.game.registry.get('ui')
    this.unit = UNIT
    this.entities = new Map()
    this.doors = new Map()
    this.loaded = new Set()
    this.animsReady = new Set()
    this.spriteAnims = new Map()
    this.lastHp = new Map()
    this.contextHud = null
    this.speechBubbles = new Map()
    this.claimedTokenId = null
    this.cameraPreset = 'follow'
    this.inCombat = false
    this.marker = this.add.circle(0, 0, 10, 0xc4a574, 0.35).setVisible(false)
    this.doorIcons = {}
    this.events.on(Phaser.Scenes.Events.UPDATE, this.syncChrome, this)
    this.input.on('pointerup', (pointer) => {
      if (pointer.getDistance() > 16) return
      this.handleTap(pointer)
    })
    this.bridge.on('world.snapshot', (payload) => this.applySnapshot(payload))
    this.bridge.on('entity.created', (payload) => this.upsertEntity(payload.entity))
    this.bridge.on('entity.updated', (payload) => this.upsertEntity(payload.entity))
    this.bridge.on('entity.deleted', (payload) => this.removeEntity(payload.entityId))
    this.bridge.on('token.moved', (payload) => this.onTokenMoved(payload))
    this.bridge.on('token.animated', (payload) => this.onTokenAnimated(payload))
    this.bridge.on('wall.updated', (payload) => this.upsertDoor(payload.wall))
    this.bridge.on('wall.deleted', (payload) => this.removeDoor(payload.wallId))
    this.bridge.on('combat.updated', (payload) => this.setCombat(payload?.started))
    this.bridge.on('actor.updated', (payload) => this.onActorUpdated(payload))
    this.bridge.on('scene.activated', () => this.bridge.command('world.snapshot.request').catch(() => {}))
  }

  setClaimed(tokenId) {
    this.claimedTokenId = tokenId
    this.followClaimed()
  }

  worldToPx(value) {
    return Number(value || 0) * this.unit
  }

  pxToWorld(x, y) {
    return { x: x / this.unit, y: y / this.unit }
  }

  assetFor(entity) {
    return (this.snapshot?.assets || []).find((asset) => asset.id && asset.id === entity?.spriteId) || null
  }

  isLpcSprite(entity) {
    return this.spriteAnims.has(entity?.spriteId)
  }

  squarePx(entity, axis = 'width') {
    const raw = Number(entity?.transform?.[axis])
    const scale = Number(entity?.transform?.scale?.[axis === 'width' ? 'x' : 'y']) || 1
    const squares = Number.isFinite(raw) && raw >= 0.25 ? raw : 1
    return this.worldToPx(squares * scale)
  }

  spriteXY(entity, position = entity?.transform?.position) {
    const x = this.worldToPx(position?.x)
    const y = this.worldToPx(position?.y)
    const width = this.squarePx(entity, 'width')
    const height = this.squarePx(entity, 'height')
    if (this.isLpcSprite(entity)) {
      return { x: x + width / 2, y: y + height, originX: 0.5, originY: 1, width, height }
    }
    return { x, y, originX: 0, originY: 0, width, height }
  }

  fitSprite(sprite, entity, registry = null) {
    const pos = this.spriteXY(entity)
    sprite.setOrigin(pos.originX, pos.originY)
    sprite.setPosition(pos.x, pos.y)
    const frameW = Number(registry?.frameSize?.width) || sprite.frame?.cutWidth || sprite.width || this.unit
    const frameH = Number(registry?.frameSize?.height) || sprite.frame?.cutHeight || sprite.height || this.unit
    sprite.setScale(pos.width / frameW, pos.height / frameH)
  }

  handleTap(pointer) {
    if (!this.ui) this.ui = this.game.registry.get('ui')
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y)
    const pos = this.pxToWorld(world.x, world.y)
    const door = this.hitDoor(world.x, world.y)
    if (door) {
      this.ui?.onWorldTap({ kind: 'door', wall: door, position: pos })
      return
    }
    const entity = this.hitEntity(world.x, world.y)
    if (entity) {
      this.ui?.onWorldTap({ kind: 'entity', entity, position: pos })
      return
    }
    this.hideContextHud()
    this.marker.setPosition(
      this.worldToPx(Math.floor(pos.x)) + this.unit / 2,
      this.worldToPx(Math.floor(pos.y)) + this.unit / 2,
    ).setVisible(true)
    this.ui?.onWorldTap({ kind: 'ground', position: { x: Math.floor(pos.x), y: Math.floor(pos.y) } })
  }

  showEntityHud(entity, actions) {
    const entry = this.entities.get(entity.id)
    if (!entry?.sprite) return
    this.showWorldHud(entity.id, entity.name, actions)
  }

  showDoorHud(wall, actions) {
    const position = {
      x: (this.worldToPx(wall.a.x) + this.worldToPx(wall.b.x)) / 2,
      y: (this.worldToPx(wall.a.y) + this.worldToPx(wall.b.y)) / 2,
    }
    this.showWorldHud(null, 'Door', actions, position)
  }

  showWorldHud(entityId, title, actions, fixedPosition = null) {
    this.hideContextHud()
    this.contextHud = { entityId, fixedPosition }
    this.ui?.showContextHud(title, actions.filter((action) => action?.label))
    this.positionWorldOverlays()
  }

  hideContextHud() {
    this.contextHud = null
    this.ui?.hideContextHud()
  }

  showSpeech(entityId, speaker, message, duration = 5200) {
    if (!entityId || !message) return
    const entry = this.entities.get(entityId) || this.entities.get(`Token.${String(entityId).replace(/^Token\./, '')}`)
    if (!entry?.sprite) return
    this.speechBubbles.get(entityId)?.container?.destroy(true)
    const text = this.add.text(0, 0, message, { fontFamily: 'system-ui, sans-serif', fontSize: '13px', color: '#1b1712', backgroundColor: '#fff7e6', padding: { x: 10, y: 8 }, wordWrap: { width: 190 }, align: 'center' }).setOrigin(0.5, 1)
    const name = this.add.text(0, 4, speaker || '', { fontFamily: 'system-ui, sans-serif', fontStyle: 'bold', fontSize: '10px', color: '#c4a574', backgroundColor: '#17110d', padding: { x: 5, y: 3 } }).setOrigin(0.5, 0)
    const tail = this.add.triangle(0, 3, -7, 0, 7, 0, 0, 8, 0xfff7e6).setOrigin(0.5, 0)
    const container = this.add.container(0, 0, [text, tail, name]).setDepth(110).setAlpha(0)
    this.speechBubbles.set(entityId, { container, entityId })
    this.positionWorldOverlays()
    this.tweens.add({ targets: container, alpha: 1, y: container.y - 6, duration: 160, ease: 'Back.Out' })
    this.time.delayedCall(duration, () => {
      if (this.speechBubbles.get(entityId)?.container !== container) return
      this.tweens.add({ targets: container, alpha: 0, duration: 220, onComplete: () => { container.destroy(true); this.speechBubbles.delete(entityId) } })
    })
  }

  positionWorldOverlays() {
    const overlayScale = 1 / Math.max(0.35, this.cameras.main.zoom || 1)
    const position = (entityId, fixed) => {
      if (fixed) return fixed
      const entry = this.entities.get(entityId)
      if (!entry?.sprite) return null
      const bounds = entry.sprite.getBounds()
      return { x: bounds.centerX, y: bounds.top - 10 }
    }
    if (this.contextHud) {
      const pos = position(this.contextHud.entityId, this.contextHud.fixedPosition)
      if (pos) {
        const camera = this.cameras.main
        const canvas = this.game.canvas.getBoundingClientRect()
        const x = canvas.left + (pos.x - camera.worldView.x) * camera.zoom
        const y = canvas.top + (pos.y - camera.worldView.y) * camera.zoom
        this.ui?.positionContextHud(x, y)
      }
    }
    for (const bubble of this.speechBubbles.values()) {
      const pos = position(bubble.entityId)
      if (pos) bubble.container.setPosition(pos.x, pos.y - 12).setScale(overlayScale)
    }
  }

  hitEntity(x, y) {
    let best = null
    let bestDist = 36
    for (const [id, entry] of this.entities) {
      if (!entry.sprite?.visible) continue
      const bounds = entry.sprite.getBounds?.()
      const cx = bounds ? bounds.centerX : entry.sprite.x
      const cy = bounds ? bounds.centerY : entry.sprite.y
      const dist = Phaser.Math.Distance.Between(x, y, cx, cy)
      const radius = Math.max(entry.sprite.displayWidth, entry.sprite.displayHeight) * 0.45
      if (dist < Math.max(bestDist, radius)) {
        best = { ...entry.entity, id }
        bestDist = dist
      }
    }
    return best
  }

  hitDoor(x, y) {
    for (const wall of this.doors.values()) {
      if (wall.door === 'none' || (wall.door === 'secret' && wall.doorState !== 'open')) continue
      const mx = (this.worldToPx(wall.a.x) + this.worldToPx(wall.b.x)) / 2
      const my = (this.worldToPx(wall.a.y) + this.worldToPx(wall.b.y)) / 2
      if (Phaser.Math.Distance.Between(x, y, mx, my) < 28) return wall
    }
    return null
  }

  applySnapshot(payload) {
    this.snapshot = payload
    this.cameraPreset = payload.scene?.map?.camera?.preset || 'follow'
    this.setCombat(payload.combat?.started)
    this.drawBackground(payload.scene)
    this.drawWalls(payload.scene?.walls || [])
    const seen = new Set()
    for (const entity of payload.entities || []) {
      seen.add(entity.id)
      this.upsertEntity(entity)
    }
    for (const id of [...this.entities.keys()]) {
      if (!seen.has(id)) this.removeEntity(id)
    }
    this.followClaimed()
  }

  setCombat(started) {
    const next = !!started
    if (this.inCombat === next) return
    this.inCombat = next
    for (const entry of this.entities.values()) {
      if (!entry.walking && entry.entity) this.playAnim(entry.entity, 'idle')
    }
  }

  drawBackground(scene) {
    const width = this.worldToPx(scene?.dimensions?.width || 20)
    const height = this.worldToPx(scene?.dimensions?.height || 20)
    this.cameras.main.setBounds(0, 0, width, height)
    const url = assetUrl(scene?.map?.backgroundUrl)
    if (this.background) this.background.destroy()
    if (!url) {
      this.background = this.add.rectangle(width / 2, height / 2, width, height, 0x24301c).setDepth(-20)
      return
    }
    const key = `bg:${url}`
    const place = () => {
      if (this.background) this.background.destroy()
      this.background = this.add.image(0, 0, key).setOrigin(0, 0).setDisplaySize(width, height).setDepth(-20)
    }
    if (this.textures.exists(key)) {
      place()
      return
    }
    this.load.image(key, url)
    this.load.once(`filecomplete-image-${key}`, place)
    this.load.once('loaderror', (file) => {
      if (file?.key === key) this.background = this.add.rectangle(width / 2, height / 2, width, height, 0x24301c).setDepth(-20)
    })
    if (!this.load.isLoading()) this.load.start()
  }

  drawWalls(walls) {
    this.doors.clear()
    for (const wall of walls) {
      this.upsertDoor(wall, false)
    }
    this.redrawDoors()
  }

  upsertDoor(wall, redraw = true) {
    if (!wall?.wallId) return
    this.doors.set(wall.wallId, wall)
    if (redraw && this.snapshot?.scene) this.drawWalls(this.snapshot.scene.walls?.map((entry) => (
      entry.wallId === wall.wallId ? wall : entry
    )) || [...this.doors.values()])
  }

  removeDoor(wallId) {
    this.doors.delete(wallId)
    if (this.snapshot?.scene) {
      this.snapshot.scene.walls = (this.snapshot.scene.walls || []).filter((wall) => wall.wallId !== wallId)
      this.drawWalls(this.snapshot.scene.walls)
    }
  }

  redrawDoors() {
    for (const icon of Object.values(this.doorIcons || {})) icon.destroy()
    this.doorIcons = {}
    for (const wall of this.doors.values()) {
      if (wall.door === 'none' || (wall.door === 'secret' && wall.doorState !== 'open')) continue
      const x = (this.worldToPx(wall.a.x) + this.worldToPx(wall.b.x)) / 2
      const y = (this.worldToPx(wall.a.y) + this.worldToPx(wall.b.y)) / 2
      const diamond = this.add.rectangle(x, y, 18, 18, wall.doorState === 'open' ? 0x8ecf9a : 0xc4a574)
        .setAngle(45)
        .setDepth(5)
      this.doorIcons[wall.wallId] = diamond
    }
  }

  upsertEntity(entity) {
    if (!entity?.id || entity.visible === false) {
      if (entity?.id) this.removeEntity(entity.id)
      return
    }
    const existing = this.entities.get(entity.id)
    if (existing?.loading && !existing.sprite) {
      existing.entity = entity
      return
    }
    if (existing?.sprite) {
      existing.entity = entity
      this.refreshChrome(entity)
      this.rememberHp(entity)
      if (existing.walking) return
      const next = this.spriteXY(entity)
      if (Math.hypot(existing.sprite.x - next.x, existing.sprite.y - next.y) < 4) return
      this.walkPath(entity.id, [{
        x: entity.transform?.position?.x,
        y: entity.transform?.position?.y,
        facing: entity.transform?.facing,
      }])
      return
    }
    this.spawnEntity(entity)
  }

  spawnEntity(entity) {
    const placeholder = this.spriteXY(entity)
    const generation = crypto.randomUUID()
    this.entities.set(entity.id, { entity, sprite: null, steps: [], walking: false, tween: null, loading: true, generation })
    this.loadEntityTexture(entity, (key, sheet) => {
      const current = this.entities.get(entity.id)
      if (!current || current.generation !== generation) return
      const liveEntity = current.entity
      const pos = this.spriteXY(liveEntity)
      const sprite = sheet ? this.add.sprite(pos.x, pos.y, key, 0) : this.add.image(pos.x, pos.y, key)
      if (sheet) this.fitSprite(sprite, liveEntity, this.assetFor(liveEntity))
      else sprite.setDisplaySize(pos.width || this.unit, pos.height || this.unit).setOrigin(pos.originX, pos.originY)
      sprite.setDepth(liveEntity.documentType === 'Tile' ? 1 : 10)
      const entry = this.entities.get(entity.id) || { entity: liveEntity }
      entry.sprite = sprite
      entry.entity = liveEntity
      entry.loading = false
      this.entities.set(entity.id, entry)
      this.attachChrome(liveEntity, sprite)
      this.rememberHp(liveEntity)
      this.playAnim(liveEntity, 'idle')
      if (liveEntity.documentId === this.claimedTokenId) this.followClaimed()
    }, () => {
      const current = this.entities.get(entity.id)
      if (!current || current.generation !== generation) return
      const liveEntity = current.entity
      const color = entity.disposition < 0 ? 0x8a3030 : entity.disposition > 0 ? 0x3d6a4a : 0x4a3d2c
      const sprite = this.add.rectangle(placeholder.x, placeholder.y, placeholder.width || this.unit, placeholder.height || this.unit, color)
        .setOrigin(0, 0)
      sprite.setDepth(entity.documentType === 'Tile' ? 1 : 10)
      const entry = this.entities.get(entity.id) || { entity }
      entry.sprite = sprite
      entry.entity = liveEntity
      entry.loading = false
      this.entities.set(entity.id, entry)
      this.attachChrome(entity, sprite)
      this.rememberHp(entity)
      if (entity.documentId === this.claimedTokenId) this.followClaimed()
    })
  }

  rememberHp(entity) {
    const hp = entity?.actor?.hp
    if (entity?.documentId && hp != null) this.lastHp.set(entity.documentId, Number(hp))
  }

  onActorUpdated(payload) {
    const hp = payload?.hp
    for (const tokenId of payload.tokenIds || []) {
      const entry = this.entities.get(`Token.${tokenId}`)
        || [...this.entities.values()].find((candidate) => candidate.entity?.documentId === tokenId)
      if (entry?.entity) {
        entry.entity.actor ||= {}
        if (hp != null) entry.entity.actor.hp = hp
        if (payload.maxHp != null) entry.entity.actor.maxHp = payload.maxHp
        if (payload.tempHp != null) entry.entity.actor.tempHp = payload.tempHp
        if (Array.isArray(payload.conditions)) entry.entity.actor.conditions = [...payload.conditions]
        if (typeof payload.dead === 'boolean') entry.entity.actor.dead = payload.dead
        this.refreshChrome(entry.entity)
      }
      if (hp == null) continue
      const previous = this.lastHp.get(tokenId)
      this.lastHp.set(tokenId, Number(hp))
      if (previous != null && Number(hp) < previous) {
        this.playAnimByToken(tokenId, 'hurt')
        this.floatText(tokenId, `-${previous - Number(hp)}`, '#e07060')
      } else if (previous != null && Number(hp) > previous) {
        this.floatText(tokenId, `+${Number(hp) - previous}`, '#76d58b')
      }
    }
  }

  onTokenAnimated(payload) {
    if (!payload?.tokenId) return
    this.playAnimByToken(payload.tokenId, payload.animation || 'slash')
  }

  playAnimByToken(tokenId, kind) {
    const entity = this.entities.get(`Token.${tokenId}`)?.entity
      || [...this.entities.values()].find((entry) => entry.entity?.documentId === tokenId)?.entity
    if (entity) this.playAnim(entity, kind)
  }

  onTokenMoved(payload) {
    const entityId = `Token.${payload.tokenId}`
    const entry = this.entities.get(entityId)
    if (!entry) return
    if (payload.tokenId === this.claimedTokenId && entry.walking) return
    if (payload.destination && entry.entity?.transform) {
      entry.entity.transform.position = { ...payload.destination }
      entry.entity.transform.facing = payload.facing || entry.entity.transform.facing
    }
    this.walkPath(entityId, payload.path || [], payload.movementSpeed)
  }

  isWalking(entityId) {
    return !!this.entities.get(entityId)?.walking
  }

  walkPath(entityId, path, movementSpeed = DEFAULT_WORLD_UNITS_PER_SECOND) {
    const entry = this.entities.get(entityId)
    if (!entry?.sprite || !path?.length) return
    this.cancelWalk(entityId)
    entry.steps = path.map((step) => ({ ...step }))
    entry.movementSpeed = Math.max(0.25, Number(movementSpeed) || DEFAULT_WORLD_UNITS_PER_SECOND)
    entry.walking = true
    this.advanceWalk(entityId)
  }

  cancelWalk(entityId) {
    const entry = this.entities.get(entityId)
    if (!entry) return
    entry.tween?.stop()
    entry.tween = null
    entry.steps = []
    entry.walking = false
  }

  advanceWalk(entityId) {
    const entry = this.entities.get(entityId)
    if (!entry?.sprite) return
    const step = entry.steps.shift()
    if (!step) {
      entry.walking = false
      this.playAnim(entry.entity, 'idle')
      if (entry.entity.documentId === this.claimedTokenId) this.marker.setVisible(false)
      return
    }
    if (entry.entity.transform) entry.entity.transform.facing = step.facing || entry.entity.transform.facing
    this.playAnim(entry.entity, 'walk')
    const pos = this.spriteXY(entry.entity, step)
    const distance = Math.hypot(entry.sprite.x - pos.x, entry.sprite.y - pos.y) / this.unit
    const duration = Math.max(120, (distance / entry.movementSpeed) * 1000)
    entry.tween = this.tweens.add({
      targets: entry.sprite,
      x: pos.x,
      y: pos.y,
      duration,
      ease: 'Linear',
      onComplete: () => this.advanceWalk(entityId),
    })
    if (entry.entity.documentId === this.claimedTokenId) this.followClaimed()
  }

  loadEntityTexture(entity, onReady, onFail) {
    const registry = this.assetFor(entity)
    const sheetUrl = assetUrl(registry?.spriteUrl)
    const textureUrl = assetUrl(entity.textureUrl)
    if (registry && sheetUrl && registry.frameSize?.width) {
      const key = `sheet:${entity.spriteId}`
      const boot = () => {
        this.ensureAnims(entity.spriteId, registry)
        onReady(key, true)
      }
      if (this.textures.exists(key)) {
        boot()
        return
      }
      this.load.spritesheet(key, sheetUrl, {
        frameWidth: registry.frameSize.width,
        frameHeight: registry.frameSize.height,
      })
      this.load.once(`filecomplete-spritesheet-${key}`, boot)
      this.load.once('loaderror', (file) => { if (file?.key === key) onFail() })
      if (!this.load.isLoading()) this.load.start()
      return
    }
    if (!textureUrl) {
      onFail()
      return
    }
    const key = `tex:${entity.id}:${textureUrl}`
    if (this.textures.exists(key)) {
      onReady(key, false)
      return
    }
    this.load.image(key, textureUrl)
    this.load.once(`filecomplete-image-${key}`, () => onReady(key, false))
    this.load.once('loaderror', (file) => { if (file?.key === key) onFail() })
    if (!this.load.isLoading()) this.load.start()
  }

  sliceSheet(key, frameWidth, frameHeight) {
    const texture = this.textures.get(key)
    const source = texture?.source?.[0]
    if (!texture || !source) return
    const cols = Math.max(1, Math.floor(source.width / frameWidth))
    const rows = Math.max(1, Math.floor(source.height / frameHeight))
    const expected = cols * rows
    if (texture.frameTotal >= expected) return
    let index = 0
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        if (!texture.has(index)) {
          texture.add(index, 0, col * frameWidth, row * frameHeight, frameWidth, frameHeight)
        }
        index += 1
      }
    }
  }

  ensureAnims(spriteId, registry) {
    if (this.animsReady.has(spriteId)) return
    const key = `sheet:${spriteId}`
    const texture = this.textures.get(key)
    if (!texture) return
    const frameWidth = registry.frameSize.width
    const frameHeight = registry.frameSize.height || frameWidth
    this.sliceSheet(key, frameWidth, frameHeight)
    const source = texture.source[0]
    const width = source?.width || frameWidth
    const height = source?.height || frameHeight
    const cols = Math.max(1, Math.floor(width / frameWidth))
    const resolved = resolveSheetAnims(width, height, registry)
    if (resolved.mode === 'lpc') {
      this.spriteAnims.set(spriteId, resolved.anims)
      for (const anim of resolved.anims) {
        const facings = anim.dirs === 1 ? [null] : ['up', 'left', 'down', 'right']
        for (const facing of facings) {
          const name = animKey(spriteId, anim.name, facing)
          if (this.anims.exists(name)) continue
          const range = frameRange(anim, facing || 'down', anim.cols || cols)
          this.anims.create({
            key: name,
            frames: this.anims.generateFrameNumbers(key, { start: range.first, end: range.last }),
            frameRate: anim.fps || 8,
            repeat: anim.loop ? -1 : 0,
          })
        }
      }
    } else {
      for (let d = 0; d < 4; d += 1) {
        const start = d * cols
        const end = start + cols - 1
        const dir = LEGACY_DIRS[d]
        if (!this.anims.exists(`${spriteId}-walk-${dir}`)) {
          this.anims.create({
            key: `${spriteId}-walk-${dir}`,
            frames: this.anims.generateFrameNumbers(key, { start, end }),
            frameRate: 8,
            repeat: -1,
          })
        }
        if (!this.anims.exists(`${spriteId}-idle-${dir}`)) {
          this.anims.create({
            key: `${spriteId}-idle-${dir}`,
            frames: [{ key, frame: start }],
            frameRate: 1,
          })
        }
      }
    }
    this.animsReady.add(spriteId)
  }

  playAnim(entity, kind) {
    const entry = this.entities.get(entity.id)
    const sprite = entry?.sprite
    if (!sprite?.play || !entity.spriteId) return
    const available = this.spriteAnims.get(entity.spriteId) || []
    const name = available.length ? resolveAnim(available, kind, { inCombat: this.inCombat }) : kind
    const facing = entity.transform?.facing || 'down'
    const key = this.anims.exists(animKey(entity.spriteId, name, facing))
      ? animKey(entity.spriteId, name, facing)
      : `${entity.spriteId}-${name}-${facing}`
    if (!this.anims.exists(key)) return
    const def = available.find((anim) => anim.name === name)
    const oneshot = !!def?.oneshot || name === 'hurt'
    sprite.off('animationcomplete')
    sprite.play(key, !oneshot)
    if (!oneshot) return
    sprite.once('animationcomplete', (animation) => {
      if (animation?.key && animation.key !== key) return
      if (!entry || entry.entity !== entity) return
      if (entry.walking) this.playAnim(entity, 'walk')
      else this.playAnim(entity, 'idle')
    })
  }

  playAction(entity, action) {
    this.playAnim(entity, actionAnimFor(action || {}))
  }

  refreshChrome(entity) {
    const entry = this.entities.get(entity.id)
    if (!entry || entity.documentType !== 'Token') return
    const width = entry.sprite?.displayWidth || this.unit
    const ratio = entity.actor?.maxHp ? Math.max(0, Math.min(1, Number(entity.actor.hp) / Number(entity.actor.maxHp))) : 1
    if (entry.hp) entry.hp.width = width * ratio
    if (entry.label) entry.label.setText(entity.name || '')
  }

  attachChrome(entity, sprite) {
    if (entity.documentType !== 'Token') return
    const entry = this.entities.get(entity.id)
    if (!entry) return
    entry.label?.destroy()
    entry.bar?.destroy()
    entry.hp?.destroy()
    const width = sprite.displayWidth || this.unit
    const lpc = this.isLpcSprite(entity)
    const label = this.add.text(sprite.x, sprite.y, entity.name || '', {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '12px',
      color: '#f0e0c0',
      stroke: '#000',
      strokeThickness: 3,
    }).setOrigin(lpc ? 0.5 : 0, 1).setDepth(20)
    const bar = this.add.rectangle(sprite.x, sprite.y, width, 4, 0x3a2a1c).setOrigin(lpc ? 0.5 : 0, 1).setDepth(20)
    const hp = this.add.rectangle(sprite.x, sprite.y, width, 4, 0x8ecf9a).setOrigin(lpc ? 0.5 : 0, 1).setDepth(21)
    const ratio = entity.actor?.maxHp ? Math.max(0, Math.min(1, entity.actor.hp / entity.actor.maxHp)) : 1
    hp.width = width * ratio
    entry.label = label
    entry.bar = bar
    entry.hp = hp
    sprite.once('destroy', () => { label.destroy(); bar.destroy(); hp.destroy() })
  }

  chromeAnchor(entry) {
    const sprite = entry.sprite
    if (!sprite) return { x: 0, y: 0 }
    if (this.isLpcSprite(entry.entity)) {
      return { x: sprite.x, y: sprite.y - sprite.displayHeight }
    }
    return { x: sprite.x, y: sprite.y }
  }

  syncChrome() {
    for (const entry of this.entities.values()) {
      if (!entry.sprite || !entry.label) continue
      const pos = this.chromeAnchor(entry)
      entry.label.setPosition(pos.x, pos.y)
      entry.bar?.setPosition(pos.x, pos.y)
      entry.hp?.setPosition(pos.x, pos.y)
    }
    this.positionWorldOverlays()
  }

  removeEntity(entityId) {
    this.cancelWalk(entityId)
    const entry = this.entities.get(entityId)
    entry?.sprite?.destroy()
    entry?.label?.destroy()
    entry?.bar?.destroy()
    entry?.hp?.destroy()
    this.entities.delete(entityId)
    if (this.contextHud?.entityId === entityId) this.hideContextHud()
    this.speechBubbles.get(entityId)?.container?.destroy(true)
    this.speechBubbles.delete(entityId)
  }

  followClaimed() {
    if (this.cameraPreset === 'locked') {
      this.cameras.main.stopFollow()
      return
    }
    const entry = [...this.entities.values()].find((item) => item.entity.documentId === this.claimedTokenId)
    if (entry?.sprite) this.cameras.main.startFollow(entry.sprite, true, 0.14, 0.14)
  }

  floatText(entityId, text, tint = '#e07060') {
    const entry = this.entities.get(entityId) || this.entities.get(`Token.${entityId}`)
    const sprite = entry?.sprite
    if (!sprite) return
    const bounds = sprite.getBounds?.()
    const x = bounds ? bounds.centerX : sprite.x + sprite.displayWidth / 2
    const y = bounds ? bounds.top : sprite.y
    const label = this.add.text(x, y, text, {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '18px',
      color: tint,
      stroke: '#000',
      strokeThickness: 4,
    }).setOrigin(0.5, 1).setDepth(50)
    this.tweens.add({
      targets: label,
      y: y - 40,
      alpha: 0,
      duration: 900,
      onComplete: () => label.destroy(),
    })
  }

  shakeBlocked() {
    this.marker.setVisible(false)
    this.cameras.main.shake(120, 0.006)
  }
}
