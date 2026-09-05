import { gridSquare, orthogonalPath, stepBlocked } from '../module/lpc-bridge/scripts/path.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'

test('orthogonal path walks one axis then the other', () => {
  const path = orthogonalPath({ x: 0, y: 0 }, { x: 2, y: 1 }, [])
  assert.equal(path.length, 3)
  assert.deepEqual(path.map((step) => `${step.x},${step.y}`), ['1,0', '2,0', '2,1'])
  assert.ok(path.every((step) => step.facing))
})

test('closed door on a grid line blocks the shared edge', () => {
  const door = {
    a: { x: 1, y: 0 },
    b: { x: 1, y: 1 },
    move: true,
    door: 'door',
    doorState: 'closed',
  }
  assert.equal(stepBlocked({ x: 0, y: 0 }, { x: 1, y: 0 }, [door]), true)
  const path = orthogonalPath({ x: 0.2, y: 0.1 }, { x: 2, y: 0 }, [door])
  assert.ok(path.length)
  assert.notEqual(path[0].x, 1)
  assert.deepEqual(path.at(-1), { x: 2, y: 0, facing: path.at(-1).facing })
})

test('open door does not block and BFS goes around a wall', () => {
  const wall = {
    a: { x: 1, y: 0 },
    b: { x: 1, y: 1 },
    move: true,
    door: 'none',
    doorState: 'closed',
  }
  const path = orthogonalPath({ x: 0, y: 0 }, { x: 2, y: 0 }, [wall])
  assert.ok(path.length >= 4)
  assert.ok(path.some((step) => step.y !== 0))
  assert.deepEqual(path.at(-1), { x: 2, y: 0, facing: path.at(-1).facing })
})

test('gridSquare floors fractional taps onto the map square', () => {
  assert.deepEqual(gridSquare(3.9, 4.01), { x: 3, y: 4 })
})

test('pathfinding respects scene bounds instead of escaping around edge walls', () => {
  const wall = { a: { x: 1, y: 0 }, b: { x: 1, y: 2 }, move: true, door: 'none' }
  const path = orthogonalPath({ x: 0, y: 0 }, { x: 1, y: 0 }, [wall], 80, { width: 2, height: 2 })
  assert.deepEqual(path, [])
})

test('center-line collision handles angled Foundry walls and open doors', () => {
  const angled = { a: { x: 0.9, y: 0 }, b: { x: 1.1, y: 1 }, move: true, door: 'none' }
  assert.equal(stepBlocked({ x: 0, y: 0 }, { x: 1, y: 0 }, [angled]), true)
  assert.equal(stepBlocked({ x: 0, y: 0 }, { x: 1, y: 0 }, [{ ...angled, door: 'door', doorState: 'open' }]), false)
})
