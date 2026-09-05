import { actionAnimFor } from './lpc.mjs'

function number(value, fallback = null) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function activityList(item) {
  const activities = item?.system?.activities
  if (!activities) return []
  if (typeof activities.contents !== 'undefined') return [...activities.contents]
  if (typeof activities === 'object') return Object.values(activities).filter((activity) => activity && activity.id)
  return []
}

function remainingUses(item, activity) {
  const uses = activity?.uses || item?.system?.uses
  if (!uses) return null
  const max = number(uses.max, null)
  if (!(max > 0)) return null
  return { value: number(uses.value, max), max }
}

export function normalizeRollOptions(value = {}) {
  const requestedMode = String(value.rollMode || 'normal').toLowerCase()
  const rollMode = ['normal', 'advantage', 'disadvantage'].includes(requestedMode) ? requestedMode : 'normal'
  const requestedBonus = number(value.bonus, 0)
  const bonus = Math.max(-20, Math.min(20, Math.trunc(requestedBonus)))
  const channel = value.channel === 'private' ? 'private' : 'party'
  return { rollMode, bonus, channel }
}

const REMOTE_ROLL_HOOKS = [
  'dnd5e.preUseActivity',
  'dnd5e.preRollAttack',
  'dnd5e.preRollAttackV2',
  'dnd5e.preRollDamage',
  'dnd5e.preRollDamageV2',
  'dnd5e.preRollD20Test',
  'dnd5e.preRollD20TestV2',
  'dnd5e.preRollSavingThrow',
  'dnd5e.preRollSavingThrowV2',
  'dnd5e.preRoll',
  'dnd5e.preRollV2',
]

export function installBridgeChatNotificationFilter(chat = globalThis.ui?.chat) {
  if (!chat?.postOne || chat._lpcBridgeNotificationFilter) return false
  const postOne = chat.postOne
  Object.defineProperty(chat, '_lpcBridgeNotificationFilter', { value: true, configurable: true })
  chat.postOne = function bridgePostOne(message, options = {}) {
    if (message?.getFlag?.('lpc-bridge', 'fromClient')) {
      return postOne.call(this, message, { ...(options || {}), notify: false })
    }
    return postOne.call(this, message, options)
  }
  return true
}

async function withRemoteRollGuard(callback) {
  if (!globalThis.Hooks?.on || !globalThis.Hooks?.off) return callback()
  const registrations = REMOTE_ROLL_HOOKS.map((name) => {
    const id = Hooks.on(name, (...args) => {
      // preUseActivity receives (activity, usage, dialog, message); all
      // preRoll hooks receive (config, dialog, message).
      const dialog = name === 'dnd5e.preUseActivity' ? args[2] : args[1]
      if (dialog) dialog.configure = false
    })
    return [name, id]
  })
  try {
    return await callback()
  } finally {
    for (const [name, id] of registrations) Hooks.off(name, id)
  }
}

export async function executeActivityWithoutDialogs(activity, { targetUuids = [], rollOptions = {}, connectionId = null } = {}) {
  const normalized = normalizeRollOptions(rollOptions)
  const messageMode = globalThis.CONST?.DICE_ROLL_MODES?.GMROLL || 'gmroll'
  return withRemoteRollGuard(async () => {
    const results = await activity.use({
      subsequentActions: false,
      midiOptions: { targetUuids },
    }, { configure: false }, {
      data: {
        'flags.lpc-bridge.remoteAction': true,
        'flags.lpc-bridge.fromClient': true,
        'flags.lpc-bridge.channel': normalized.channel,
        'flags.lpc-bridge.connectionId': connectionId,
        sound: null,
      },
      rollMode: messageMode,
    })
    const originatingMessage = {
      data: {
        'flags.lpc-bridge.remoteAction': true,
        'flags.lpc-bridge.fromClient': true,
        'flags.lpc-bridge.channel': normalized.channel,
        'flags.lpc-bridge.connectionId': connectionId,
        sound: null,
        ...(results?.message?.id ? {
          'flags.dnd5e.originatingMessage': results.message.id,
          'system.origin': results.message.id,
        } : {}),
      },
      rollMode: messageMode,
    }
    const type = String(activity.type || '').toLowerCase()
    let attackRolls = []
    let damageRolls = []
    try {
      if (type === 'attack' && activity.rollAttack) {
        const rollConfig = {
          advantage: normalized.rollMode === 'advantage',
          disadvantage: normalized.rollMode === 'disadvantage',
        }
        if (normalized.bonus) rollConfig.rolls = [{ parts: [String(normalized.bonus)] }]
        attackRolls = await activity.rollAttack(rollConfig, { configure: false }, originatingMessage) || []
        const attackRoll = Array.isArray(attackRolls) ? attackRolls[0] : attackRolls
        if (activity.rollDamage) {
          damageRolls = await activity.rollDamage({ isCritical: !!attackRoll?.isCritical }, { configure: false }, originatingMessage) || []
        }
      } else if (['damage', 'heal', 'save'].includes(type) && activity.rollDamage) {
        damageRolls = await activity.rollDamage({}, { configure: false }, originatingMessage) || []
      }
    } catch (error) {
      error.bridgeUsage = results
      throw error
    }
    return {
      usage: results,
      attackRolls: Array.isArray(attackRolls) ? attackRolls : [attackRolls].filter(Boolean),
      damageRolls: Array.isArray(damageRolls) ? damageRolls : [damageRolls].filter(Boolean),
      rollMessage: originatingMessage,
    }
  })
}

function firstOf(value) {
  if (value == null) return null
  if (typeof value.first === 'function') return value.first()
  if (value instanceof Set) return value.values().next().value ?? null
  if (Array.isArray(value)) return value[0] ?? null
  return value
}

function damageDescriptions(activity, rolls) {
  const parts = [...(activity?.damage?.parts || [])]
  const itemProperties = activity?.item?.system?.properties
  return (rolls || []).map((roll, index) => ({
    value: Number(roll?.total) || 0,
    type: roll?.options?.type || firstOf(parts[index]?.types) || firstOf(parts[index]?.type) || 'none',
    properties: new Set(roll?.options?.properties || itemProperties || []),
  }))
}

function hpState(actor) {
  const hp = actor?.system?.attributes?.hp
  return actor && hp ? {
    actor,
    actorUuid: actor.uuid,
    actorName: actor.name,
    hp: Number(hp.value) || 0,
    tempHp: Number(hp.temp) || 0,
    tempMax: Number(hp.tempmax) || 0,
  } : null
}

async function rollTargetSave(target, activity, originatingMessage) {
  const actor = target?.actor
  if (!actor?.rollSavingThrow) return null
  const ability = firstOf(activity?.save?.ability) || activity?.ability
  const dc = Number(activity?.save?.dc?.value)
  const speaker = globalThis.ChatMessage?.getSpeaker?.({ actor, scene: globalThis.canvas?.scene, token: target.document })
  const rolls = await withRemoteRollGuard(() => actor.rollSavingThrow({
    ability,
    target: Number.isFinite(dc) ? dc : undefined,
  }, { configure: false }, {
    ...originatingMessage,
    data: { ...(originatingMessage?.data || {}), ...(speaker ? { speaker } : {}) },
  }))
  const roll = Array.isArray(rolls) ? rolls[0] : rolls
  return { ability, dc, total: Number(roll?.total), succeeded: Number(roll?.total) >= dc }
}

function saveMultiplier(activity, succeeded) {
  if (!succeeded) return 1
  const onSave = String(activity?.damage?.onSave || 'half').toLowerCase()
  if (onSave === 'none') return 0
  if (onSave === 'full') return 1
  return 0.5
}

export async function resolveFastActivity(activity, execution, targets) {
  const type = String(activity?.type || '').toLowerCase()
  const damages = damageDescriptions(activity, execution.damageRolls)
  const applied = []
  const saves = []
  if (!damages.length || !targets.length) return { applied, saves }
  const attackRoll = execution.attackRolls[0]
  const attackTotal = Number(attackRoll?.total)
  const originatingMessage = execution.usage?.message
  for (const target of targets) {
    const targetActor = target.actor
    if (!targetActor?.applyDamage) continue
    const beforeHp = Number(targetActor.system?.attributes?.hp?.value)
    let multiplier = 1
    let hit = true
    if (type === 'attack') {
      const ac = Number(targetActor.system?.attributes?.ac?.value ?? targetActor.system?.attributes?.ac)
      hit = attackRoll?.isCritical === true || (attackRoll?.isFumble !== true && Number.isFinite(attackTotal)
        && (!Number.isFinite(ac) || attackTotal >= ac))
      if (!hit) multiplier = 0
    } else if (type === 'save') {
      const save = await rollTargetSave(target, activity, execution.rollMessage)
      if (!save || !Number.isFinite(save.total)) throw new Error(`${targetActor.name} could not roll the required saving throw.`)
      saves.push({ tokenId: target.id, ...save })
      multiplier = saveMultiplier(activity, save.succeeded)
    }
    if (multiplier > 0) {
      await targetActor.applyDamage(damages, {
        multiplier,
        origin: originatingMessage,
        originatingMessage,
        only: type === 'heal' ? 'healing' : 'damage',
      })
    }
    applied.push({
      tokenId: target.id,
      name: target.name || targetActor.name,
      hit,
      multiplier,
      hp: targetActor.system?.attributes?.hp?.value ?? null,
      hpDelta: Number.isFinite(beforeHp)
        ? beforeHp - Number(targetActor.system?.attributes?.hp?.value ?? beforeHp)
        : null,
    })
  }
  return { applied, saves }
}

const ACTION_ACTIVATIONS = new Set(['action', 'bonus', 'reaction', 'reactiondamage', 'reactionmanual', 'legendary', 'lair', 'special'])
const TARGET_TYPES = new Set(['creature', 'ally', 'enemy', 'object', 'space'])

function activationOf(item, activity) {
  const source = activity?.activation || item?.system?.activation || {}
  const type = String(source.type || '').toLowerCase()
  const value = number(source.value, type ? 1 : null)
  return { type: type || null, value }
}

function targetOf(item, activity) {
  const source = activity?.target || item?.system?.target || {}
  const affects = source.affects || source
  const template = source.template || {}
  const type = String(affects.type || '').toLowerCase()
  const count = number(affects.count, null)
  const templateType = template.type || null
  return {
    type: type || (templateType ? 'area' : 'none'),
    count,
    template: templateType,
    requiresTarget: TARGET_TYPES.has(type),
    self: type === 'self',
  }
}

function rangeOf(item, activity) {
  const source = activity?.range || item?.system?.range || {}
  return { value: number(source.value, null), units: source.units || null }
}

function spellResource(actor, item) {
  if (item?.type !== 'spell') return null
  const level = number(item.system?.level, 0)
  if (!level) return { label: 'Cantrip', value: null, max: null }
  const slot = actor?.system?.spells?.[`spell${level}`]
  if (!slot) return { label: `Level ${level}`, value: null, max: null }
  return { label: `Level ${level} slot`, value: number(slot.value, null), max: number(slot.max, null) }
}

function categoryOf(item, activation) {
  if (activation.type === 'bonus') return 'bonus'
  if (activation.type?.startsWith('reaction')) return 'reaction'
  if (item.type === 'spell') return 'spell'
  if (item.type === 'feat') return 'feature'
  if (['consumable', 'equipment', 'tool'].includes(item.type)) return 'item'
  return 'action'
}

function iconOf(item, activity) {
  const type = String(activity?.type || '').toLowerCase()
  if (type === 'heal') return 'heal'
  if (item.type === 'spell') return 'spell'
  if (item.type === 'consumable') return 'item'
  if (item.type === 'feat') return 'feature'
  if (type === 'save') return 'save'
  return 'attack'
}

function isActionable(item, activity, activation, uses) {
  const activityType = String(activity?.type || '').toLowerCase()
  if (activityType === 'enchant' && !ACTION_ACTIVATIONS.has(activation.type)) return false
  if (item.type === 'equipment' && !ACTION_ACTIVATIONS.has(activation.type)) return false
  if (item.type === 'feat' && !ACTION_ACTIVATIONS.has(activation.type) && !uses) return false
  return !!activity?.use || !!item?.use
}

export function actionCatalog(actor) {
  const actions = []
  for (const item of actor?.items || []) {
    const activities = activityList(item)
    const candidates = activities.length ? activities : [null]
    for (const activity of candidates) {
      if (!activity && !['weapon', 'spell', 'feat', 'consumable', 'equipment', 'tool'].includes(item.type)) continue
      const activation = activationOf(item, activity)
      const uses = remainingUses(item, activity)
      if (!isActionable(item, activity, activation, uses)) continue
      const resource = spellResource(actor, item)
      const prepared = item.type !== 'spell'
        || item.system?.preparation?.mode !== 'prepared'
        || item.system?.preparation?.prepared !== false
      const equipped = !['weapon', 'equipment'].includes(item.type) || item.system?.equipped !== false
      const exhausted = uses?.value != null && uses.value <= 0
      const noSlots = resource?.max > 0 && resource.value != null && resource.value <= 0
      const unavailableReason = !prepared ? 'Not prepared'
        : !equipped ? 'Not equipped'
          : exhausted ? 'No uses remaining'
            : noSlots ? 'No spell slots' : null
      actions.push({
        itemId: item.id,
        activityId: activity?.id || null,
        name: item.name,
        itemName: item.name,
        activityName: activity?.name && activity.name !== item.name ? activity.name : null,
        activityType: activity?.type || null,
        // The item portrait is the familiar artwork shown on the dnd5e sheet.
        // Activity images are often generic Attack/Damage/Save glyphs.
        img: item.img || activity?.img || null,
        type: item.type,
        icon: iconOf(item, activity),
        category: categoryOf(item, activation),
        activation,
        spellLevel: number(item.system?.level, null),
        uses,
        resource,
        range: rangeOf(item, activity),
        target: targetOf(item, activity),
        prepared,
        equipped,
        available: !unavailableReason,
        unavailableReason,
      })
    }
  }
  return actions
}

export function buildActorSheet(actor, token = null) {
  if (!actor) return null
  const hp = actor.system?.attributes?.hp
  const ac = actor.system?.attributes?.ac
  const movement = actor.system?.attributes?.movement || {}
  const conditions = [...(actor.statuses || [])].map((status) => String(status))
  if (!conditions.length && actor.effects) {
    for (const effect of actor.effects) {
      if (!effect.disabled && effect.name) conditions.push(effect.name)
    }
  }

  const actions = actionCatalog(actor)

  return {
    actorId: actor.id,
    tokenId: token?.id || null,
    name: token?.name || actor.name,
    hp: hp?.value ?? null,
    maxHp: hp?.max ?? null,
    ac: number(ac?.value ?? ac, null),
    speeds: {
      walk: number(movement.walk, null),
      fly: number(movement.fly, null),
      swim: number(movement.swim, null),
      climb: number(movement.climb, null),
    },
    conditions,
    actions,
  }
}

function resolveAction(bridge, command) {
  const { tokenId, itemId, activityId } = command.payload || {}
  const token = bridge.activeScene()?.tokens?.get(tokenId)
  if (!token) return { error: ['TOKEN_NOT_FOUND', `Token ${tokenId} is not in the active scene.`] }
  if (!bridge.canControl(token, command.source)) return { error: ['PERMISSION_DENIED', 'This client may not use actions for that token.'] }
  const item = token.actor?.items?.get(itemId)
  if (!item) return { error: ['ITEM_NOT_FOUND', 'That action is not on the claimed character.'] }
  const action = actionCatalog(token.actor).find((entry) => entry.itemId === itemId && String(entry.activityId || '') === String(activityId || ''))
  if (!action) return { error: ['UNSUPPORTED_ACTION', 'That item has no playable activity.'] }
  if (!action.available) return { error: ['ACTION_UNAVAILABLE', action.unavailableReason] }
  if (game.combat?.started && game.combat.combatant?.tokenId !== token.id
    && !String(action.activation?.type || '').startsWith('reaction')) {
    return { error: ['NOT_YOUR_TURN', 'Wait for your turn.'] }
  }
  return { token, item, action }
}

function validateTargets(bridge, token, action, targetIds) {
  if (action.target.template) return { error: ['TEMPLATE_REQUIRED', 'This action needs area-template placement in Foundry.'] }
  if (action.target.requiresTarget && !targetIds.length) return { needsTarget: true, targets: [] }
  const targets = targetIds.map((id) => canvas.tokens?.get(id)).filter(Boolean)
  if (action.target.requiresTarget && targets.length !== targetIds.length) {
    return { error: ['TARGET_NOT_FOUND', 'One or more targets are not in the active scene.'] }
  }
  if (action.range.value > 0 && targets.length) {
    const origin = token.getCenterPoint()
    const gridSize = bridge.gridSize(bridge.activeScene())
    const gridDistance = Number(bridge.activeScene()?.grid?.distance || 5)
    const tooFar = targets.some((target) => {
      const point = target.document?.getCenterPoint?.() || target.center
      return point && (Math.hypot(point.x - origin.x, point.y - origin.y) / gridSize * gridDistance) > action.range.value + 0.01
    })
    if (tooFar) return { error: ['OUT_OF_RANGE', `Target is beyond ${action.range.value} ${action.range.units || 'ft'}.`] }
  }
  return { needsTarget: false, targets }
}

export async function handleActionPreflight(bridge, command) {
  const resolved = resolveAction(bridge, command)
  if (resolved.error) {
    bridge.reject(command, ...resolved.error)
    return
  }
  const { token, action } = resolved
  const targetIds = Array.isArray(command.payload?.targetIds) ? command.payload.targetIds : []
  const validation = validateTargets(bridge, token, action, targetIds)
  if (validation.error) {
    bridge.reject(command, ...validation.error)
    return
  }
  if (validation.needsTarget) {
    bridge.respond(command, { canExecute: false, needsTarget: true, action })
    return
  }
  bridge.respond(command, { canExecute: true, needsTarget: false, action })
}

export async function handleActionUse(bridge, command) {
  const { tokenId, itemId, activityId, targetIds, options } = command.payload || {}
  const resolved = resolveAction(bridge, command)
  if (resolved.error) {
    bridge.reject(command, ...resolved.error)
    return
  }
  const { token, item, action } = resolved
  const actor = token.actor
  const requestedTargets = Array.isArray(targetIds) ? targetIds : []
  const validation = validateTargets(bridge, token, action, requestedTargets)
  if (validation.error || validation.needsTarget) {
    bridge.reject(command, ...(validation.error || ['TARGET_REQUIRED', 'Choose a target first.']))
    return
  }
  const targets = validation.targets
  const rollOptions = normalizeRollOptions(options)
  try {
    game.user?.targets?.clear?.()
    for (const target of targets) game.user?.targets?.add?.(target)
  } catch (error) {
    console.warn('lpc-bridge | failed to set Foundry targets', error)
  }

  let activity = null
  let execution = null
  let before = []
  try {
    const activities = activityList(item)
    activity = activityId
      ? activities.find((entry) => entry.id === activityId)
      : activities[0]
    let fastResult = { applied: [], saves: [] }
    before = targets.map((target) => hpState(target.actor)).filter(Boolean)
    if (activity?.use) {
      const hasTemplate = !!(activity.target?.template?.type || activity.system?.target?.template)
      if (hasTemplate && targets[0]) {
        ui.notifications?.info(`Bridge: ${actor.name} used ${item.name}. Adjust the template if needed.`)
      }
      const targetUuids = targets.map((target) => target.document?.uuid).filter(Boolean)
      // dnd5e's second argument controls its usage dialog. Subsequent rolls are
      // disabled and invoked below so their own configure dialogs cannot appear
      // over the GM's Foundry session.
      execution = await executeActivityWithoutDialogs(activity, {
        targetUuids,
        rollOptions,
        connectionId: command.source?.connectionId || null,
      })
      fastResult = await resolveFastActivity(activity, execution, targets)
    } else if (item.use) {
      await withRemoteRollGuard(() => item.use({}, {
        configure: false,
        configureDialog: false,
      }, {
        data: {
          'flags.lpc-bridge.remoteAction': true,
          'flags.lpc-bridge.fromClient': true,
          'flags.lpc-bridge.channel': rollOptions.channel,
          'flags.lpc-bridge.connectionId': command.source?.connectionId || null,
          sound: null,
        },
        rollMode: globalThis.CONST?.DICE_ROLL_MODES?.GMROLL || 'gmroll',
      }))
    } else {
      bridge.reject(command, 'UNSUPPORTED_ACTION', 'Foundry could not use that item.')
      return
    }
    const after = targets.map((target) => hpState(target.actor)).filter(Boolean)
    const resolution = bridge.recordResolution?.({
      label: `${actor.name}: ${activity?.name || item.name}`,
      activity,
      usage: execution?.usage,
      actors: before.map((state) => ({
        ...state,
        after: after.find((entry) => entry.actorUuid === state.actorUuid),
      })),
      applied: fastResult.applied,
      saves: fastResult.saves,
    }) || null
    bridge.respond(command, {
      tokenId,
      itemId,
      activityId: activity?.id || activityId || null,
      rollOptions,
      resolutionId: resolution?.id || null,
      applied: fastResult.applied,
      saves: fastResult.saves,
    })
    const actionAudience = rollOptions.channel === 'private'
      ? [command.source?.connectionId].filter(Boolean)
      : [...bridge.clients.entries()]
          .filter(([, client]) => client.role === 'player' && client.claimedTokenId)
          .map(([connectionId]) => connectionId)
    bridge.emit('action.result', {
      channel: rollOptions.channel,
      speaker: actor.name,
      speakerEntityId: `Token.${token.id}`,
      action: activity?.name || item.name,
      itemName: item.name,
      targetIds: targets.map((target) => target.id),
      applied: fastResult.applied,
      saves: fastResult.saves,
      resolutionId: resolution?.id || null,
      createdAt: Date.now(),
    }, { audience: { connectionIds: actionAudience } })
    bridge.emit('token.animated', {
      tokenId,
      animation: actionAnimFor({
        type: item.type,
        name: activity?.name || item.name,
        activation: activity?.activation?.type || item.system?.activation?.type,
      }),
      targetIds: targets.map((target) => target.id),
    })
    await bridge.pushActorSheet(token, command.source?.connectionId)
    if (resolution && fastResult.applied.length) {
      ui.notifications?.info(`${resolution.label} resolved in Fast mode. Undo is available in Live Table.`)
    }
  } catch (error) {
    const usage = execution?.usage || error?.bridgeUsage
    const deltas = usage?.message?.system?.deltas || usage?.message?.data?.system?.deltas
    try {
      if (deltas && activity?.refund) await activity.refund(deltas)
      for (const state of before) {
        const hp = state.actor?.system?.attributes?.hp
        if (!hp || (Number(hp.value) === state.hp && Number(hp.temp || 0) === state.tempHp)) continue
        await state.actor.update({
          'system.attributes.hp.value': state.hp,
          'system.attributes.hp.temp': state.tempHp,
          'system.attributes.hp.tempmax': state.tempMax,
        })
      }
    } catch (rollbackError) {
      console.error('lpc-bridge | fast resolution rollback failed', rollbackError)
      ui.notifications?.error('Bridge Fast mode could not fully roll back a failed action. Check the involved actors.')
    }
    console.error('lpc-bridge | action.use failed', error)
    bridge.reject(command, 'ACTION_FAILED', error?.message || 'The Foundry action failed.')
  }
}

export async function handleInitiative(bridge, command) {
  const tokenId = command.payload?.tokenId
  const scene = bridge.activeScene()
  const token = scene?.tokens?.get(tokenId)
  if (!token) {
    bridge.reject(command, 'TOKEN_NOT_FOUND', `Token ${tokenId} is not in the active scene.`)
    return
  }
  if (!bridge.canControl(token, command.source)) {
    bridge.reject(command, 'PERMISSION_DENIED', 'This client may not roll initiative for that token.')
    return
  }
  const combat = game.combat
  if (!combat) {
    bridge.reject(command, 'NOT_IN_COMBAT', 'There is no active combat encounter.')
    return
  }
  const combatant = combat.combatants.find((entry) => entry.tokenId === token.id)
  if (!combatant) {
    bridge.reject(command, 'NOT_IN_COMBAT', 'That token is not in the combat encounter.')
    return
  }
  try {
    if (combatant.rollInitiative) await combatant.rollInitiative()
    else if (combat.rollInitiative) await combat.rollInitiative([combatant.id])
    bridge.respond(command, { tokenId, initiative: combatant.initiative })
    bridge.pushCombat()
  } catch (error) {
    bridge.reject(command, 'ACTION_FAILED', error?.message || 'Initiative roll failed.')
  }
}

export function extractRolls(message) {
  const rolls = [...(message.rolls || [])]
  if (!rolls.length) return null
  const totals = rolls.map((roll) => Number(roll.total)).filter(Number.isFinite)
  const isCrit = rolls.some((roll) => roll.dice?.some?.((die) => die.results?.some?.((result) => result.crit || result.result === die.faces)))
  return {
    totals,
    isCrit,
    flavor: message.flavor || message.speaker?.alias || '',
    formula: rolls.map((roll) => roll.formula).filter(Boolean).join(', '),
  }
}
