export const PROTOCOL_VERSION = 2
export const MUTATING_COMMANDS = new Set([
  'movement.request', 'movement.cancel', 'door.toggle', 'chat.send', 'intent.submit',
  'action.preflight', 'action.execute', 'combat.rollInitiative',
])
export const PLAYER_COMMANDS = new Set(['world.snapshot.request', 'connection.ping', ...MUTATING_COMMANDS])

export function envelope(kind, type, payload = {}, extra = {}) {
  return { v: PROTOCOL_VERSION, kind, type, ...extra, payload }
}

export function validateEnvelope(message, { hello = false } = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return 'Message must be an object.'
  if (message.v !== PROTOCOL_VERSION) return `Protocol v${PROTOCOL_VERSION} is required.`
  if (typeof message.kind !== 'string' || typeof message.type !== 'string') return 'kind and type are required.'
  if (!message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) return 'payload must be an object.'
  if (hello && (message.kind !== 'hello' || message.type !== 'connection.hello')) return 'connection.hello is required.'
  if (message.kind === 'command' && (typeof message.id !== 'string' || !message.id || message.id.length > 128)) return 'Commands require a valid id.'
  if (message.kind === 'command' && MUTATING_COMMANDS.has(message.type) && (typeof message.idempotencyKey !== 'string' || !message.idempotencyKey || message.idempotencyKey.length > 128)) return 'Mutating commands require idempotencyKey.'
  return null
}
