const MODULE_ID = '3d-bridge'

const ASSET_KINDS = ['character', 'creature', 'prop', 'building', 'environment', 'effect', 'other']
const ENTITY_TYPES = ['actor', 'npc', 'prop', 'door', 'container', 'terrain', 'effect', 'other']

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

function formRoot(html) {
  return html?.[0] || html
}

function formData(html) {
  return new FormData(formRoot(html).querySelector('form'))
}

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function fileStem(path) {
  const base = String(path || '').split(/[\\/]/).pop() || ''
  return base.replace(/\.[^.]+$/, '').trim()
}

/** Editable defaults derived from a model path, e.g. `models/Goblin_01.glb` → id/name. */
function fieldsFromModelPath(path) {
  const stem = fileStem(path)
  if (!stem) return { id: '', name: '' }
  return {
    id: slug(stem),
    name: stem.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim(),
  }
}

function splitList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean)
}

function options(values, current, emptyLabel = null) {
  const empty = emptyLabel == null ? '' : `<option value="">${escape(emptyLabel)}</option>`
  return empty + values.map((value) => `<option value="${escape(value)}" ${selected(current, value)}>${escape(value)}</option>`).join('')
}

function assetOptions(assets, current, kinds = null) {
  const filtered = kinds ? assets.filter((asset) => kinds.includes(asset.kind)) : assets
  return '<option value="">No prefab</option>' + filtered
    .map((asset) => `<option value="${escape(asset.id)}" ${selected(current, asset.id)}>${escape(asset.name)} · ${escape(asset.id)}</option>`)
    .join('')
}

function notifyError(error) {
  console.error(`${MODULE_ID} | Authoring error`, error)
  ui.notifications?.error(error?.message || 'Foundry Bridge authoring action failed.')
}

function bindFilePickers(html, { onPicked } = {}) {
  const root = formRoot(html)
  root.querySelectorAll('[data-file-target]').forEach((button) => {
    button.addEventListener('click', () => {
      const field = button.dataset.fileTarget
      const target = root.querySelector(`[name="${field}"]`)
      const Picker = foundry.applications?.apps?.FilePicker?.implementation || globalThis.FilePicker
      if (!Picker || !target) {
        ui.notifications?.warn('Foundry File Picker is unavailable.')
        return
      }
      new Picker({
        type: button.dataset.fileType || 'any',
        current: target.value,
        callback: (path) => {
          target.value = path
          target.dispatchEvent(new Event('change', { bubbles: true }))
          onPicked?.(field, path)
        },
      }).browse()
    })
  })
}

/**
 * Keep Asset ID / Name in sync with the model filename until the GM edits them.
 * Empty fields always accept a new suggestion; manually typed values are left alone.
 */
function bindAssetIdentityFromModel(html) {
  const root = formRoot(html)
  const idInput = root.querySelector('[name="id"]')
  const nameInput = root.querySelector('[name="name"]')
  const modelInput = root.querySelector('[name="modelUrl"]')
  if (!idInput || !nameInput || !modelInput) return

  const markManual = (input) => {
    input.dataset.autofill = '0'
  }
  const markAuto = (input) => {
    input.dataset.autofill = '1'
  }

  if (!idInput.value.trim()) markAuto(idInput)
  else markManual(idInput)
  if (!nameInput.value.trim()) markAuto(nameInput)
  else markManual(nameInput)

  idInput.addEventListener('input', () => markManual(idInput))
  nameInput.addEventListener('input', () => markManual(nameInput))

  const applyFromModel = () => {
    const derived = fieldsFromModelPath(modelInput.value)
    if (!derived.id) return
    if (idInput.dataset.autofill === '1') {
      idInput.value = derived.id
      markAuto(idInput)
    }
    if (nameInput.dataset.autofill === '1') {
      nameInput.value = derived.name
      markAuto(nameInput)
    }
  }

  modelInput.addEventListener('change', applyFromModel)
  modelInput.addEventListener('input', applyFromModel)
}

export class AssetRegistry {
  registerSetting() {
    game.settings.register(MODULE_ID, 'assetRegistry', {
      scope: 'world',
      config: false,
      type: Object,
      default: { version: 1, assets: [] },
    })
  }

  data() {
    const stored = game.settings.get(MODULE_ID, 'assetRegistry') || {}
    return {
      version: 1,
      assets: Array.isArray(stored.assets) ? stored.assets : [],
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
    if (!asset.modelUrl?.trim()) throw new Error('Model URL is required.')

    const data = this.data()
    const conflict = data.assets.find((entry) => entry.id === id && entry.id !== previousId)
    if (conflict) throw new Error(`Asset ID already exists: ${id}`)
    const normalized = {
      id,
      name: asset.name.trim(),
      kind: ASSET_KINDS.includes(asset.kind) ? asset.kind : 'other',
      modelUrl: asset.modelUrl.trim(),
      previewUrl: asset.previewUrl?.trim() || '',
      tags: Array.isArray(asset.tags) ? asset.tags : [],
      defaultEntityType: ENTITY_TYPES.includes(asset.defaultEntityType) ? asset.defaultEntityType : 'prop',
      defaultScale: {
        x: number(asset.defaultScale?.x, 1),
        y: number(asset.defaultScale?.y, 1),
        z: number(asset.defaultScale?.z, 1),
      },
      animationSetId: asset.animationSetId?.trim() || '',
      collider: asset.collider || { type: 'box' },
    }
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
          ${asset.previewUrl ? `<img src="${escape(asset.previewUrl)}" alt="" />` : '<i class="fas fa-cube"></i>'}
        </div>
        <div class="fb-asset-copy">
          <strong>${escape(asset.name)}</strong>
          <code>${escape(asset.id)}</code>
          <small>${escape(asset.kind)} · ${escape(asset.modelUrl)}</small>
        </div>
        <div class="fb-row-actions">
          <button type="button" data-action="place" title="Place in active scene"><i class="fas fa-location-dot"></i></button>
          <button type="button" data-action="edit" title="Edit"><i class="fas fa-pen"></i></button>
          <button type="button" data-action="delete" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </li>`).join('') : '<li class="fb-empty">No 3D assets registered yet.</li>'

    new Dialog({
      title: 'Foundry Bridge · Asset Registry',
      content: `<div class="foundry-bridge-authoring"><p>Logical prefabs used by external 3D clients.</p><ul class="fb-asset-list">${rows}</ul></div>`,
      buttons: {
        create: { icon: '<i class="fas fa-plus"></i>', label: 'New Asset', callback: () => this.openAssetEditor() },
        close: { icon: '<i class="fas fa-xmark"></i>', label: 'Close' },
      },
      default: 'create',
      render: (html) => {
        formRoot(html).querySelectorAll('[data-action]').forEach((button) => {
          button.addEventListener('click', async (event) => {
            const row = event.currentTarget.closest('[data-asset-id]')
            const id = row?.dataset.assetId
            const action = event.currentTarget.dataset.action
            const asset = this.registry.get(id)
            try {
              if (action === 'edit') this.openAssetEditor(asset)
              if (action === 'place') await this.placeAsset(asset)
              if (action === 'delete' && await Dialog.confirm({
                title: 'Delete 3D asset',
                content: `<p>Delete <strong>${escape(asset?.name)}</strong> from the registry?</p>`,
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
    }, { width: 720, height: 'auto' }).render(true)
  }

  openAssetEditor(asset = null) {
    const value = asset || {
      id: '',
      name: '',
      kind: 'prop',
      modelUrl: '',
      previewUrl: '',
      tags: [],
      defaultEntityType: 'prop',
      defaultScale: { x: 1, y: 1, z: 1 },
      animationSetId: '',
      collider: { type: 'box' },
    }
    new Dialog({
      title: asset ? `Edit Asset · ${asset.name}` : 'Register 3D Asset',
      content: `<form class="foundry-bridge-authoring fb-form">
        <div class="form-group"><label>Asset ID</label><input name="id" value="${escape(value.id)}" placeholder="auto from model filename" /><p class="notes">Filled from the model filename; edit anytime.</p></div>
        <div class="form-group"><label>Name</label><input name="name" value="${escape(value.name)}" placeholder="auto from model filename" /></div>
        <div class="form-group"><label>Kind</label><select name="kind">${options(ASSET_KINDS, value.kind)}</select></div>
        <div class="form-group stacked"><label>Model URL</label><div class="form-fields"><input name="modelUrl" value="${escape(value.modelUrl)}" placeholder="assets/models/goblin.glb" /><button type="button" class="file-picker" data-file-target="modelUrl" data-file-type="any" title="Browse Files"><i class="fas fa-file-import"></i></button></div><p class="notes">GLB/GLTF path or URL. Picking a file fills Asset ID and Name when those fields are still automatic.</p></div>
        <div class="form-group"><label>Preview image</label><div class="form-fields"><input name="previewUrl" value="${escape(value.previewUrl)}" placeholder="assets/previews/goblin.webp" /><button type="button" class="file-picker" data-file-target="previewUrl" data-file-type="image" title="Browse Files"><i class="fas fa-file-import"></i></button></div></div>
        <div class="form-group"><label>Entity type</label><select name="defaultEntityType">${options(ENTITY_TYPES, value.defaultEntityType)}</select></div>
        <fieldset><legend>Default scale</legend><div class="fb-vector"><label>X<input name="scaleX" type="number" step="0.01" value="${value.defaultScale.x}" /></label><label>Y<input name="scaleY" type="number" step="0.01" value="${value.defaultScale.y}" /></label><label>Z<input name="scaleZ" type="number" step="0.01" value="${value.defaultScale.z}" /></label></div></fieldset>
        <div class="form-group"><label>Animation set</label><input name="animationSetId" value="${escape(value.animationSetId)}" placeholder="quaternius.humanoid" /></div>
        <div class="form-group"><label>Collider</label><select name="collider"><option value="none" ${selected(value.collider?.type, 'none')}>None</option><option value="box" ${selected(value.collider?.type, 'box')}>Box</option><option value="capsule" ${selected(value.collider?.type, 'capsule')}>Capsule</option><option value="mesh" ${selected(value.collider?.type, 'mesh')}>Mesh</option></select></div>
        <div class="form-group"><label>Tags</label><input name="tags" value="${escape((value.tags || []).join(', '))}" placeholder="goblin, humanoid, enemy" /></div>
      </form>`,
      buttons: {
        save: {
          icon: '<i class="fas fa-floppy-disk"></i>',
          label: 'Save Asset',
          callback: async (html) => {
            const data = formData(html)
            try {
              const modelUrl = String(data.get('modelUrl') || '').trim()
              const derived = fieldsFromModelPath(modelUrl)
              const saved = await this.registry.upsert({
                id: String(data.get('id') || '').trim() || derived.id,
                name: String(data.get('name') || '').trim() || derived.name || derived.id,
                kind: data.get('kind'),
                modelUrl,
                previewUrl: data.get('previewUrl'),
                tags: splitList(data.get('tags')),
                defaultEntityType: data.get('defaultEntityType'),
                defaultScale: { x: data.get('scaleX'), y: data.get('scaleY'), z: data.get('scaleZ') },
                animationSetId: data.get('animationSetId'),
                collider: { type: data.get('collider') },
              }, asset?.id)
              ui.notifications?.info(`3D asset saved: ${saved.name}`)
              this.bridge.pushSnapshot()
            } catch (error) {
              notifyError(error)
            }
          },
        },
        cancel: { label: 'Cancel' },
      },
      default: 'save',
      render: (html) => {
        bindFilePickers(html)
        bindAssetIdentityFromModel(html)
      },
    }, { width: 620 }).render(true)
  }

  async placeAsset(asset) {
    if (!asset) throw new Error('Asset no longer exists.')
    const scene = this.bridge.activeScene()
    if (!scene) throw new Error('Open a Scene before placing an asset.')
    const grid = this.bridge.gridSize(scene)
    const center = canvas?.stage?.pivot || { x: scene.width / 2, y: scene.height / 2 }
    const [tile] = await scene.createEmbeddedDocuments('Tile', [{
      x: Math.round(center.x - grid / 2),
      y: Math.round(center.y - grid / 2),
      width: grid,
      height: grid,
      texture: { src: asset.previewUrl || 'icons/svg/cube.svg' },
      flags: {
        [MODULE_ID]: {
          entity3d: {
            prefabId: asset.id,
            entityType: asset.defaultEntityType,
            visible: true,
            selectable: true,
            rotation: { x: 0, y: 0, z: 0 },
            scale: asset.defaultScale,
            heightOffset: 0,
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

  openSceneSettings() {
    const scene = this.bridge.activeScene()
    if (!scene) {
      ui.notifications?.warn('Open a Scene first.')
      return
    }
    const config = this.bridge.world3d(scene)
    const environments = this.registry.list().filter((asset) => ['environment', 'building'].includes(asset.kind))
    new Dialog({
      title: `3D Scene Settings · ${scene.name}`,
      content: `<form class="foundry-bridge-authoring fb-form">
        <div class="form-group"><label>Environment prefab</label><select name="environmentId">${assetOptions(environments, config.environmentId)}</select></div>
        <div class="form-group"><label>Skybox ID</label><input name="skyboxId" value="${escape(config.skyboxId)}" placeholder="sky.clear-day" /></div>
        <div class="form-group"><label>World units / grid square</label><input name="worldUnits" type="number" min="0.001" step="0.1" value="${config.worldUnitsPerGridSquare}" /></div>
        <fieldset><legend>Lighting</legend>
          <div class="form-group"><label>Preset</label><select name="lightingPreset">${options(['day', 'sunset', 'night', 'interior', 'custom'], config.lighting?.preset || 'day')}</select></div>
          <div class="fb-vector"><label>Ambient<input name="ambient" type="number" min="0" step="0.05" value="${number(config.lighting?.ambient, 0.6)}" /></label><label>Sun<input name="sun" type="number" min="0" step="0.05" value="${number(config.lighting?.sun, 1)}" /></label><label>Color<input name="lightColor" type="color" value="${escape(config.lighting?.color || '#ffffff')}" /></label></div>
        </fieldset>
        <fieldset><legend>Fog</legend>
          <label class="checkbox"><input name="fogEnabled" type="checkbox" ${checked(config.fog?.enabled)} /> Enabled</label>
          <div class="fb-vector"><label>Density<input name="fogDensity" type="number" min="0" max="1" step="0.01" value="${number(config.fog?.density, 0.02)}" /></label><label>Color<input name="fogColor" type="color" value="${escape(config.fog?.color || '#b8c0c8')}" /></label></div>
        </fieldset>
        <fieldset><legend>Default camera</legend>
          <div class="form-group"><label>Preset</label><select name="cameraPreset">${options(['isometric', 'top-down', 'follow', 'custom'], config.camera?.preset || 'isometric')}</select></div>
          <div class="fb-vector"><label>Pitch<input name="pitch" type="number" step="1" value="${number(config.camera?.pitch, 45)}" /></label><label>Yaw<input name="yaw" type="number" step="1" value="${number(config.camera?.yaw, 45)}" /></label><label>Distance<input name="distance" type="number" min="0.1" step="0.5" value="${number(config.camera?.distance, 12)}" /></label></div>
        </fieldset>
      </form>`,
      buttons: {
        save: {
          icon: '<i class="fas fa-floppy-disk"></i>',
          label: 'Save and Sync',
          callback: async (html) => {
            const data = formData(html)
            try {
              await scene.setFlag(MODULE_ID, 'world3d', {
                environmentId: data.get('environmentId') || null,
                skyboxId: data.get('skyboxId') || null,
                worldUnitsPerGridSquare: Math.max(0.001, number(data.get('worldUnits'), 1)),
                lighting: {
                  preset: data.get('lightingPreset'),
                  ambient: number(data.get('ambient'), 0.6),
                  sun: number(data.get('sun'), 1),
                  color: data.get('lightColor'),
                },
                fog: {
                  enabled: data.has('fogEnabled'),
                  density: number(data.get('fogDensity'), 0.02),
                  color: data.get('fogColor'),
                },
                camera: {
                  preset: data.get('cameraPreset'),
                  pitch: number(data.get('pitch'), 45),
                  yaw: number(data.get('yaw'), 45),
                  distance: number(data.get('distance'), 12),
                },
              })
              this.bridge.pushSnapshot()
              ui.notifications?.info('3D Scene settings saved and synchronized.')
            } catch (error) {
              notifyError(error)
            }
          },
        },
        cancel: { label: 'Cancel' },
      },
      default: 'save',
    }, { width: 620 }).render(true)
  }

  selectedDocument() {
    return canvas?.tokens?.controlled?.[0]?.document || canvas?.tiles?.controlled?.[0]?.document || null
  }

  openEntityInspector() {
    const document = this.selectedDocument()
    if (!document) {
      ui.notifications?.warn('Select one Token or Tile first.')
      return
    }
    const config = this.bridge.entity3d(document)
    const assets = this.registry.list()
    new Dialog({
      title: `3D Entity · ${document.name || document.documentName}`,
      content: `<form class="foundry-bridge-authoring fb-form">
        <div class="form-group"><label>Prefab</label><select name="prefabId">${assetOptions(assets, config.prefabId)}</select></div>
        <div class="form-group"><label>Entity type</label><select name="entityType">${options(ENTITY_TYPES, config.entityType || (document.documentName === 'Token' ? 'actor' : 'prop'))}</select></div>
        <fieldset><legend>Rotation (degrees)</legend><div class="fb-vector"><label>X<input name="rotationX" type="number" step="1" value="${number(config.rotation?.x, 0)}" /></label><label>Y<input name="rotationY" type="number" step="1" value="${number(config.rotation?.y, 0)}" /></label><label>Z<input name="rotationZ" type="number" step="1" value="${number(config.rotation?.z, 0)}" /></label></div></fieldset>
        <fieldset><legend>Scale</legend><div class="fb-vector"><label>X<input name="scaleX" type="number" step="0.01" value="${number(config.scale?.x, 1)}" /></label><label>Y<input name="scaleY" type="number" step="0.01" value="${number(config.scale?.y, 1)}" /></label><label>Z<input name="scaleZ" type="number" step="0.01" value="${number(config.scale?.z, 1)}" /></label></div></fieldset>
        <div class="form-group"><label>Height offset</label><input name="heightOffset" type="number" step="0.1" value="${number(config.heightOffset, 0)}" /></div>
        <div class="form-group"><label>Controllers</label><input name="controllers" value="${escape((config.controllers || []).join(', '))}" placeholder="Arash, player-connection-id" /></div>
        <div class="fb-checkboxes"><label class="checkbox"><input name="visible" type="checkbox" ${checked(config.visible !== false)} /> Visible in client</label><label class="checkbox"><input name="selectable" type="checkbox" ${checked(config.selectable !== false)} /> Selectable</label><label class="checkbox"><input name="freeform" type="checkbox" ${checked(config.interaction?.freeform !== false)} /> Freeform interaction</label></div>
      </form>`,
      buttons: {
        save: {
          icon: '<i class="fas fa-floppy-disk"></i>',
          label: 'Save and Sync',
          callback: async (html) => {
            const data = formData(html)
            try {
              await document.setFlag(MODULE_ID, 'entity3d', {
                prefabId: data.get('prefabId') || null,
                entityType: data.get('entityType'),
                visible: data.has('visible'),
                selectable: data.has('selectable'),
                rotation: { x: number(data.get('rotationX'), 0), y: number(data.get('rotationY'), 0), z: number(data.get('rotationZ'), 0) },
                scale: { x: number(data.get('scaleX'), 1), y: number(data.get('scaleY'), 1), z: number(data.get('scaleZ'), 1) },
                heightOffset: number(data.get('heightOffset'), 0),
                interaction: { freeform: data.has('freeform') },
                controllers: splitList(data.get('controllers')),
              })
              this.bridge.pushSnapshot()
              ui.notifications?.info('3D entity saved and synchronized.')
            } catch (error) {
              notifyError(error)
            }
          },
        },
        cancel: { label: 'Cancel' },
      },
      default: 'save',
    }, { width: 600 }).render(true)
  }
}

/**
 * Foundry v12: controls is an array; tools is an array; clicks use onClick.
 * Foundry v13+: controls is a Record keyed by name (tokens/tiles); tools is a
 * Record; clicks use onChange and each tool needs an order.
 */
function resolveControl(controls, ...names) {
  if (Array.isArray(controls)) {
    return controls.find((control) => names.includes(control.name)) || null
  }
  for (const name of names) {
    if (controls?.[name]) return controls[name]
  }
  return null
}

function addTool(control, tool) {
  if (!control?.tools) return
  const tools = control.tools
  const order = Array.isArray(tools) ? tools.length : Object.keys(tools).length
  const activate = typeof tool.onChange === 'function' ? tool.onChange : tool.onClick
  const entry = {
    name: tool.name,
    title: tool.title,
    icon: tool.icon,
    button: true,
    order: Number.isFinite(tool.order) ? tool.order : order,
    visible: tool.visible ?? !!game.user?.isGM,
  }
  // v13 calls onChange and still forwards deprecated onClick — never set both.
  if (Array.isArray(tools)) {
    entry.onClick = activate
    tools.push(entry)
  } else {
    entry.onChange = (_event, active) => {
      if (active === false) return
      activate?.()
    }
    tools[entry.name] = entry
  }
}

export function installAuthoring(bridge, registry) {
  const authoring = new AuthoringController(bridge, registry)
  window.foundryBridgeAuthoring = authoring

  // Register during init/setup so the hook exists before SceneControls builds.
  Hooks.on('getSceneControlButtons', (controls) => {
    const tokenControls = resolveControl(controls, 'tokens', 'token')
    const tileControls = resolveControl(controls, 'tiles', 'tile')
    if (!tokenControls) {
      console.warn(`${MODULE_ID} | Token scene controls missing; Bridge toolbar tools were not added.`)
      return
    }

    addTool(tokenControls, {
      name: 'bridge-assets',
      title: 'Foundry Bridge: 3D Asset Registry',
      icon: 'fa-solid fa-cubes',
      onChange: () => authoring.openAssetRegistry(),
    })
    addTool(tokenControls, {
      name: 'bridge-scene',
      title: 'Foundry Bridge: 3D Scene Settings',
      icon: 'fa-solid fa-mountain-sun',
      onChange: () => authoring.openSceneSettings(),
    })
    const openInspector = () => authoring.openEntityInspector()
    addTool(tokenControls, {
      name: 'bridge-entity',
      title: 'Foundry Bridge: Selected Entity 3D Inspector',
      icon: 'fa-solid fa-cube',
      onChange: openInspector,
    })
    if (tileControls) {
      addTool(tileControls, {
        name: 'bridge-entity',
        title: 'Foundry Bridge: Selected Entity 3D Inspector',
        icon: 'fa-solid fa-cube',
        onChange: openInspector,
      })
    }
    addTool(tokenControls, {
      name: 'bridge-sync',
      title: 'Foundry Bridge: Reconnect and push 3D world',
      icon: 'fa-solid fa-plug',
      onChange: () => {
        bridge.connect()
        setTimeout(() => bridge.pushSnapshot(), 400)
      },
    })
  })
}

/** Rebuild left-rail SceneControls after tools are registered (safe no-op if already current). */
export function refreshSceneControls() {
  try {
    ui.controls?.initialize?.()
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not refresh SceneControls`, error)
  }
}
