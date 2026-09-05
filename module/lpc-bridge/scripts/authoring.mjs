import { LPC_ANIMATION_NAMES } from './lpc.mjs'

const MODULE_ID = 'lpc-bridge'

const ASSET_KINDS = ['character', 'creature', 'prop', 'building', 'terrain', 'tileset', 'map', 'effect', 'other']
const ENTITY_TYPES = ['actor', 'npc', 'prop', 'door', 'container', 'terrain', 'effect', 'other']
const FACINGS = ['down', 'left', 'right', 'up']
const MAP_KINDS = ['map', 'tileset', 'terrain', 'building']

function escape(value) {
  return foundry.utils.escapeHTML(String(value ?? ''))
}

function number(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function checked(value) {
  return value ? 'checked' : ''
}

function selected(actual, expected) {
  return actual === expected ? 'selected' : ''
}

function dialogV2() {
  return foundry.applications.api.DialogV2
}

function htmlDiv(markup) {
  const content = document.createElement('div')
  content.innerHTML = markup
  return content
}

function formRoot(target) {
  return target?.element || target?.form || target
}

function formData(target) {
  const root = formRoot(target)
  return new FormData(root.form || root.querySelector?.('form') || root)
}

function nextToolOrder(tools) {
  const list = Array.isArray(tools) ? tools : Object.values(tools || {})
  return Math.max(-1, ...list.map((tool) => Number(tool?.order) || 0)) + 1
}

function sceneControlGroup(controls, ...names) {
  if (Array.isArray(controls)) return controls.find((entry) => names.includes(entry?.name)) || null
  for (const name of names) {
    if (controls?.[name]) return controls[name]
  }
  return null
}

function ensureTools(group) {
  if (!group) return null
  if (!group.tools) group.tools = {}
  return group.tools
}

function addTool(tools, tool) {
  if (!tools) return
  const entry = { ...tool, order: tool.order ?? nextToolOrder(tools) }
  if (Array.isArray(tools)) {
    const index = tools.findIndex((item) => item?.name === entry.name)
    if (index >= 0) tools[index] = { ...tools[index], ...entry }
    else tools.push(entry)
    return
  }
  tools[entry.name] = entry
}

export function refreshSceneControls() {
  const controls = ui?.controls
  if (!controls) return
  if (typeof controls.render === 'function') return controls.render({ force: true })
  if (typeof controls.initialize === 'function') return controls.initialize()
}

function openDialog({ id, title, content, buttons, width = 620, contentClasses = ['standard-form'], render }) {
  const build = () => {
    const app = new (dialogV2())({
      id,
      window: { title, contentClasses, resizable: true },
      position: { width },
      content: typeof content === 'string' ? htmlDiv(content) : content,
      buttons,
    })
    if (render) app.addEventListener('render', (event) => render(event, app), { once: true })
    return app.render({ force: true })
  }
  const existing = foundry.applications.instances?.get(id)
  return existing ? existing.close().then(build) : build()
}

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function splitList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean)
}

function options(values, current, emptyLabel = null) {
  const empty = emptyLabel == null ? '' : `<option value="">${escape(emptyLabel)}</option>`
  return empty + values.map((value) => `<option value="${escape(value)}" ${selected(current, value)}>${escape(value)}</option>`).join('')
}

function assetOptions(assets, current, kinds = null, emptyLabel = 'No sprite') {
  const filtered = kinds ? assets.filter((asset) => kinds.includes(asset.kind)) : assets
  return `<option value="">${escape(emptyLabel)}</option>` + filtered
    .map((asset) => `<option value="${escape(asset.id)}" ${selected(current, asset.id)}>${escape(asset.name)} · ${escape(asset.id)}</option>`)
    .join('')
}

function notifyError(error) {
  console.error(`${MODULE_ID} | Authoring error`, error)
  ui.notifications?.error(error?.message || 'Foundry Bridge authoring action failed.')
}

function bindFilePickers(html) {
  const root = formRoot(html)
  root.querySelectorAll('[data-file-target]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = root.querySelector(`[name="${button.dataset.fileTarget}"]`)
      const Picker = foundry.applications.apps.FilePicker.implementation
      if (!Picker || !target) {
        ui.notifications?.warn('Foundry File Picker is unavailable.')
        return
      }
      new Picker({
        type: button.dataset.fileType || 'image',
        current: target.value,
        callback: (path) => { target.value = path },
      }).browse()
    })
  })
}

function normalizeAsset(entry) {
  const kind = entry.kind === 'environment' ? 'map' : entry.kind
  const animations = Array.isArray(entry.animations) ? entry.animations : splitList(entry.animationSetId)
  return {
    id: entry.id,
    name: entry.name,
    kind: ASSET_KINDS.includes(kind) ? kind : 'other',
    spriteUrl: String(entry.spriteUrl || entry.modelUrl || '').trim(),
    previewUrl: String(entry.previewUrl || '').trim(),
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    defaultEntityType: ENTITY_TYPES.includes(entry.defaultEntityType) ? entry.defaultEntityType : 'prop',
    defaultScale: {
      x: number(entry.defaultScale?.x, 1),
      y: number(entry.defaultScale?.y, 1),
    },
    frameSize: {
      width: number(entry.frameSize?.width, 64),
      height: number(entry.frameSize?.height, 64),
    },
    layout: ['lpc', 'classic', 'expanded', 'custom', 'auto'].includes(entry.layout) ? entry.layout : 'auto',
    directions: Number(entry.directions) === 8 ? 8 : 4,
    animations,
  }
}

export class AssetRegistry {
  registerSetting() {
    game.settings.register(MODULE_ID, 'assetRegistry', {
      scope: 'world',
      config: false,
      type: Object,
      default: { version: 2, assets: [] },
    })
  }

  data() {
    const stored = game.settings.get(MODULE_ID, 'assetRegistry') || {}
    return {
      version: 2,
      assets: Array.isArray(stored.assets) ? stored.assets.map(normalizeAsset) : [],
    }
  }

  list() {
    return [...this.data().assets].sort((a, b) => a.name.localeCompare(b.name))
  }

  get(id) {
    return this.data().assets.find((asset) => asset.id === id) || null
  }

  snapshot() {
    return this.list().map((asset) => structuredClone(asset))
  }

  async upsert(asset, previousId = null) {
    const id = slug(asset.id)
    if (!id) throw new Error('Asset ID is required and must contain Latin letters, numbers, dots, hyphens, or underscores.')
    if (!asset.name?.trim()) throw new Error('Asset name is required.')
    if (!asset.spriteUrl?.trim()) throw new Error('Sprite sheet URL is required.')

    const data = this.data()
    const conflict = data.assets.find((entry) => entry.id === id && entry.id !== previousId)
    if (conflict) throw new Error(`Asset ID already exists: ${id}`)
    const normalized = normalizeAsset({
      id,
      name: asset.name.trim(),
      kind: asset.kind,
      spriteUrl: asset.spriteUrl.trim(),
      previewUrl: asset.previewUrl,
      tags: Array.isArray(asset.tags) ? asset.tags : [],
      defaultEntityType: asset.defaultEntityType,
      defaultScale: asset.defaultScale,
      frameSize: asset.frameSize,
      layout: asset.layout,
      directions: asset.directions,
      animations: Array.isArray(asset.animations) ? asset.animations : splitList(asset.animations),
    })
    data.assets = data.assets.filter((entry) => entry.id !== previousId && entry.id !== id)
    data.assets.push(normalized)
    await game.settings.set(MODULE_ID, 'assetRegistry', data)
    return normalized
  }

  async remove(id) {
    const data = this.data()
    data.assets = data.assets.filter((asset) => asset.id !== id)
    await game.settings.set(MODULE_ID, 'assetRegistry', data)
  }
}

class AuthoringController {
  constructor(bridge, registry) {
    this.bridge = bridge
    this.registry = registry
  }

  openAssetRegistry() {
    const assets = this.registry.list()
    const rows = assets.length ? assets.map((asset) => `
      <li class="fb-asset-row" data-asset-id="${escape(asset.id)}">
        <div class="fb-asset-preview">
          ${asset.previewUrl || asset.spriteUrl ? `<img src="${escape(asset.previewUrl || asset.spriteUrl)}" alt="" />` : '<i class="fa-solid fa-image"></i>'}
        </div>
        <div class="fb-asset-copy">
          <strong>${escape(asset.name)}</strong>
          <code>${escape(asset.id)}</code>
          <small>${escape(asset.kind)} · ${escape(asset.layout || 'auto')} · ${escape(asset.frameSize.width)}×${escape(asset.frameSize.height)} · ${escape(asset.spriteUrl)}</small>
        </div>
        <div class="fb-row-actions">
          <button type="button" data-fb-action="place" title="Place in active scene"><i class="fa-solid fa-location-dot"></i></button>
          <button type="button" data-fb-action="edit" title="Edit"><i class="fa-solid fa-pen"></i></button>
          <button type="button" data-fb-action="delete" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </div>
      </li>`).join('') : '<li class="fb-empty">No LPC sprites registered yet.</li>'

    openDialog({
      id: 'lpc-bridge-asset-registry',
      title: 'Foundry Bridge · LPC Sprite Registry',
      width: 720,
      contentClasses: ['foundry-bridge-authoring'],
      content: `<p>Register PNGs from the <a href="https://liberatedpixelcup.github.io/Universal-LPC-Spritesheet-Character-Generator/" target="_blank" rel="noreferrer">Universal LPC Character Generator</a>. The player client slices walk, idle, combat, and action rows automatically.</p><ul class="fb-asset-list">${rows}</ul>`,
      buttons: [
        {
          action: 'create',
          icon: 'fa-solid fa-plus',
          label: 'New Sprite',
          default: true,
          callback: () => this.openAssetEditor(),
        },
        { action: 'close', icon: 'fa-solid fa-xmark', label: 'Close' },
      ],
      render: (_event, dialog) => {
        formRoot(dialog).querySelectorAll('[data-fb-action]').forEach((button) => {
          button.addEventListener('click', async (event) => {
            event.preventDefault()
            event.stopPropagation()
            const row = event.currentTarget.closest('[data-asset-id]')
            const id = row?.dataset.assetId
            const action = event.currentTarget.dataset.fbAction
            const asset = this.registry.get(id)
            try {
              if (action === 'edit') this.openAssetEditor(asset)
              if (action === 'place') await this.placeAsset(asset)
              if (action === 'delete' && await dialogV2().confirm({
                window: { title: 'Delete LPC sprite' },
                content: `<p>Delete <strong>${escape(asset?.name)}</strong> from the registry?</p>`,
                rejectClose: false,
                modal: true,
              })) {
                await this.registry.remove(id)
                this.bridge.pushSnapshot()
                this.openAssetRegistry()
              }
            } catch (error) {
              notifyError(error)
            }
          })
        })
      },
    })
  }

  openAssetEditor(asset = null) {
    const value = asset || {
      id: '',
      name: '',
      kind: 'character',
      spriteUrl: '',
      previewUrl: '',
      tags: [],
      defaultEntityType: 'actor',
      defaultScale: { x: 1, y: 1 },
      frameSize: { width: 64, height: 64 },
      layout: 'auto',
      directions: 4,
      animations: [...LPC_ANIMATION_NAMES],
    }
    openDialog({
      id: 'lpc-bridge-asset-editor',
      title: asset ? `Edit Sprite · ${asset.name}` : 'Register LPC Sprite',
      width: 620,
      content: `<div class="foundry-bridge-authoring fb-form">
        <div class="form-group"><label>Asset ID</label><input name="id" value="${escape(value.id)}" placeholder="lpc.goblin-01" /></div>
        <div class="form-group"><label>Name</label><input name="name" value="${escape(value.name)}" placeholder="Goblin 01" /></div>
        <div class="form-group"><label>Kind</label><select name="kind">${options(ASSET_KINDS, value.kind)}</select></div>
        <div class="form-group stacked"><label>Sprite sheet</label><div class="form-fields"><input name="spriteUrl" value="${escape(value.spriteUrl)}" placeholder="assets/sprites/hero.png" /><button type="button" class="file-picker" data-file-target="spriteUrl" data-file-type="image" title="Browse Files"><i class="fa-solid fa-file-import"></i></button></div><p class="notes">Download the full PNG from the <a href="https://liberatedpixelcup.github.io/Universal-LPC-Spritesheet-Character-Generator/" target="_blank" rel="noreferrer">Universal LPC Character Generator</a>. Standard sheets are 64×64 frames, 13 columns, direction order up / left / down / right. Classic sheets are 21 rows; expanded sheets are 54 rows.</p></div>
        <div class="form-group"><label>Preview image</label><div class="form-fields"><input name="previewUrl" value="${escape(value.previewUrl)}" placeholder="assets/previews/hero.png" /><button type="button" class="file-picker" data-file-target="previewUrl" data-file-type="image" title="Browse Files"><i class="fa-solid fa-file-import"></i></button></div></div>
        <div class="form-group"><label>Entity type</label><select name="defaultEntityType">${options(ENTITY_TYPES, value.defaultEntityType)}</select></div>
        <fieldset><legend>Frame size (pixels)</legend><div class="fb-vector fb-vector-2"><label>Width<input name="frameWidth" type="number" min="1" step="1" value="${value.frameSize.width}" /></label><label>Height<input name="frameHeight" type="number" min="1" step="1" value="${value.frameSize.height}" /></label></div></fieldset>
        <div class="form-group"><label>Sheet layout</label><select name="layout">
          <option value="auto" ${selected(value.layout || 'auto', 'auto')}>Auto-detect Universal LPC</option>
          <option value="lpc" ${selected(value.layout, 'lpc')}>Universal LPC (force)</option>
          <option value="custom" ${selected(value.layout, 'custom')}>Custom rows (down, left, right, up)</option>
        </select></div>
        <div class="form-group"><label>Directions</label><select name="directions"><option value="4" ${selected(String(value.directions), '4')}>4 (LPC: up, left, down, right)</option><option value="8" ${selected(String(value.directions), '8')}>8-directional</option></select></div>
        <div class="form-group"><label>Animations</label><input name="animations" value="${escape((value.animations || []).join(', '))}" placeholder="${escape(LPC_ANIMATION_NAMES.join(', '))}" /><p class="notes">Used when packing a partial export. Full generator sheets ignore this and play every row that exists.</p></div>
        <fieldset><legend>Default scale</legend><div class="fb-vector fb-vector-2"><label>X<input name="scaleX" type="number" step="0.01" value="${value.defaultScale.x}" /></label><label>Y<input name="scaleY" type="number" step="0.01" value="${value.defaultScale.y}" /></label></div></fieldset>
        <div class="form-group"><label>Tags</label><input name="tags" value="${escape((value.tags || []).join(', '))}" placeholder="goblin, humanoid, enemy" /></div>
      </div>`,
      buttons: [
        {
          action: 'save',
          icon: 'fa-solid fa-floppy-disk',
          label: 'Save Sprite',
          default: true,
          callback: async (_event, button) => {
            const data = formData(button)
            try {
              const saved = await this.registry.upsert({
                id: data.get('id'),
                name: data.get('name'),
                kind: data.get('kind'),
                spriteUrl: data.get('spriteUrl'),
                previewUrl: data.get('previewUrl'),
                tags: splitList(data.get('tags')),
                defaultEntityType: data.get('defaultEntityType'),
                defaultScale: { x: data.get('scaleX'), y: data.get('scaleY') },
                frameSize: { width: data.get('frameWidth'), height: data.get('frameHeight') },
                layout: data.get('layout'),
                directions: data.get('directions'),
                animations: splitList(data.get('animations')),
              }, asset?.id)
              ui.notifications?.info(`LPC sprite saved: ${saved.name}`)
              this.bridge.pushSnapshot()
            } catch (error) {
              notifyError(error)
            }
          },
        },
        { action: 'cancel', label: 'Cancel' },
      ],
      render: (_event, dialog) => bindFilePickers(dialog),
    })
  }

  async placeAsset(asset) {
    if (!asset) throw new Error('Asset no longer exists.')
    const scene = this.bridge.activeScene()
    if (!scene) throw new Error('Open a Scene before placing a sprite.')
    const grid = this.bridge.gridSize(scene)
    const center = canvas?.stage?.pivot || { x: scene.width / 2, y: scene.height / 2 }
    const [tile] = await scene.createEmbeddedDocuments('Tile', [{
      x: Math.round(center.x - grid / 2),
      y: Math.round(center.y - grid / 2),
      width: grid,
      height: grid,
      texture: { src: asset.previewUrl || asset.spriteUrl || 'icons/svg/cowled.svg' },
      flags: {
        [MODULE_ID]: {
          entity2d: {
            spriteId: asset.id,
            entityType: asset.defaultEntityType,
            visible: true,
            selectable: true,
            facing: 'down',
            scale: asset.defaultScale,
            interaction: { freeform: true },
            controllers: [],
          },
        },
      },
    }])
    ui.notifications?.info(`${asset.name} placed in ${scene.name}`)
    this.bridge.pushSnapshot()
    return tile
  }

  async persistActorPrototype(token, entityConfig) {
    if (token?.documentName !== 'Token' || !token.actor) return
    await token.actor.update({
      [`prototypeToken.flags.${MODULE_ID}.entity2d`]: {
        ...entityConfig,
        controllers: [],
      },
    })
  }

  sceneReport(scene = this.bridge.activeScene()) {
    if (!scene) return { errors: ['Open a scene first.'], warnings: [], stats: {} }
    const tokens = [...(scene.tokens || [])]
    const tiles = [...(scene.tiles || [])]
    const walls = [...(scene.walls || [])]
    const playable = tokens.filter((token) => {
      const entity = this.bridge.entity2d(token)
      return typeof entity.playerSelectable === 'boolean' ? entity.playerSelectable : (entity.claimable || token.actor?.type === 'character')
    })
    const missingArt = tokens.filter((token) => !token.texture?.src && !token.actor?.img)
    const errors = []
    const warnings = []
    if (!scene.background?.src && !scene.img) errors.push('Scene has no background map.')
    if (!playable.length) errors.push('No playable character tokens were detected.')
    if (!walls.length) warnings.push('No walls are present; players can move anywhere on the map.')
    if (missingArt.length) warnings.push(`${missingArt.length} token(s) have no usable image.`)
    return {
      errors,
      warnings,
      stats: {
        tokens: tokens.length,
        tiles: tiles.length,
        walls: walls.length,
        doors: walls.filter((wall) => Number(wall.door || 0) !== 0).length,
        playable: playable.length,
        npcs: tokens.filter((token) => token.actor?.type === 'npc').length,
      },
    }
  }

  openSceneSetup(targetScene = null) {
    const scene = targetScene || this.bridge.activeScene()
    if (!scene) return ui.notifications?.warn('Open a Scene first.')
    const config = this.bridge.world2d(scene)
    const report = this.sceneReport(scene)
    const characterRows = [...scene.tokens]
      .filter((token) => token.actor?.type === 'character')
      .map((token) => { const entity = this.bridge.entity2d(token); return `<label class="checkbox"><input type="checkbox" name="playable" value="${escape(token.id)}" ${checked(typeof entity.playerSelectable === 'boolean' ? entity.playerSelectable : true)} /> ${escape(token.name)}</label>` }).join('')
      || '<p class="fb-empty">Place character tokens in this scene first.</p>'
    const issueRows = [...report.errors.map((text) => `<li class="fb-validation-error"><i class="fa-solid fa-circle-xmark"></i> ${escape(text)}</li>`), ...report.warnings.map((text) => `<li class="fb-validation-warning"><i class="fa-solid fa-triangle-exclamation"></i> ${escape(text)}</li>`)]
      .join('') || '<li class="fb-validation-ok"><i class="fa-solid fa-circle-check"></i> Scene is ready.</li>'
    openDialog({
      id: 'lpc-bridge-scene-setup',
      title: `Client Scene · ${scene.name}`,
      width: 680,
      content: `<div class="foundry-bridge-authoring fb-form fb-scene-setup">
        <p class="notes">Foundry is the source of truth. The background, token art, tiles, walls, doors, grid, visibility, and actor disposition work automatically.</p>
        <div class="fb-scene-summary"><strong>${report.stats.tokens || 0}</strong> tokens · <strong>${report.stats.tiles || 0}</strong> tiles · <strong>${report.stats.walls || 0}</strong> walls · <strong>${report.stats.doors || 0}</strong> doors · <strong>${report.stats.npcs || 0}</strong> NPCs</div>
        <ul class="fb-validation-list">${issueRows}</ul>
        <fieldset><legend>Playable characters</legend><div class="fb-checkboxes">${characterRows}</div></fieldset>
        <div class="form-group"><label>Camera</label><select name="cameraPreset">${options(['follow', 'locked', 'top-down'], config.camera?.preset || 'follow')}</select></div>
        <label class="checkbox"><input name="enabled" type="checkbox" ${checked(config.enabled !== false)} /> Available in player client</label>
      </div>`,
      buttons: [
        { action: 'prepare', icon: 'fa-solid fa-play', label: 'Prepare and Publish', default: true, callback: async (_event, button) => {
          const data = formData(button)
          const selectedIds = new Set(data.getAll('playable').map(String))
          await scene.setFlag(MODULE_ID, 'world2d', { ...config, enabled: data.has('enabled'), camera: { ...config.camera, preset: data.get('cameraPreset') || 'follow' } })
          await Promise.all([...scene.tokens].filter((token) => token.actor?.type === 'character').map((token) => {
            const entity = this.bridge.entity2d(token)
            return token.setFlag(MODULE_ID, 'entity2d', { ...entity, playerSelectable: selectedIds.has(token.id) })
          }))
          await Promise.all([...scene.tokens].map((token) => {
            const entity = this.bridge.entity2d(token)
            return entity.spriteId ? this.persistActorPrototype(token, entity) : null
          }))
          await this.bridge.pushSnapshot()
          ui.notifications?.info('Client scene prepared and published.')
        } },
        { action: 'preview', icon: 'fa-solid fa-mobile-screen', label: 'Open Player Preview', callback: () => window.open(`${this.bridge.gatewayHttp()}/?room=${encodeURIComponent(this.bridge.roomId)}`, '_blank', 'noopener') },
        { action: 'advanced', icon: 'fa-solid fa-sliders', label: 'Advanced', callback: () => this.openAdvanced() },
        { action: 'close', label: 'Close' },
      ],
    })
  }

  openAdvanced() {
    openDialog({
      id: 'lpc-bridge-advanced', title: 'Client Scene · Advanced', width: 540,
      content: '<div class="foundry-bridge-authoring"><p>Use these only when Foundry defaults need an explicit client override.</p><div class="fb-advanced-actions"><button type="button" data-advanced="scene">Scene visuals and camera</button><button type="button" data-advanced="entity">Selected token/tile override</button><button type="button" data-advanced="assets">LPC sprite library</button></div></div>',
      buttons: [{ action: 'close', label: 'Close' }],
      render: (_event, dialog) => formRoot(dialog).querySelectorAll('[data-advanced]').forEach((button) => button.addEventListener('click', () => {
        if (button.dataset.advanced === 'scene') this.openSceneSettings()
        if (button.dataset.advanced === 'entity') this.openEntityInspector()
        if (button.dataset.advanced === 'assets') this.openAssetRegistry()
      })),
    })
  }

  openSceneSettings() {
    const scene = this.bridge.activeScene()
    if (!scene) {
      ui.notifications?.warn('Open a Scene first.')
      return
    }
    const config = this.bridge.world2d(scene)
    const maps = this.registry.list().filter((asset) => MAP_KINDS.includes(asset.kind))
    openDialog({
      id: 'lpc-bridge-scene-settings',
      title: `LPC Scene Settings · ${scene.name}`,
      width: 620,
      content: `<div class="foundry-bridge-authoring fb-form">
        <div class="form-group"><label>Map sprite</label><select name="mapId">${assetOptions(maps, config.mapId, null, 'No map sprite')}</select></div>
        <div class="form-group"><label>Tileset ID</label><input name="tilesetId" value="${escape(config.tilesetId)}" placeholder="lpc.terrain-interior" /></div>
        <div class="form-group"><label>World units / grid square</label><input name="worldUnits" type="number" min="0.001" step="0.1" value="${config.unitsPerGridSquare}" /></div>
        <fieldset><legend>Lighting tint</legend>
          <div class="form-group"><label>Preset</label><select name="lightingPreset">${options(['day', 'sunset', 'night', 'interior', 'custom'], config.lighting?.preset || 'day')}</select></div>
          <div class="fb-vector fb-vector-2"><label>Ambient<input name="ambient" type="number" min="0" step="0.05" value="${number(config.lighting?.ambient, 1)}" /></label><label>Color<input name="lightColor" type="color" value="${escape(config.lighting?.color || '#ffffff')}" /></label></div>
        </fieldset>
        <fieldset><legend>Fog overlay</legend>
          <label class="checkbox"><input name="fogEnabled" type="checkbox" ${checked(config.fog?.enabled)} /> Enabled</label>
          <div class="fb-vector fb-vector-2"><label>Density<input name="fogDensity" type="number" min="0" max="1" step="0.01" value="${number(config.fog?.density, 0.02)}" /></label><label>Color<input name="fogColor" type="color" value="${escape(config.fog?.color || '#b8c0c8')}" /></label></div>
        </fieldset>
        <div class="form-group"><label>Camera</label><select name="cameraPreset">${options(['follow', 'locked', 'top-down'], config.camera?.preset || 'follow')}</select></div>
      </div>`,
      buttons: [
        {
          action: 'save',
          icon: 'fa-solid fa-floppy-disk',
          label: 'Save and Sync',
          default: true,
          callback: async (_event, button) => {
            const data = formData(button)
            try {
              await scene.setFlag(MODULE_ID, 'world2d', {
                mapId: data.get('mapId') || null,
                tilesetId: data.get('tilesetId') || null,
                unitsPerGridSquare: Math.max(0.001, number(data.get('worldUnits'), 1)),
                lighting: {
                  preset: data.get('lightingPreset'),
                  ambient: number(data.get('ambient'), 1),
                  color: data.get('lightColor'),
                },
                fog: {
                  enabled: data.has('fogEnabled'),
                  density: number(data.get('fogDensity'), 0.02),
                  color: data.get('fogColor'),
                },
                camera: {
                  preset: data.get('cameraPreset'),
                },
              })
              this.bridge.pushSnapshot()
              ui.notifications?.info('LPC scene settings saved and synchronized.')
            } catch (error) {
              notifyError(error)
            }
          },
        },
        { action: 'cancel', label: 'Cancel' },
      ],
    })
  }

  selectedDocument() {
    return canvas?.tokens?.controlled?.[0]?.document || canvas?.tiles?.controlled?.[0]?.document || null
  }

  openEntityInspector(targetDocument = null) {
    const document = targetDocument || this.selectedDocument()
    if (!document) {
      ui.notifications?.warn('Select one Token or Tile first.')
      return
    }
    const config = this.bridge.entity2d(document)
    const assets = this.registry.list()
    openDialog({
      id: 'lpc-bridge-entity-inspector',
      title: `LPC Entity · ${document.name || document.documentName}`,
      width: 600,
      content: `<div class="foundry-bridge-authoring fb-form">
        <div class="form-group"><label>Sprite</label><select name="spriteId">${assetOptions(assets, config.spriteId)}</select></div>
        <div class="form-group"><label>Entity type</label><select name="entityType">${options(ENTITY_TYPES, config.entityType || (document.documentName === 'Token' ? 'actor' : 'prop'))}</select></div>
        <div class="form-group"><label>Facing</label><select name="facing">${options(FACINGS, config.facing || 'down')}</select></div>
        <fieldset><legend>Scale</legend><div class="fb-vector fb-vector-2"><label>X<input name="scaleX" type="number" step="0.01" value="${number(config.scale?.x, 1)}" /></label><label>Y<input name="scaleY" type="number" step="0.01" value="${number(config.scale?.y, 1)}" /></label></div></fieldset>
        <div class="form-group"><label>Controllers</label><input name="controllers" value="${escape((config.controllers || []).join(', '))}" placeholder="Arash, player-connection-id" /></div>
        <div class="fb-checkboxes"><label class="checkbox"><input name="visible" type="checkbox" ${checked(config.visible !== false)} /> Visible in client</label><label class="checkbox"><input name="selectable" type="checkbox" ${checked(config.selectable !== false)} /> Selectable</label><label class="checkbox"><input name="claimable" type="checkbox" ${checked(typeof config.playerSelectable === 'boolean' ? config.playerSelectable : (config.claimable || document.actor?.type === 'character'))} /> Playable character</label><label class="checkbox"><input name="freeform" type="checkbox" ${checked(config.interaction?.freeform !== false)} /> Freeform interaction</label></div>
      </div>`,
      buttons: [
        {
          action: 'save',
          icon: 'fa-solid fa-floppy-disk',
          label: 'Save and Sync',
          default: true,
          callback: async (_event, button) => {
            const data = formData(button)
            try {
              const entityConfig = {
                spriteId: data.get('spriteId') || null,
                entityType: data.get('entityType'),
                visible: data.has('visible'),
                selectable: data.has('selectable'),
                facing: data.get('facing') || 'down',
                scale: { x: number(data.get('scaleX'), 1), y: number(data.get('scaleY'), 1) },
                interaction: { freeform: data.has('freeform') },
                controllers: splitList(data.get('controllers')),
                claimable: data.has('claimable'),
                playerSelectable: data.has('claimable'),
              }
              await document.setFlag(MODULE_ID, 'entity2d', entityConfig)
              await this.persistActorPrototype(document, entityConfig)
              this.bridge.pushSnapshot()
              ui.notifications?.info(document.documentName === 'Token'
                ? 'Client sprite saved to this token and its actor prototype.'
                : 'Client entity saved and synchronized.')
            } catch (error) {
              notifyError(error)
            }
          },
        },
        { action: 'cancel', label: 'Cancel' },
      ],
    })
  }
}

function buttonTool(name, title, icon, action) {
  return {
    name,
    title,
    icon,
    button: true,
    visible: game.user?.isGM ?? false,
    onChange: () => action(),
  }
}

export function installAuthoring(bridge, registry) {
  const authoring = new AuthoringController(bridge, registry)
  const addClientConfigButton = (html, { label, action }) => {
    const root = formRoot(html)
    if (!root?.querySelector || root.querySelector('[data-fb-config-entry]')) return
    const footer = root.querySelector('footer') || root.querySelector('.form-footer') || root
    const block = document.createElement('div')
    block.className = 'form-group'
    block.dataset.fbConfigEntry = 'true'
    block.innerHTML = `<label>Player Client</label><div class="form-fields"><button type="button"><i class="fa-solid fa-gamepad"></i> ${escape(label)}</button></div>`
    block.querySelector('button').addEventListener('click', action)
    footer.parentElement?.insertBefore(block, footer)
  }
  Hooks.on('renderSceneConfig', (app, html) => addClientConfigButton(html, { label: 'Open Client Scene', action: () => authoring.openSceneSetup(app.document || app.object) }))
  Hooks.on('renderTokenConfig', (app, html) => addClientConfigButton(html, { label: 'Advanced Token Override', action: () => authoring.openEntityInspector(app.document || app.object) }))
  Hooks.on('renderTileConfig', (app, html) => addClientConfigButton(html, { label: 'Advanced Tile Override', action: () => authoring.openEntityInspector(app.document || app.object) }))
  Hooks.on('getSceneControlButtons', (controls) => {
    const gm = game.user?.isGM ?? false
    const tokenTools = ensureTools(sceneControlGroup(controls, 'tokens', 'token'))
    const tools = [
      buttonTool('bridge-monitor', 'Foundry Bridge: Live player table', 'fa-solid fa-satellite-dish', () => {
        bridge.openGmPanel?.()
      }),
      buttonTool('bridge-scene', 'Foundry Bridge: Client Scene', 'fa-solid fa-map', () => authoring.openSceneSetup()),
      buttonTool('bridge-advanced', 'Foundry Bridge: Advanced', 'fa-solid fa-sliders', () => authoring.openAdvanced()),
    ]
    const [monitor, scene, advanced] = tools

    let layer = sceneControlGroup(controls, 'bridge')
    if (!layer) {
      layer = {
        name: 'bridge',
        title: 'Foundry Bridge',
        icon: 'fa-solid fa-satellite-dish',
        visible: gm,
        order: 80,
        tools: Array.isArray(tokenTools) ? [] : {},
      }
      if (Array.isArray(controls)) controls.push(layer)
      else controls.bridge = layer
    }
    layer.visible = gm
    // This group contains only momentary dialog actions. Giving it an
    // activeTool makes Foundry treat that button as a persistent canvas tool,
    // leaving the control stuck between selected-tab and dialog states.
    delete layer.activeTool
    layer.tools = layer.tools || (Array.isArray(tokenTools) ? [] : {})
    for (const tool of tools) addTool(layer.tools, tool)

    void tokenTools
  })
  window.foundryBridgeAuthoring = authoring
}
