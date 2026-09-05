export class AssetGateway {
  constructor() {
    this.cache = new Map()
    this.pending = new Map()
  }

  gatewayHttp(bridge) {
    return String(bridge.url || '').replace(/^ws/i, 'http').replace(/\/ws\/?$/, '')
  }

  foundrySrc(src) {
    if (!src) return null
    const value = String(src)
    if (value.startsWith('/api/v2/campaigns/') || value.startsWith('data:') || /^https?:\/\//i.test(value)) return value
    try {
      return foundry.utils.getRoute(value)
    } catch {
      return value
    }
  }

  lookup(src) {
    if (!src) return null
    return this.cache.get(src) || this.cache.get(this.foundrySrc(src)) || null
  }

  async resolve(bridge, src) {
    if (!src) return null
    const value = String(src)
    if (value.startsWith('/api/v2/campaigns/') || value.startsWith('data:')) return value
    const cached = this.lookup(value)
    if (cached) return cached
    if (this.pending.has(value)) return this.pending.get(value)

    const work = this.upload(bridge, value).finally(() => this.pending.delete(value))
    this.pending.set(value, work)
    return work
  }

  async upload(bridge, src) {
    const url = this.foundrySrc(src)
    if (!url || url.startsWith('/api/v2/campaigns/') || url.startsWith('data:')) return url
    try {
      const response = await fetch(url)
      if (!response.ok) return url
      const buffer = await response.arrayBuffer()
      const digest = await crypto.subtle.digest('SHA-256', buffer)
      const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)
      const contentType = response.headers.get('content-type') || 'application/octet-stream'
      const putUrl = `${this.gatewayHttp(bridge)}/api/v2/campaigns/${encodeURIComponent(bridge.roomId)}/assets/${hash}`
      const put = await fetch(putUrl, {
        method: 'PUT',
        headers: {
          'content-type': contentType,
          authorization: `Bearer ${bridge.accessKey || ''}`,
        },
        body: buffer,
      })
      if (!put.ok) return url
      const gatewayPath = `/api/v2/campaigns/${bridge.roomId}/assets/${hash}`
      this.cache.set(src, gatewayPath)
      this.cache.set(url, gatewayPath)
      return gatewayPath
    } catch (error) {
      console.warn('lpc-bridge | asset upload failed', src, error)
      return url
    }
  }

  async rewriteEntity(bridge, entity) {
    if (!entity) return entity
    entity.textureUrl = await this.resolve(bridge, entity.textureUrl)
    return entity
  }

  async rewriteActorSheet(bridge, sheet) {
    if (!sheet) return sheet
    await Promise.all((sheet.actions || []).map(async (action) => {
      action.img = await this.resolve(bridge, action.img)
    }))
    return sheet
  }

  async rewriteSnapshot(bridge, snapshot) {
    if (snapshot.scene?.map) {
      snapshot.scene.map.backgroundUrl = await this.resolve(bridge, snapshot.scene.map.backgroundUrl)
    }
    for (const entity of snapshot.entities || []) await this.rewriteEntity(bridge, entity)
    for (const asset of snapshot.assets || []) {
      asset.spriteUrl = await this.resolve(bridge, asset.spriteUrl)
      if (asset.previewUrl) asset.previewUrl = await this.resolve(bridge, asset.previewUrl)
    }
    for (const character of snapshot.playableCharacters || []) {
      character.textureUrl = await this.resolve(bridge, character.textureUrl)
    }
    return snapshot
  }
}
