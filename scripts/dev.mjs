import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const viteBin = require.resolve('vite/bin/vite.js')

const kids = [
  spawn(process.execPath, ['bridge/server.mjs'], { stdio: 'inherit' }),
  spawn(process.execPath, [viteBin], { stdio: 'inherit' }),
]

function shutdown() {
  for (const child of kids) child.kill()
  process.exit()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
