import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const EMPTY = { schemaVersion: 1, campaigns: {}, sessions: {} }

export class BridgeStore {
  constructor(root) {
    this.root = root
    this.file = join(root, 'bridge-state.json')
    this.data = structuredClone(EMPTY)
    this.queue = Promise.resolve()
  }

  async load() {
    await mkdir(join(this.root, 'assets'), { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'))
      if (parsed?.schemaVersion !== 1) throw new Error('Unsupported bridge database schema.')
      this.data = { ...structuredClone(EMPTY), ...parsed }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await this.save()
    }
    this.pruneSessions()
    return this
  }

  pruneSessions(now = Date.now()) {
    for (const [hash, session] of Object.entries(this.data.sessions)) {
      if (session.revokedAt || session.expiresAt <= now || !this.data.campaigns[session.campaignId]) delete this.data.sessions[hash]
    }
  }

  save() {
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.file)
    })
    return this.queue
  }

  assetPath(campaignId, hash) {
    return join(this.root, 'assets', campaignId, hash)
  }
}
