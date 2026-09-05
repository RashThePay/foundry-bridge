import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LPC_ANIMATIONS,
  actionAnimFor,
  detectLpcLayout,
  frameRange,
  lpcAnimsForSheet,
  packedAnims,
  resolveAnim,
  resolveSheetAnims,
  withIdleFallback,
} from '../module/lpc-bridge/scripts/lpc.mjs'
import { actionCatalog, executeActivityWithoutDialogs, installBridgeChatNotificationFilter, normalizeRollOptions, resolveFastActivity } from '../module/lpc-bridge/scripts/actions.mjs'
import { isPlayableToken, migrateEntity2d, migrateWorld2d, movementAnimationSpeed } from '../module/lpc-bridge/scripts/snapshot.mjs'

test('detects expanded and classic Universal LPC sheets', () => {
  assert.equal(detectLpcLayout(13 * 64, 54 * 64), 'expanded')
  assert.equal(detectLpcLayout(13 * 64, 21 * 64), 'classic')
  assert.equal(detectLpcLayout(256, 256), 'custom')
})

test('walk-down uses LPC row order up/left/down/right and skips the standing frame', () => {
  const walk = LPC_ANIMATIONS.find((anim) => anim.name === 'walk')
  const range = frameRange(walk, 'down', 13)
  assert.equal(range.row, 10)
  assert.equal(range.first, 10 * 13 + 1)
  assert.equal(range.last, 10 * 13 + 8)
})

test('classic 21-row sheets still expose spellcast through hurt', () => {
  const names = lpcAnimsForSheet(13 * 64, 21 * 64).map((anim) => anim.name)
  assert.deepEqual(names, ['spellcast', 'thrust', 'walk', 'slash', 'shoot', 'hurt'])
})

test('classic sheets synthesize idle from the walk standing frame', () => {
  const anims = withIdleFallback(lpcAnimsForSheet(13 * 64, 21 * 64))
  const idle = anims.find((anim) => anim.name === 'idle')
  const walk = anims.find((anim) => anim.name === 'walk')
  assert.equal(idle.row, walk.row)
  assert.equal(idle.frames, 1)
})

test('packed walk-only exports keep LPC direction order', () => {
  const [walk] = packedAnims(9 * 64, 4 * 64, 64, [])
  assert.equal(walk.name, 'walk')
  assert.equal(walk.row, 0)
  const down = frameRange(walk, 'down', 9)
  assert.equal(down.row, 2)
  assert.equal(down.first, 2 * 9 + 1)
})

test('expanded sheets create idle and combat_idle from the generator rows', () => {
  const names = lpcAnimsForSheet(13 * 64, 54 * 64).map((anim) => anim.name)
  assert.ok(names.includes('idle'))
  assert.ok(names.includes('combat_idle'))
  assert.ok(names.includes('run'))
  assert.equal(names.at(-1), 'halfslash')
})

test('auto layout uses Universal LPC rows for generator sheets', () => {
  const resolved = resolveSheetAnims(13 * 64, 54 * 64, { kind: 'character', layout: 'auto' })
  assert.equal(resolved.mode, 'lpc')
  assert.equal(resolved.layout, 'expanded')
  assert.ok(resolved.anims.some((anim) => anim.name === 'slash'))
})

test('small portraits are not treated as packed LPC walk sheets', () => {
  const resolved = resolveSheetAnims(256, 256, { kind: 'character', layout: 'auto', frameSize: { width: 64, height: 64 } })
  assert.equal(resolved.mode, 'legacy')
})

test('action mapping picks LPC combat animations', () => {
  assert.equal(actionAnimFor({ type: 'spell', name: 'Fire Bolt' }), 'spellcast')
  assert.equal(actionAnimFor({ type: 'weapon', name: 'Longbow' }), 'shoot')
  assert.equal(actionAnimFor({ type: 'weapon', name: 'Spear' }), 'thrust')
  assert.equal(actionAnimFor({ type: 'weapon', name: 'Longsword' }), 'slash')
})

test('idle falls back to combat_idle or walk when missing', () => {
  assert.equal(resolveAnim(['walk'], 'idle'), 'walk')
  assert.equal(resolveAnim(['combat_idle', 'walk'], 'idle', { inCombat: true }), 'combat_idle')
})

test('standard character tokens are playable unless scene setup explicitly disables them', () => {
  const character = { actor: { type: 'character' } }
  assert.equal(isPlayableToken(character, {}), true)
  assert.equal(isPlayableToken(character, { playerSelectable: false }), false)
  assert.equal(isPlayableToken({ actor: { type: 'npc' } }, { playerSelectable: true }), true)
})

test('2D migrations preserve simple scene and character overrides', () => {
  assert.equal(migrateWorld2d({ enabled: false }).enabled, false)
  assert.equal(migrateEntity2d({ playerSelectable: false }).playerSelectable, false)
})

test('client walking speed follows dnd5e movement over a six-second round', () => {
  assert.equal(movementAnimationSpeed({ movement: { walk: 30 }, gridDistance: 5, roundSeconds: 6, worldUnits: 1 }), 1)
  assert.equal(movementAnimationSpeed({ movement: { walk: 60 }, gridDistance: 5, roundSeconds: 6, worldUnits: 1 }), 2)
  assert.equal(movementAnimationSpeed({ movement: {}, gridDistance: 5, roundSeconds: 6, worldUnits: 1 }), 1)
})

test('action catalog hides passive equipment and gives playable activities game metadata', () => {
  const actor = {
    system: { spells: { spell1: { value: 0, max: 2 } } },
    items: [
      { id: 'armor', name: 'Leather Armor', type: 'equipment', system: { equipped: true, activities: { contents: [{ id: 'ench', name: 'Use', type: 'enchant', use() {} }] } } },
      { id: 'sword', name: 'Longsword', img: 'icons/weapons/swords/longsword.webp', type: 'weapon', system: { equipped: true, activities: { contents: [{ id: 'hit', name: 'Attack', img: 'systems/dnd5e/icons/svg/activity/attack.svg', type: 'attack', activation: { type: 'action' }, target: { affects: { type: 'creature', count: 1 } }, range: { value: 5, units: 'ft' }, uses: { value: 0, max: 0 }, use() {} }] } } },
      { id: 'spell', name: 'Magic Missile', type: 'spell', system: { level: 1, preparation: { mode: 'prepared', prepared: true }, activities: { contents: [{ id: 'cast', name: 'Damage', type: 'damage', activation: { type: 'action' }, use() {} }] } } },
    ],
  }
  const catalog = actionCatalog(actor)
  assert.deepEqual(catalog.map((entry) => entry.name), ['Longsword', 'Magic Missile'])
  assert.equal(catalog[0].uses, null)
  assert.equal(catalog[0].img, 'icons/weapons/swords/longsword.webp')
  assert.equal(catalog[0].target.requiresTarget, true)
  assert.equal(catalog[1].category, 'spell')
  assert.equal(catalog[1].available, false)
  assert.equal(catalog[1].unavailableReason, 'No spell slots')
})

test('client roll choices are normalized before entering dnd5e', () => {
  assert.deepEqual(normalizeRollOptions({ rollMode: 'advantage', bonus: '4' }), { rollMode: 'advantage', bonus: 4, channel: 'party' })
  assert.deepEqual(normalizeRollOptions({ rollMode: 'anything', bonus: 99, channel: 'private' }), { rollMode: 'normal', bonus: 20, channel: 'private' })
  assert.deepEqual(normalizeRollOptions({ rollMode: 'disadvantage', bonus: -99 }), { rollMode: 'disadvantage', bonus: -20, channel: 'party' })
})

test('remote attacks suppress Foundry dialogs and pass player roll choices explicitly', async () => {
  const calls = []
  const activity = {
    type: 'attack',
    async use(...args) {
      calls.push(['use', ...args])
      return { message: { id: 'message-1' } }
    },
    async rollAttack(...args) { calls.push(['rollAttack', ...args]) },
  }
  await executeActivityWithoutDialogs(activity, {
    targetUuids: ['Scene.scene.Token.target'],
    rollOptions: { rollMode: 'advantage', bonus: 3, channel: 'private' },
    connectionId: 'player-1',
  })
  assert.deepEqual(calls, [
    ['use', { subsequentActions: false, midiOptions: { targetUuids: ['Scene.scene.Token.target'] } }, { configure: false }, { data: { 'flags.lpc-bridge.remoteAction': true, 'flags.lpc-bridge.fromClient': true, 'flags.lpc-bridge.channel': 'private', 'flags.lpc-bridge.connectionId': 'player-1', sound: null }, rollMode: 'gmroll' }],
    ['rollAttack', { advantage: true, disadvantage: false, rolls: [{ parts: ['3'] }] }, { configure: false }, { data: { 'flags.lpc-bridge.remoteAction': true, 'flags.lpc-bridge.fromClient': true, 'flags.lpc-bridge.channel': 'private', 'flags.lpc-bridge.connectionId': 'player-1', sound: null, 'flags.dnd5e.originatingMessage': 'message-1', 'system.origin': 'message-1' }, rollMode: 'gmroll' }],
  ])
})

test('bridge action messages stay in Foundry chat without creating GM notification cards', async () => {
  const posted = []
  const chat = {
    async postOne(message, options) { posted.push([message, options]) },
  }
  assert.equal(installBridgeChatNotificationFilter(chat), true)
  const bridgeMessage = { getFlag: (scope, key) => scope === 'lpc-bridge' && key === 'fromClient' }
  const normalMessage = { getFlag: () => false }
  await chat.postOne(bridgeMessage, { notify: true, scroll: true })
  await chat.postOne(normalMessage, { notify: true })
  assert.deepEqual(posted[0][1], { notify: false, scroll: true })
  assert.deepEqual(posted[1][1], { notify: true })
  assert.equal(installBridgeChatNotificationFilter(chat), false)
})

test('fast mode applies attack damage only to targets the Foundry roll hits', async () => {
  const target = (id, ac) => ({
    id,
    name: id,
    actor: {
      system: { attributes: { ac: { value: ac }, hp: { value: 20 } } },
      async applyDamage(damages, { multiplier }) {
        this.system.attributes.hp.value -= damages.reduce((sum, entry) => sum + entry.value, 0) * multiplier
      },
    },
  })
  const hit = target('hit', 14)
  const miss = target('miss', 16)
  const result = await resolveFastActivity({
    type: 'attack',
    damage: { parts: [{ types: new Set(['slashing']) }] },
    item: { system: { properties: new Set(['mgc']) } },
  }, {
    usage: { message: {} },
    attackRolls: [{ total: 15 }],
    damageRolls: [{ total: 7 }],
  }, [hit, miss])
  assert.equal(hit.actor.system.attributes.hp.value, 13)
  assert.equal(miss.actor.system.attributes.hp.value, 20)
  assert.deepEqual(result.applied.map((entry) => [entry.tokenId, entry.hit, entry.hpDelta]), [
    ['hit', true, 7],
    ['miss', false, 0],
  ])
})

test('fast mode rolls target saves and applies configured half damage', async () => {
  const actor = {
    system: { attributes: { hp: { value: 20 } } },
    async rollSavingThrow() { return [{ total: 16 }] },
    async applyDamage(damages, { multiplier }) {
      this.system.attributes.hp.value -= damages[0].value * multiplier
    },
  }
  const result = await resolveFastActivity({
    type: 'save',
    save: { ability: new Set(['dex']), dc: { value: 14 } },
    damage: { onSave: 'half', parts: [{ types: new Set(['fire']) }] },
  }, {
    usage: { message: {} },
    attackRolls: [],
    damageRolls: [{ total: 10 }],
    rollMessage: {},
  }, [{ id: 'target', name: 'Target', actor, document: {} }])
  assert.equal(actor.system.attributes.hp.value, 15)
  assert.equal(result.saves[0].succeeded, true)
  assert.equal(result.applied[0].multiplier, 0.5)
})
