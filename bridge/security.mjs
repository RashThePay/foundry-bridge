import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)

export function token(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

export function tokenHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex')
}

export async function hashPin(pin, salt = randomBytes(16).toString('hex')) {
  const normalized = String(pin || '')
  if (!/^\d{4,12}$/.test(normalized)) throw Object.assign(new Error('PIN must contain 4 to 12 digits.'), { code: 'INVALID_PIN' })
  const derived = await scrypt(normalized, salt, 32)
  return `scrypt:${salt}:${Buffer.from(derived).toString('hex')}`
}

export async function verifyPin(pin, encoded) {
  const [scheme, salt, expectedHex] = String(encoded || '').split(':')
  if (scheme !== 'scrypt' || !salt || !expectedHex) return false
  const actual = Buffer.from(await scrypt(String(pin || ''), salt, 32))
  const expected = Buffer.from(expectedHex, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function safeEqualSecret(value, expectedHash) {
  const actual = Buffer.from(tokenHash(value), 'hex')
  const expected = Buffer.from(String(expectedHash || ''), 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
