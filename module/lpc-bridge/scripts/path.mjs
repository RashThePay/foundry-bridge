const EPS = 1e-4

export function gridSquare(x, y) {
  return {
    x: Math.floor(Number(x) + EPS),
    y: Math.floor(Number(y) + EPS),
  }
}

export function facingFromStep(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'down' : 'up'
}

function almost(a, b) {
  return Math.abs(Number(a) - Number(b)) <= EPS
}

function overlap1d(a1, a2, b1, b2) {
  return Math.min(a1, a2) <= Math.max(b1, b2) + EPS && Math.min(b1, b2) <= Math.max(a1, a2) + EPS
}

export function wallBlocks(wall) {
  if (!wall || wall.move === false) return false
  if (wall.door && wall.door !== 'none' && wall.doorState === 'open') return false
  return true
}

function orientation(a, b, c) {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y)
  if (Math.abs(value) <= EPS) return 0
  return value > 0 ? 1 : -1
}

function onSegment(a, b, point) {
  return point.x <= Math.max(a.x, b.x) + EPS && point.x >= Math.min(a.x, b.x) - EPS
    && point.y <= Math.max(a.y, b.y) + EPS && point.y >= Math.min(a.y, b.y) - EPS
}

function segmentsIntersect(p1, p2, q1, q2) {
  const o1 = orientation(p1, p2, q1)
  const o2 = orientation(p1, p2, q2)
  const o3 = orientation(q1, q2, p1)
  const o4 = orientation(q1, q2, p2)
  if (o1 !== o2 && o3 !== o4) return true
  if (o1 === 0 && onSegment(p1, p2, q1)) return true
  if (o2 === 0 && onSegment(p1, p2, q2)) return true
  if (o3 === 0 && onSegment(q1, q2, p1)) return true
  if (o4 === 0 && onSegment(q1, q2, p2)) return true
  return false
}

export function stepBlocked(from, to, walls = []) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) + Math.abs(dy) !== 1) return true
  const centerA = { x: from.x + 0.5, y: from.y + 0.5 }
  const centerB = { x: to.x + 0.5, y: to.y + 0.5 }
  return walls.some((wall) => wallBlocks(wall) && segmentsIntersect(centerA, centerB, wall.a, wall.b))
}

function greedyPath(start, goal, walls, maxSteps) {
  const steps = []
  let current = { ...start }
  for (let i = 0; i < maxSteps; i += 1) {
    const dx = Math.sign(goal.x - current.x)
    const dy = Math.sign(goal.y - current.y)
    if (!dx && !dy) break
    let next = null
    if (dx && !stepBlocked(current, { x: current.x + dx, y: current.y }, walls)) {
      next = { x: current.x + dx, y: current.y, facing: dx > 0 ? 'right' : 'left' }
    } else if (dy && !stepBlocked(current, { x: current.x, y: current.y + dy }, walls)) {
      next = { x: current.x, y: current.y + dy, facing: dy > 0 ? 'down' : 'up' }
    }
    if (!next) break
    steps.push(next)
    current = next
  }
  return steps
}

export function orthogonalPath(from, to, walls = [], maxSteps = 80, bounds = null) {
  const start = gridSquare(from.x, from.y)
  const goal = gridSquare(to.x, to.y)
  if (start.x === goal.x && start.y === goal.y) return []

  const keyOf = (point) => `${point.x},${point.y}`
  const dirs = [
    { x: 1, y: 0, facing: 'right' },
    { x: -1, y: 0, facing: 'left' },
    { x: 0, y: 1, facing: 'down' },
    { x: 0, y: -1, facing: 'up' },
  ]
  const seen = new Set([keyOf(start)])
  const queue = [{ ...start, prev: null, facing: 'down' }]
  let found = null
  let explored = 0

  while (queue.length && explored < maxSteps * 12) {
    const current = queue.shift()
    explored += 1
    if (current.x === goal.x && current.y === goal.y) {
      found = current
      break
    }
    const ordered = [...dirs].sort((a, b) => {
      const da = Math.abs(current.x + a.x - goal.x) + Math.abs(current.y + a.y - goal.y)
      const db = Math.abs(current.x + b.x - goal.x) + Math.abs(current.y + b.y - goal.y)
      return da - db
    })
    for (const dir of ordered) {
      const next = { x: current.x + dir.x, y: current.y + dir.y, prev: current, facing: dir.facing }
      if (bounds && (next.x < 0 || next.y < 0 || next.x >= bounds.width || next.y >= bounds.height)) continue
      if (seen.has(keyOf(next))) continue
      if (stepBlocked(current, next, walls)) continue
      seen.add(keyOf(next))
      queue.push(next)
    }
  }

  if (!found) return greedyPath(start, goal, walls, maxSteps)

  const steps = []
  for (let node = found; node.prev; node = node.prev) {
    steps.unshift({ x: node.x, y: node.y, facing: node.facing })
  }
  return steps.slice(0, maxSteps)
}
