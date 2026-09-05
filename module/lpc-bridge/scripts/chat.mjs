import { extractRolls } from './actions.mjs'
import { characterNameFor, clone, entityDisplayName, MODULE_ID, tokenDisplayName } from './snapshot.mjs'

function htmlText(value) {
  const container = document.createElement('div')
  container.innerHTML = value || ''
  return (container.textContent || '').replace(/\s+/g, ' ').trim()
}

function claimedToken(bridge, connectionId) {
  const client = bridge.clients.get(connectionId)
  if (!client?.claimedTokenId) return null
  return bridge.activeScene()?.tokens?.get(client.claimedTokenId) || null
}

function speakerFromToken(token, fallbackName) {
  if (!token) return { alias: fallbackName }
  return {
    alias: tokenDisplayName(token) || fallbackName,
    actor: token.actor?.id || token.actorId || null,
    token: token.id,
    scene: token.parent?.id || null,
  }
}

export function partyConnectionIds(bridge) {
  return [...bridge.clients.entries()]
    .filter(([, client]) => client.role === 'player' && client.claimedTokenId)
    .map(([id]) => id)
}

export async function handleChat(bridge, command) {
  const text = String(command.payload?.text || '').trim()
  const channel = ['all', 'party', 'npc'].includes(command.payload?.channel) ? command.payload.channel : 'all'
  const targetEntityId = command.payload?.targetEntityId || null
  if (!text) {
    bridge.reject(command, 'INVALID_ARGUMENT', 'Chat text is required.')
    return
  }
  if (channel === 'npc' && !targetEntityId) {
    bridge.reject(command, 'INVALID_ARGUMENT', 'NPC chat requires targetEntityId.')
    return
  }

  const token = claimedToken(bridge, command.source?.connectionId)
  const speaker = speakerFromToken(token, characterNameFor(bridge, command.source?.connectionId))
  const payload = {
    channel,
    speaker: speaker.alias,
    speakerEntityId: token ? `Token.${token.id}` : null,
    speakerActorId: speaker.actor,
    targetEntityId,
    text,
    createdAt: Date.now(),
  }

  if (channel === 'npc') {
    const thread = bridge.threadFor(targetEntityId, command.source?.connectionId)
    thread.playerName = speaker.alias
    thread.messages.push({
      from: 'player',
      connectionId: command.source?.connectionId,
      name: speaker.alias,
      text,
      createdAt: payload.createdAt,
    })
    const created = await ChatMessage.create({
      content: foundry.utils.escapeHTML(text),
      speaker,
      style: CONST.CHAT_MESSAGE_STYLES?.OTHER ?? CONST.CHAT_MESSAGE_TYPES?.OTHER,
      whisper: ChatMessage.getWhisperRecipients?.('GM')?.map((user) => user.id) || [],
      flags: { [MODULE_ID]: { fromClient: true, channel, targetEntityId, connectionId: command.source?.connectionId } },
    })
    payload.messageId = created?.id || null
    bridge.emit('chat.message', payload, { audience: { connectionIds: [command.source.connectionId] } })
    bridge.gmPanel?.render?.({ force: true })
    bridge.respond(command, { messageId: payload.messageId, channel })
    return
  }

  const whisper = channel === 'party'
    ? ChatMessage.getWhisperRecipients?.('GM')?.map((user) => user.id) || []
    : []
  const created = await ChatMessage.create({
    content: foundry.utils.escapeHTML(text),
    speaker,
    style: CONST.CHAT_MESSAGE_STYLES?.OTHER ?? CONST.CHAT_MESSAGE_TYPES?.OTHER,
    whisper,
    flags: { [MODULE_ID]: { fromClient: true, channel, connectionId: command.source?.connectionId } },
  })
  payload.messageId = created?.id || null
  const audience = channel === 'party'
    ? { connectionIds: partyConnectionIds(bridge) }
    : undefined
  bridge.emit('chat.message', payload, audience ? { audience } : {})
  bridge.respond(command, { messageId: payload.messageId, channel })
}

export async function handleIntent(bridge, command) {
  const payload = command.payload || {}
  const text = String(payload.text || '').trim()
  const verb = String(payload.verb || '').trim()
  if (!text || !verb) {
    bridge.reject(command, 'INVALID_ARGUMENT', 'Intent verb and text are required.')
    return
  }
  const intentId = foundry.utils.randomID()
  const token = claimedToken(bridge, command.source?.connectionId)
  const character = tokenDisplayName(token) || characterNameFor(bridge, command.source?.connectionId)
  const targetName = entityDisplayName(bridge, payload.targetEntityId)
  const record = {
    id: intentId,
    connectionId: command.source?.connectionId,
    character,
    verb,
    text,
    targetEntityId: payload.targetEntityId || null,
    targetName,
    createdAt: Date.now(),
    status: 'open',
  }
  bridge.intents.set(intentId, record)
  const created = await ChatMessage.create({
    content: `<div class="lpc-intent"><strong>${foundry.utils.escapeHTML(character)}</strong> wants to <em>${foundry.utils.escapeHTML(verb)}</em> <strong>${foundry.utils.escapeHTML(targetName)}</strong>: ${foundry.utils.escapeHTML(text)}</div>`,
    speaker: { alias: character },
    style: CONST.CHAT_MESSAGE_STYLES?.OTHER ?? CONST.CHAT_MESSAGE_TYPES?.OTHER,
    whisper: ChatMessage.getWhisperRecipients?.('GM')?.map((user) => user.id) || [],
    flags: { [MODULE_ID]: { fromClient: true, intent: true, intentId, payload: clone(payload) } },
  })
  ui.notifications?.info(`${character} wants to ${verb} ${targetName}`)
  bridge.emit('intent.raised', { ...record, messageId: created?.id || null }, {
    audience: { connectionIds: [command.source.connectionId] },
  })
  bridge.gmPanel?.render?.({ force: true })
  bridge.respond(command, { intentId, messageId: created?.id || null })
}

export async function resolveIntent(bridge, intentId, { ok, narrative }) {
  const record = bridge.intents.get(intentId)
  if (!record || record.status !== 'open') return
  record.status = ok ? 'accepted' : 'denied'
  record.narrative = narrative || (ok ? 'The DM accepts.' : 'That does not work.')
  if (ok && narrative) {
    await ChatMessage.create({
      content: foundry.utils.escapeHTML(narrative),
      speaker: { alias: 'Narration' },
      flags: { [MODULE_ID]: { intentResolve: true, intentId } },
    })
    bridge.emit('chat.message', {
      messageId: null,
      channel: 'all',
      speaker: 'Narration',
      text: narrative,
      createdAt: Date.now(),
    })
  }
  bridge.emit('intent.resolved', { intentId, ok, narrative: record.narrative }, {
    audience: { connectionIds: [record.connectionId].filter(Boolean) },
  })
  bridge.gmPanel?.render?.({ force: true })
}

export async function speakAsNpc(bridge, { entityId, text, publicBroadcast = true, connectionId = null }) {
  const cleaned = String(text || '').trim()
  if (!cleaned) return
  const tokenId = String(entityId || '').replace(/^Token\./, '')
  const token = bridge.activeScene()?.tokens?.get(tokenId)
  if (!token) {
    ui.notifications?.warn('Select a scene NPC to speak as.')
    return
  }
  const thread = publicBroadcast ? null : bridge.threadFor(`Token.${token.id}`, connectionId)
  if (!publicBroadcast && !connectionId) {
    ui.notifications?.warn('Choose a player conversation before replying privately.')
    return
  }
  const created = await ChatMessage.create({
    content: foundry.utils.escapeHTML(cleaned),
    speaker: speakerFromToken(token, tokenDisplayName(token)),
    whisper: publicBroadcast ? [] : ChatMessage.getWhisperRecipients?.('GM')?.map((user) => user.id) || [],
    flags: { [MODULE_ID]: { speakAsNpc: true, channel: publicBroadcast ? 'all' : 'npc', targetEntityId: `Token.${token.id}`, connectionId } },
  })
  const payload = {
    messageId: created?.id || null,
    channel: publicBroadcast ? 'all' : 'npc',
    speaker: tokenDisplayName(token),
    speakerEntityId: `Token.${token.id}`,
    speakerActorId: token.actor?.id || null,
    targetEntityId: publicBroadcast ? null : `Token.${token.id}`,
    text: cleaned,
    createdAt: Date.now(),
  }
  thread?.messages.push({
      from: 'npc',
      name: tokenDisplayName(token),
      text: cleaned,
      createdAt: payload.createdAt,
    })
  const audience = publicBroadcast
    ? undefined
    : { connectionIds: [connectionId].filter(Boolean) }
  bridge.emit('chat.message', payload, audience ? { audience } : {})
  bridge.gmPanel?.render?.({ force: true })
}

export function forwardFoundryChat(bridge, message) {
  if (!message || message.getFlag?.(MODULE_ID, 'fromClient') || message.getFlag?.(MODULE_ID, 'speakAsNpc')) return
  if (message.getFlag?.(MODULE_ID, 'intent') || message.getFlag?.(MODULE_ID, 'intentResolve')) return
  if (message.whisper?.length) return
  const text = htmlText(message.content)
  if (!text) return
  const token = message.speaker?.token
    ? (canvas?.scene?.tokens?.get(message.speaker.token) || game.scenes?.active?.tokens?.get(message.speaker.token))
    : null
  const actor = message.speaker?.actor ? game.actors?.get(message.speaker.actor) : token?.actor
  const speaker = tokenDisplayName(token) || actor?.name || message.speaker?.alias || 'Someone'
  const tokenId = message.speaker?.token || null
  bridge.emit('chat.message', {
    messageId: message.id,
    channel: 'all',
    speaker,
    speakerEntityId: tokenId ? `Token.${tokenId}` : null,
    speakerActorId: message.speaker?.actor || null,
    targetEntityId: null,
    text,
    createdAt: Date.now(),
  })
  const rolls = extractRolls(message)
  if (rolls) {
    bridge.emit('roll.result', {
      messageId: message.id,
      speaker,
      flavor: rolls.flavor,
      totals: rolls.totals,
      isCrit: rolls.isCrit,
      formula: rolls.formula,
      targetIds: [...(game.user?.targets || [])].map((token) => token.id),
    })
  }
}
