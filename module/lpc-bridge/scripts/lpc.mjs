/** Universal LPC layout from https://liberatedpixelcup.github.io/Universal-LPC-Spritesheet-Character-Generator */

export const LPC_FRAME = 64
export const LPC_DIRS = ['up', 'left', 'down', 'right']
export const LPC_DIR_INDEX = Object.freeze({ up: 0, left: 1, down: 2, right: 3 })
export const LEGACY_DIRS = ['down', 'left', 'right', 'up']
export const LPC_KINDS = ['character', 'creature', 'effect']

/** Expanded composite sheet: 54 rows. Classic LPC is the first 21 rows. */
export const LPC_ANIMATIONS = Object.freeze([
  { name: 'spellcast', row: 0, dirs: 4, frames: 7, fps: 8, oneshot: true },
  { name: 'thrust', row: 4, dirs: 4, frames: 8, fps: 10, oneshot: true },
  { name: 'walk', row: 8, dirs: 4, frames: 9, fps: 9, loop: true, skipFirst: true },
  { name: 'slash', row: 12, dirs: 4, frames: 6, fps: 10, oneshot: true },
  { name: 'shoot', row: 16, dirs: 4, frames: 13, fps: 12, oneshot: true },
  { name: 'hurt', row: 20, dirs: 1, frames: 6, fps: 8, oneshot: true },
  { name: 'climb', row: 21, dirs: 1, frames: 6, fps: 8, loop: true },
  { name: 'idle', row: 22, dirs: 4, frames: 2, fps: 2, loop: true },
  { name: 'jump', row: 26, dirs: 4, frames: 5, fps: 8, oneshot: true },
  { name: 'sit', row: 30, dirs: 4, frames: 3, fps: 2, oneshot: true },
  { name: 'emote', row: 34, dirs: 4, frames: 3, fps: 4, oneshot: true },
  { name: 'run', row: 38, dirs: 4, frames: 8, fps: 12, loop: true },
  { name: 'combat_idle', row: 42, dirs: 4, frames: 2, fps: 2, loop: true },
  { name: 'backslash', row: 46, dirs: 4, frames: 13, fps: 12, oneshot: true },
  { name: 'halfslash', row: 50, dirs: 4, frames: 7, fps: 10, oneshot: true },
])

export const LPC_ANIMATION_NAMES = LPC_ANIMATIONS.map((anim) => anim.name)

export function detectLpcLayout(width, height, frameSize = LPC_FRAME) {
  const size = Number(frameSize) || LPC_FRAME
  const rows = Math.floor(Number(height) / size)
  const cols = Math.floor(Number(width) / size)
  if (rows >= 54 && cols >= 7) return 'expanded'
  if (rows >= 21 && cols >= 6) return 'classic'
  return 'custom'
}

export function lpcAnimsForSheet(width, height, frameSize = LPC_FRAME) {
  const size = Number(frameSize) || LPC_FRAME
  const rows = Math.max(1, Math.floor(Number(height) / size))
  const cols = Math.max(1, Math.floor(Number(width) / size))
  return LPC_ANIMATIONS
    .filter((anim) => anim.row + anim.dirs <= rows)
    .map((anim) => ({ ...anim, cols, frameSize: size }))
}

export function packedAnims(width, height, frameSize = LPC_FRAME, requested = []) {
  const size = Number(frameSize) || LPC_FRAME
  const rows = Math.max(1, Math.floor(Number(height) / size))
  const cols = Math.max(1, Math.floor(Number(width) / size))
  const names = (requested || []).map((name) => String(name).trim()).filter(Boolean)
  if (!names.length && rows >= 4 && cols < 6) return []
  const catalog = names.length
    ? names.map((name) => LPC_ANIMATIONS.find((anim) => anim.name === name)).filter(Boolean)
    : rows === 1
      ? LPC_ANIMATIONS.filter((anim) => anim.name === 'hurt')
      : LPC_ANIMATIONS.filter((anim) => anim.name === 'walk')
  let row = 0
  const result = []
  for (const anim of catalog) {
    if (row + anim.dirs > rows) break
    result.push({ ...anim, row, cols, frameSize: size, packed: true })
    row += anim.dirs
  }
  return result
}

export function withIdleFallback(anims) {
  const list = [...(anims || [])]
  if (list.some((anim) => anim.name === 'idle')) return list
  const walk = list.find((anim) => anim.name === 'walk')
  if (!walk) return list
  list.push({
    name: 'idle',
    row: walk.row,
    dirs: 4,
    frames: 1,
    fps: 1,
    loop: true,
    cols: walk.cols,
    frameSize: walk.frameSize,
  })
  return list
}

export function resolveSheetAnims(width, height, registry = {}) {
  const frameSize = Number(registry.frameSize?.width || registry.frameSize || LPC_FRAME) || LPC_FRAME
  const layout = registry.layout || 'auto'
  const kind = registry.kind || 'character'
  const detected = detectLpcLayout(width, height, frameSize)
  const wantsLpc = layout === 'lpc' || layout === 'classic' || layout === 'expanded'
    || (layout === 'auto' && (detected !== 'custom' || LPC_KINDS.includes(kind)))

  if (layout === 'custom' || !wantsLpc) return { mode: 'legacy', layout: detected, anims: [] }

  if (detected === 'classic' || detected === 'expanded') {
    return { mode: 'lpc', layout: detected, anims: withIdleFallback(lpcAnimsForSheet(width, height, frameSize)) }
  }

  const packed = packedAnims(width, height, frameSize, registry.animations)
  if (packed.length) return { mode: 'lpc', layout: 'packed', anims: withIdleFallback(packed) }
  return { mode: 'legacy', layout: detected, anims: [] }
}

export function frameRange(anim, facing, cols) {
  const columns = Number(cols) || anim.cols || 13
  const dir = anim.dirs === 1 ? 0 : (LPC_DIR_INDEX[facing] ?? LPC_DIR_INDEX.down)
  const row = anim.row + dir
  const lastCol = Math.min(anim.frames, columns) - 1
  const firstCol = anim.skipFirst && lastCol > 0 ? 1 : 0
  return {
    first: row * columns + firstCol,
    last: row * columns + lastCol,
    row,
    dir,
  }
}

export function resolveAnim(available, requested, { inCombat = false } = {}) {
  const names = new Set((available || []).map((anim) => anim.name || anim))
  const pick = (...candidates) => candidates.find((name) => names.has(name)) || null
  if (requested === 'idle') return pick(inCombat ? 'combat_idle' : 'idle', 'idle', 'combat_idle', 'walk') || 'idle'
  if (requested === 'walk') return pick('walk', 'run') || 'walk'
  if (requested === 'run') return pick('run', 'walk') || 'run'
  if (requested === 'slash') return pick('slash', 'halfslash', 'backslash', 'thrust') || 'slash'
  if (requested === 'spellcast') return pick('spellcast', 'emote') || 'spellcast'
  if (requested === 'shoot') return pick('shoot', 'thrust', 'slash') || 'shoot'
  if (requested === 'hurt') return pick('hurt') || 'hurt'
  if (requested === 'thrust' || requested === 'watering') return pick('thrust', 'slash') || 'thrust'
  if (requested === 'combat_idle') return pick('combat_idle', 'idle', 'walk') || 'idle'
  return pick(requested, 'idle', 'walk') || requested
}

export function actionAnimFor(action = {}) {
  const blob = `${action.type || ''} ${action.name || ''} ${action.activation || ''}`.toLowerCase()
  if (action.type === 'spell' || /\bspell|cantrip|cast\b/.test(blob)) return 'spellcast'
  if (/\bbow|longbow|shortbow|crossbow|gun|sling|dart|javelin|thrown|ranged\b/.test(blob)) return 'shoot'
  if (/\bspear|pike|lance|trident|halberd|staff\b/.test(blob)) return 'thrust'
  if (action.type === 'weapon') return 'slash'
  if (action.type === 'feat') return 'emote'
  return 'slash'
}

export function animKey(spriteId, name, facing) {
  const anim = LPC_ANIMATIONS.find((entry) => entry.name === name)
  if (anim?.dirs === 1) return `${spriteId}-${name}`
  return `${spriteId}-${name}-${facing || 'down'}`
}
