import { symlink, rm, mkdir, cp } from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoModule = join(__dirname, '..', 'module', 'lpc-bridge')
const foundryModules = join(
  process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
  'FoundryVTT',
  'Data',
  'modules'
)
const target = join(foundryModules, 'lpc-bridge')

async function main() {
  if (!existsSync(foundryModules)) {
    console.error('Foundry modules folder not found:', foundryModules)
    process.exit(1)
  }

  if (existsSync(target)) {
    const stat = lstatSync(target)
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      await rm(target, { recursive: true, force: true })
    }
  }

  try {
    await symlink(repoModule, target, 'junction')
    console.log('Linked (junction):', target, '→', repoModule)
  } catch (err) {
    console.warn('Symlink failed, copying instead:', err.message)
    await mkdir(target, { recursive: true })
    await cp(repoModule, target, { recursive: true })
    console.log('Copied module to', target)
  }
}

main()
