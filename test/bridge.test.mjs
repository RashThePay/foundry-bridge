import assert from 'node:assert/strict'
import test from 'node:test'
import { WebSocket } from 'ws'
import { createBridgeServer } from '../bridge/server.mjs'

function nextMessage(ws, predicate = () => true, timeoutMs = 1500) {
  const queuedIndex = (ws.inbox || []).findIndex(predicate)
  if (queuedIndex >= 0) return Promise.resolve(ws.inbox.splice(queuedIndex, 1)[0])
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('bridge-message', onMessage)
      reject(new Error('Timed out waiting for WebSocket message'))
    }, timeoutMs)
    function onMessage(message) {
      if (!predicate(message)) return
      clearTimeout(timeout)
      ws.off('bridge-message', onMessage)
      const index = ws.inbox.indexOf(message)
      if (index >= 0) ws.inbox.splice(index, 1)
      resolve(message)
    }
    ws.on('bridge-message', onMessage)
  })
}

function captureMessages(ws) {
  ws.inbox = []
  ws.on('message', (data) => {
    const message = JSON.parse(String(data))
    ws.inbox.push(message)
    ws.emit('bridge-message', message)
  })
}

async function connect(url, role, roomId, name = role, accessKey = '') {
  const ws = new WebSocket(url)
  captureMessages(ws)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  ws.send(JSON.stringify({
    v: 1,
    kind: 'hello',
    type: 'connection.hello',
    payload: { role, roomId, name, accessKey },
  }))
  await nextMessage(ws, (message) => message.type === 'connection.ready')
  return ws
}

async function fixture(options = {}) {
  const server = createBridgeServer({ port: 0, host: '127.0.0.1', logger: { log() {} }, ...options })
  const address = await server.listen()
  return { server, url: `ws://127.0.0.1:${address.port}/ws` }
}

test('routes a command to Foundry and returns its correlated response', async (t) => {
  const { server, url } = await fixture()
  t.after(() => server.close())
  const foundry = await connect(url, 'foundry', 'alpha')
  const player = await connect(url, 'player', 'alpha', 'Arash')
  t.after(() => { foundry.close(); player.close() })

  player.send(JSON.stringify({
    v: 1,
    kind: 'command',
    type: 'token.move',
    id: 'move-1',
    payload: { tokenId: 'token-a', destination: { x: 2, y: 4 } },
  }))
  const command = await nextMessage(foundry, (message) => message.id === 'move-1')
  assert.equal(command.source.name, 'Arash')
  assert.equal(command.roomId, 'alpha')

  foundry.send(JSON.stringify({
    v: 1,
    kind: 'response',
    type: 'token.move.result',
    replyTo: 'move-1',
    payload: { ok: true },
  }))
  const response = await nextMessage(player, (message) => message.replyTo === 'move-1')
  assert.deepEqual(response.payload, { ok: true })
})

test('isolates rooms and replays the latest authoritative snapshot', async (t) => {
  const { server, url } = await fixture()
  t.after(() => server.close())
  const alpha = await connect(url, 'foundry', 'alpha')
  const beta = await connect(url, 'foundry', 'beta')
  t.after(() => { alpha.close(); beta.close() })

  alpha.send(JSON.stringify({
    v: 1,
    kind: 'event',
    type: 'world.snapshot',
    payload: { revision: 9, scene: { id: 'scene-alpha' }, entities: [] },
  }))

  const player = await connect(url, 'player', 'alpha')
  t.after(() => player.close())
  const snapshot = await nextMessage(player, (message) => message.type === 'world.snapshot')
  assert.equal(snapshot.payload.scene.id, 'scene-alpha')
  assert.equal(snapshot.roomId, 'alpha')

  const betaPlayer = await connect(url, 'player', 'beta')
  t.after(() => betaPlayer.close())
  betaPlayer.send(JSON.stringify({
    v: 1,
    kind: 'command',
    type: 'connection.ping',
    id: 'beta-ping',
    payload: {},
  }))
  const betaCommand = await nextMessage(beta, (message) => message.id === 'beta-ping')
  assert.equal(betaCommand.roomId, 'beta')
})

test('rejects an invalid access key', async (t) => {
  const { server, url } = await fixture({ secret: 'correct-key' })
  t.after(() => server.close())
  const ws = new WebSocket(url)
  captureMessages(ws)
  t.after(() => ws.close())
  await new Promise((resolve) => ws.once('open', resolve))
  ws.send(JSON.stringify({
    v: 1,
    kind: 'hello',
    type: 'connection.hello',
    payload: { role: 'player', roomId: 'alpha', name: 'Arash', accessKey: 'wrong-key' },
  }))
  const error = await nextMessage(ws, (message) => message.type === 'connection.error')
  assert.equal(error.payload.code, 'AUTH_FAILED')
})
