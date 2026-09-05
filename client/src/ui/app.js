import { assetUrl } from '../net/bridge.js'

const $ = (id) => document.getElementById(id)

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* ignore */ }
}

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

export class GameUI {
  constructor(bridge, game) {
    this.bridge = bridge
    this.game = game
    this.claimedTokenId = load('fb.claimedTokenId', null)
    this.sessionToken = localStorage.getItem('fb.sessionToken') || ''
    this.npcTarget = null
    this.armedAction = null
    this.chat = []
    this.sheet = null
    this.combat = { started: false, combatants: [] }
    this.snapshot = null
    this.movementPending = false
    this.actionSheetCategory = 'all'
    this.actionTargetId = null
    this.bind()
    this.restoreForm()
    this.listen()
  }

  scene() {
    return this.game.scene.getScene('world')
  }

  restoreForm() {
    const stored = load('fb.connect', {})
    $('name').value = stored.name || $('name').value
    const params = new URLSearchParams(location.search)
    $('room').value = params.get('room') || stored.room || 'default'
    $('url').value = stored.url || params.get('ws') || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`
    if (location.port && location.port !== '3847' && !$('url').value.includes('/ws')) {
      $('url').value = `ws://${location.hostname}:3847/ws`
    }
    if (location.port === '5173') $('url').value = `ws://${location.host}/ws`
    const session = load('fb.session', null)
    if (this.sessionToken && session?.expiresAt > Date.now() && session.campaignId === $('room').value) {
      this.claimedTokenId = session.tokenId
      this.setStatus(false, 'Returning to the world…')
      this.bridge.connect({ url: $('url').value, campaignId: session.campaignId, sessionToken: this.sessionToken })
      $('connect').hidden = true
      $('claim').hidden = false
      return
    }
    this.loadCharacters().catch(() => {})
  }

  bind() {
    $('connectBtn').onclick = () => this.connect()
    $('backToConnect').onclick = () => this.disconnect()
    $('sheetClose').onclick = () => this.closeSheet()
    $('interactClose').onclick = () => { $('interact').hidden = true }
    $('debugClose').onclick = () => { $('debug').hidden = true }
    document.querySelectorAll('[data-sheet]').forEach((button) => {
      button.onclick = () => this.openSheet(button.dataset.sheet)
    })
    $('chatForm').onsubmit = (event) => {
      event.preventDefault()
      this.sendChat()
    }
    $('chatChannel').onchange = () => this.renderChat()
    let press = 0
    $('connPip').addEventListener('pointerdown', () => { press = Date.now() })
    $('connPip').addEventListener('pointerup', () => {
      if (Date.now() - press > 550) $('debug').hidden = false
    })
  }

  listen() {
    this.bridge.on('connection.ready', (payload) => {
      this.setStatus(payload.foundryConnected, payload.foundryConnected ? 'Foundry online' : 'Waiting for the DM')
      if (payload.foundryConnected) this.bridge.command('world.snapshot.request').catch(() => {})
    })
    this.bridge.on('room.status', (payload) => {
      this.setStatus(payload.foundryConnected, payload.foundryConnected ? 'Foundry online' : 'Waiting for the DM')
    })
    this.bridge.on('error', (payload) => this.setStatus(false, `${payload.code}: ${payload.message}`))
    this.bridge.on('disconnected', () => this.setStatus(false, 'Disconnected'))
    this.bridge.on('reconnecting', ({ delay }) => this.setStatus(false, `Reconnecting in ${Math.ceil(delay / 1000)}s…`))
    this.bridge.on('world.snapshot', (payload) => this.onSnapshot(payload))
    this.bridge.on('entity.created', (payload) => this.patchEntity(payload.entity, false))
    this.bridge.on('entity.updated', (payload) => this.patchEntity(payload.entity, false))
    this.bridge.on('entity.deleted', (payload) => this.patchEntity({ id: payload.entityId }, true))
    this.bridge.on('chat.message', (payload) => this.addChat(payload))
    this.bridge.on('actor.sheet', (payload) => {
      this.sheet = payload.sheet
      this.renderVitals()
      this.renderActionBar()
    })
    this.bridge.on('actor.updated', (payload) => {
      if (this.sheet && payload.tokenIds?.includes(this.claimedTokenId)) {
        this.sheet.hp = payload.hp
        this.sheet.maxHp = payload.maxHp
        this.sheet.tempHp = payload.tempHp
        if (Array.isArray(payload.conditions)) this.sheet.conditions = [...payload.conditions]
        this.renderVitals()
      }
    })
    this.bridge.on('combat.updated', (payload) => {
      this.combat = payload
      this.renderCombat()
      this.renderActionBar()
    })
    this.bridge.on('roll.result', (payload) => this.onRoll(payload))
    this.bridge.on('action.result', (payload) => this.onActionResult(payload))
    this.bridge.on('action.undone', (payload) => this.float(`Undone: ${payload.label}`))
    this.bridge.on('intent.resolved', (payload) => {
      this.float(`${payload.ok ? 'Yes' : 'No'}: ${payload.narrative || ''}`)
    })
    this.bridge.on('frame', (message) => this.debug(message))
  }

  setStatus(ok, text) {
    const el = $('connectStatus')
    el.className = `status ${ok ? 'ok' : 'bad'}`
    el.textContent = text
    $('connPip').className = `pip ${ok ? 'ok' : 'bad'}`
  }

  async loadCharacters() {
    const selected = $('joinCharacter').value
    const room = encodeURIComponent($('room').value.trim() || 'default')
    const response = await fetch(`/api/v2/open/${room}/characters`)
    const result = await response.json()
    if (!response.ok) throw new Error(result.error?.message || 'Characters could not be loaded.')
    $('joinCharacter').replaceChildren(...result.characters.filter((character) => character.available).map((character) => {
      const option = document.createElement('option')
      option.value = character.actorId
      option.textContent = character.name
      return option
    }))
    if (selected && result.characters.some((character) => character.actorId === selected)) $('joinCharacter').value = selected
  }

  showContextHud(title, actions) {
    const hud = $('worldContext')
    $('worldContextName').textContent = title || 'Interact'
    const list = $('worldContextActions')
    list.replaceChildren(...actions.map((action) => {
      const button = document.createElement('button')
      button.type = 'button'
      if (action.art) {
        const art = document.createElement('img')
        art.className = 'context-art'
        art.src = assetUrl(action.art)
        art.alt = ''
        art.onerror = () => art.remove()
        button.append(art)
      } else if (action.icon) {
        button.dataset.icon = action.icon
        const icon = document.createElement('span')
        icon.className = 'context-icon'
        icon.style.setProperty('--icon-url', `url("/icons/${action.icon}.svg")`)
        icon.setAttribute('aria-hidden', 'true')
        button.append(icon)
      }
      button.append(document.createTextNode(action.label))
      button.onclick = () => { this.hideContextHud(); action.run?.() }
      return button
    }))
    hud.hidden = false
  }

  positionContextHud(x, y) {
    const hud = $('worldContext')
    if (hud.hidden) return
    const width = hud.offsetWidth
    const height = hud.offsetHeight
    // Keep the panel and its pointer geometrically centered on the sprite.
    hud.style.left = `${x - width / 2}px`
    hud.style.top = `${y - height - 18}px`
  }

  hideContextHud() {
    $('worldContext').hidden = true
  }

  async connect() {
    const config = {
      url: $('url').value.trim(),
      name: $('name').value.trim() || 'Hero',
      room: $('room').value.trim() || 'default',
    }
    save('fb.connect', config)
    this.setStatus(false, 'Connecting…')
    try {
      await this.loadCharacters()
      const response = await fetch(`/api/v2/open/${encodeURIComponent(config.room)}/select`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actorId: $('joinCharacter').value, name: config.name }) })
      const auth = await response.json()
      if (!response.ok) throw new Error(auth.error?.message || 'Could not join.')
      this.sessionToken = auth.sessionToken
      this.claimedTokenId = auth.tokenId
      localStorage.setItem('fb.sessionToken', auth.sessionToken)
      save('fb.session', { campaignId: auth.campaignId, tokenId: auth.tokenId, name: auth.name, expiresAt: auth.expiresAt })
      save('fb.claimedTokenId', auth.tokenId)
      this.bridge.connect({ url: config.url, campaignId: auth.campaignId, sessionToken: auth.sessionToken })
    } catch (error) {
      this.setStatus(false, error.message)
      return
    }
    $('connect').hidden = true
    $('claim').hidden = false
  }

  disconnect() {
    this.bridge.close()
    localStorage.removeItem('fb.sessionToken')
    localStorage.removeItem('fb.session')
    $('claim').hidden = true
    $('hud').hidden = true
    $('connect').hidden = false
  }

  onSnapshot(payload) {
    this.snapshot = payload
    $('sceneName').textContent = payload.scene?.name || 'No scene'
    const fromSnapshot = payload.playableCharacters || []
    const fromEntities = (payload.entities || [])
      .filter((entity) => entity.documentType === 'Token' && (entity.claimable || entity.actor?.type === 'character'))
      .map((entity) => ({
        tokenId: entity.documentId,
        actorId: entity.actor?.id,
        name: entity.name,
        textureUrl: entity.textureUrl,
        claimedByConnectionId: entity.claimedByConnectionId,
        claimedByName: entity.claimedByName,
      }))
    this.renderCharacters(fromSnapshot.length ? fromSnapshot : fromEntities)
    this.combat = payload.combat || this.combat
    if (this.claimedTokenId) {
      const still = (payload.playableCharacters || []).find((entry) => entry.tokenId === this.claimedTokenId)
      if (still) this.enterPlay()
    }
  }

  patchEntity(entity, removed) {
    if (!this.snapshot || !entity?.id) return
    if (removed) {
      this.snapshot.entities = (this.snapshot.entities || []).filter((entry) => entry.id !== entity.id)
    } else {
      const list = this.snapshot.entities || []
      const index = list.findIndex((entry) => entry.id === entity.id)
      if (index >= 0) list[index] = entity
      else list.push(entity)
      this.snapshot.entities = list
    }
    this.renderVitals()
  }

  renderCharacters(list) {
    const box = $('characterList')
    if (!list.length) {
      box.innerHTML = '<p class="sub">The DM has not placed a playable character yet.</p>'
      return
    }
    box.innerHTML = ''
    for (const character of list) {
      const taken = character.claimedByConnectionId && character.claimedByConnectionId !== this.bridge.connectionId
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'character'
      button.disabled = !!taken
      const img = assetUrl(character.textureUrl)
      const portrait = img ? document.createElement('img') : document.createElement('div')
      if (img) {
        portrait.src = img
        portrait.alt = ''
      } else {
        portrait.className = 'fallback'
      }
      const copy = document.createElement('div')
      copy.innerHTML = `<strong>${escapeHtml(character.name)}</strong><div class="sub">${taken ? 'Already claimed' : 'Tap to play'}</div>`
      button.append(portrait, copy)
      button.onclick = () => this.claim(character.tokenId)
      box.appendChild(button)
    }
  }

  async claim(tokenId) {
    try {
      if (tokenId !== this.claimedTokenId) throw new Error('This session belongs to another character.')
      this.claimedTokenId = tokenId
      save('fb.claimedTokenId', tokenId)
      this.scene()?.setClaimed(tokenId)
      this.enterPlay()
    } catch (error) {
      this.setStatus(false, error.message)
    }
  }

  enterPlay() {
    $('connect').hidden = true
    $('claim').hidden = true
    $('hud').hidden = false
    this.scene()?.setClaimed(this.claimedTokenId)
    this.renderVitals()
    this.renderCombat()
    this.renderActionBar()
  }

  claimedEntity() {
    return (this.snapshot?.entities || []).find((entity) => entity.documentId === this.claimedTokenId)
  }

  renderVitals() {
    const entity = this.claimedEntity()
    const sheet = this.sheet
    $('heroName').textContent = sheet?.name || entity?.name || '—'
    const hp = sheet?.hp ?? entity?.actor?.hp
    const max = sheet?.maxHp ?? entity?.actor?.maxHp
    $('hpText').textContent = hp != null ? `HP ${hp}${max != null ? `/${max}` : ''}` : 'HP —'
    $('hpFill').style.width = max ? `${Math.max(0, Math.min(100, (hp / max) * 100))}%` : '0%'
    $('conditions').textContent = (sheet?.conditions || []).join(' · ')
  }

  renderCombat() {
    const banner = $('combatBanner')
    if (!this.combat?.started) {
      banner.hidden = true
      return
    }
    const current = this.combat.combatants?.find((entry) => entry.id === this.combat.combatantId)
    const mine = current?.tokenId === this.claimedTokenId
    banner.hidden = false
    banner.textContent = mine
      ? `Your turn · round ${this.combat.round}`
      : `${current?.name || 'Someone'}'s turn · round ${this.combat.round}`
  }

  isMyTurn() {
    if (!this.combat?.started) return true
    const current = this.combat.combatants?.find((entry) => entry.id === this.combat.combatantId)
    return current?.tokenId === this.claimedTokenId
  }

  renderActionBar() {
    const bar = $('actionBar')
    if (!this.combat?.started && !this.armedAction) {
      bar.replaceChildren()
      return
    }
    const actions = (this.sheet?.actions || []).filter((action) => action.available !== false).slice(0, 6)
    if (!actions.length) {
      bar.innerHTML = this.combat?.started
        ? '<button type="button" data-init="1">Roll initiative</button>'
        : ''
      bar.querySelector('[data-init]')?.addEventListener('click', () => {
        this.bridge.command('combat.rollInitiative', { tokenId: this.claimedTokenId }).catch((error) => this.float(error.message))
      })
      return
    }
    bar.innerHTML = ''
    for (const action of actions) {
      const button = document.createElement('button')
      button.type = 'button'
      const art = assetUrl(action.img)
      if (art) {
        const img = document.createElement('img')
        img.className = 'quick-action-art'
        img.src = art
        img.alt = ''
        img.onerror = () => img.remove()
        button.append(img)
      }
      button.append(document.createTextNode(action.name))
      button.disabled = !this.isMyTurn() || action.available === false
      if (this.armedAction && this.armedAction.itemId === action.itemId && this.armedAction.activityId === action.activityId) {
        button.classList.add('armed')
      }
      button.onclick = () => this.chooseAction(action)
      bar.appendChild(button)
    }
  }

  armAction(action) {
    this.armedAction = action
    this.float(`Choose a target for ${action.name}`)
    this.renderActionBar()
  }

  async chooseAction(action, targetIds = []) {
    if (!action || !this.claimedTokenId) return
    try {
      const preflight = await this.bridge.command('action.preflight', {
        tokenId: this.claimedTokenId,
        itemId: action.itemId,
        activityId: action.activityId,
        targetIds,
      })
      if (preflight.needsTarget) {
        this.armAction(action)
        return
      }
      this.openActionOptions(action, targetIds)
    } catch (error) {
      this.float(error.message)
    }
  }

  openActionOptions(action, targetIds = []) {
    const isAttack = String(action.activityType || '').toLowerCase() === 'attack'
    this.scene()?.hideContextHud()
    $('interact').hidden = false
    $('interactTitle').textContent = action.name
    $('interactBody').innerHTML = `
      <form class="roll-options-form">
        <p class="roll-options-hint">${isAttack ? 'How are you making this attack?' : 'Confirm this action and choose who sees the result.'}</p>
        ${isAttack ? `<div class="roll-mode-grid" role="radiogroup" aria-label="Attack roll mode">
          <label class="roll-mode"><input type="radio" name="rollMode" value="normal" checked><span>Normal</span><small>1d20</small></label>
          <label class="roll-mode advantage"><input type="radio" name="rollMode" value="advantage"><span>Advantage</span><small>Keep higher</small></label>
          <label class="roll-mode disadvantage"><input type="radio" name="rollMode" value="disadvantage"><span>Disadvantage</span><small>Keep lower</small></label>
        </div>
        <label class="roll-bonus">Situational modifier <input name="bonus" type="number" inputmode="numeric" min="-20" max="20" step="1" value="0" aria-label="Situational roll modifier"></label>` : ''}
        <fieldset class="action-sharing">
          <legend>Share result</legend>
          <label><input type="radio" name="channel" value="party" checked><span>Party</span><small>All players and DM</small></label>
          <label><input type="radio" name="channel" value="private"><span>Private</span><small>Only you and DM</small></label>
        </fieldset>
        <button class="roll-submit" type="submit">${isAttack ? 'Roll attack' : 'Use action'}</button>
      </form>`
    const form = $('interactBody').querySelector('form')
    form.onsubmit = async (event) => {
      event.preventDefault()
      const submit = form.querySelector('[type="submit"]')
      submit.disabled = true
      const data = new FormData(form)
      const bonus = Math.max(-20, Math.min(20, Math.trunc(Number(data.get('bonus')) || 0)))
      $('interact').hidden = true
      await this.useAction(action, targetIds, {
        rollMode: data.get('rollMode') || 'normal',
        bonus,
        channel: data.get('channel') || 'party',
      })
    }
  }

  async useAction(action, targetIds = [], options = {}) {
    if (!action || !this.claimedTokenId) return
    try {
      await this.bridge.command('action.execute', {
        tokenId: this.claimedTokenId,
        itemId: action.itemId,
          activityId: action.activityId,
          targetIds,
          options,
        })
    } catch (error) {
      this.float(error.message)
    } finally {
      this.armedAction = null
      this.renderActionBar()
    }
  }

  async onWorldTap(target) {
    if (this.armedAction && target.kind === 'entity' && target.entity.documentType === 'Token') {
      await this.chooseAction(this.armedAction, [target.entity.documentId])
      return
    }
    if (target.kind === 'ground') {
      this.scene()?.hideContextHud()
      if (!this.claimedTokenId) return
      const scene = this.scene()
      if (this.movementPending || scene?.isWalking(`Token.${this.claimedTokenId}`)) return
      this.movementPending = true
      try {
        const result = await this.bridge.command('movement.request', {
          tokenId: this.claimedTokenId,
          destination: target.position,
        })
        // The authoritative event normally arrives first. Use the response as a
        // reconnect-safe fallback without ever animating before Foundry accepts.
        if (!scene?.isWalking(`Token.${this.claimedTokenId}`)) scene?.onTokenMoved(result)
      } catch (error) {
        scene?.shakeBlocked()
        this.float(error.message)
      } finally {
        this.movementPending = false
      }
      return
    }
    if (target.kind === 'door') {
      this.scene()?.showDoorHud(target.wall, [
        { label: target.wall.doorState === 'open' ? 'Close' : 'Open', icon: 'door', run: () => this.toggleDoor(target.wall) },
        { label: 'Examine', icon: 'inspect', run: () => this.openIntentComposer(null, 'examine', 'Describe what you do with the door…', `Wall.${target.wall.wallId}`) },
      ])
      return
    }
    this.showEntityActions(target.entity)
  }

  showEntityActions(entity) {
    const hostile = Number(entity.disposition) < 0
    const isSelf = entity.documentId === this.claimedTokenId
    const npc = entity.actor?.type === 'npc' || entity.entityType === 'npc'
    const actions = []
    if (isSelf) {
      actions.push({ label: 'Actions', icon: 'attack', run: () => this.openSheet('act') }, { label: 'Items', icon: 'items', run: () => this.openSheet('bag') }, { label: 'Chat', icon: 'talk', run: () => this.openSheet('chat') })
    } else {
      if (npc) actions.push({ label: 'Talk', icon: 'talk', run: () => this.talkTo(entity) })
      const smart = this.relevantActions(entity).slice(0, hostile ? 2 : 1)
      for (const action of smart) actions.push({
        label: action.name,
        icon: action.icon === 'heal' ? 'items' : 'attack',
        art: action.img,
        run: () => this.chooseAction(action, [entity.documentId]),
      })
      if (hostile && (this.sheet?.actions || []).length > smart.length) {
        actions.push({ label: 'More', icon: 'items', run: () => this.openSheet('act', entity.documentId) })
      } else if (entity.interaction?.freeform !== false) {
        actions.push({ label: 'Interact', icon: 'door', run: () => this.openIntentComposer(entity) })
      }
      actions.push({ label: 'Inspect', icon: 'inspect', run: () => this.openIntentComposer(entity, 'inspect', `What do you want to learn about ${entity.name}?`) })
    }
    this.scene()?.showEntityHud(entity, actions)
  }

  relevantActions(entity) {
    const hostile = Number(entity?.disposition) < 0
    return (this.sheet?.actions || [])
      .filter((action) => action.available !== false && action.category !== 'reaction')
      .filter((action) => {
        const kind = String(action.activityType || '').toLowerCase()
        if (hostile) return action.type === 'weapon' || ['attack', 'save', 'damage'].includes(kind)
        return ['heal', 'utility'].includes(kind) || action.target?.self
      })
      .sort((a, b) => Number(b.type === 'weapon') - Number(a.type === 'weapon'))
  }

  talkTo(entity) {
    this.npcTarget = entity.id
    $('chatChannel').value = 'npc'
    this.openSheet('chat')
    requestAnimationFrame(() => $('chatText').focus())
  }

  async attackEntity(entity) {
    const attack = this.relevantActions(entity)[0]
    if (!attack) return this.float('No usable attack is available.')
    await this.chooseAction(attack, [entity.documentId])
  }

  async toggleDoor(wall) {
    try { await this.bridge.command('door.toggle', { wallId: wall.wallId }) }
    catch (error) { this.float(error.message) }
  }

  openIntentComposer(entity, verb = 'interact', placeholder = 'Describe what you attempt…', targetEntityId = null) {
    $('interact').hidden = false
    $('interactTitle').textContent = entity?.name || 'Interact'
    $('interactBody').innerHTML = `<form class="intent-form"><textarea name="text" rows="3" placeholder="${escapeHtml(placeholder)}" required></textarea><button type="submit">Send to the DM</button></form>`
    $('interactBody').querySelector('form').onsubmit = async (event) => {
      event.preventDefault()
      await this.submitIntent(entity || { id: targetEntityId }, verb, new FormData(event.currentTarget).get('text'))
    }
    requestAnimationFrame(() => $('interactBody').querySelector('textarea')?.focus())
  }

  openInteractDoor(wall) {
    $('interact').hidden = false
    $('interactTitle').textContent = wall.doorState === 'open' ? 'Open door' : 'Door'
    $('interactBody').innerHTML = `<div class="interact-actions">
      <button type="button" data-door="${wall.wallId}">${wall.doorState === 'open' ? 'Close' : 'Open'}</button>
    </div>`
    $('interactBody').querySelector('button').onclick = async () => {
      try {
        await this.bridge.command('door.toggle', { wallId: wall.wallId })
        $('interact').hidden = true
      } catch (error) {
        this.float(error.message)
      }
    }
  }

  openInteractEntity(entity) {
    $('interact').hidden = false
    $('interactTitle').textContent = entity.name
    const hostile = Number(entity.disposition) < 0
    const isSelf = entity.documentId === this.claimedTokenId
    const npc = entity.actor?.type === 'npc' || entity.entityType === 'npc'
    const buttons = []
    if (!isSelf && npc) buttons.push(['Talk', 'talk'])
    if (!isSelf && hostile) buttons.push(['Attack', 'attack'])
    if (entity.interaction?.freeform !== false && !isSelf) {
      buttons.push(['Search', 'search'], ['Persuade', 'persuade'], ['Inspect', 'inspect'])
    }
    $('interactBody').innerHTML = `
      <div class="interact-actions">
        ${buttons.map(([label, verb]) => `<button type="button" data-verb="${escapeHtml(verb)}">${escapeHtml(label)}</button>`).join('')}
      </div>
      <form class="intent-form">
        <input name="verb" placeholder="Custom verb" />
        <textarea name="text" rows="2" placeholder="Declare what you attempt…"></textarea>
        <button type="submit">Send intent</button>
      </form>`
    $('interactBody').querySelectorAll('[data-verb]').forEach((button) => {
      button.onclick = () => this.quickVerb(entity, button.dataset.verb)
    })
    $('interactBody').querySelector('form').onsubmit = async (event) => {
      event.preventDefault()
      const data = new FormData(event.currentTarget)
      await this.submitIntent(entity, data.get('verb') || 'do', data.get('text'))
    }
  }

  async quickVerb(entity, verb) {
    if (verb === 'talk') {
      this.npcTarget = entity.id
      $('chatChannel').value = 'npc'
      $('interact').hidden = true
      this.openSheet('chat')
      return
    }
    if (verb === 'attack') {
      const attack = (this.sheet?.actions || []).find((action) => action.type === 'weapon') || this.sheet?.actions?.[0]
      if (attack) {
        await this.chooseAction(attack, [entity.documentId])
      }
      $('interact').hidden = true
      return
    }
    await this.submitIntent(entity, verb, `${this.claimedEntity()?.name || 'I'} ${verb} ${entity.name}.`)
  }

  async submitIntent(entity, verb, text) {
    try {
      await this.bridge.command('intent.submit', {
        targetEntityId: entity?.id,
        verb,
        text: String(text || '').trim(),
      })
      this.float('The DM has your intent.')
      $('interact').hidden = true
    } catch (error) {
      this.float(error.message)
    }
  }

  openSheet(kind, targetId = null) {
    $('sheet').hidden = false
    $('chatForm').hidden = kind !== 'chat'
    this.actionTargetId = kind === 'chat' ? null : targetId
    this.actionSheetCategory = kind === 'bag' ? 'item' : 'all'
    $('sheetTitle').textContent = kind === 'chat' ? 'Chat' : kind === 'bag' ? 'Features & items' : 'Actions'
    if (kind === 'chat') this.renderChat()
    else this.renderActionSheet(kind)
  }

  closeSheet() {
    $('sheet').hidden = true
    this.actionTargetId = null
  }

  renderChat() {
    const selectedChannel = $('chatChannel').value
    const lines = this.chat.filter((line) => {
      if (selectedChannel === 'npc') {
        return line.channel === 'npc'
          && (!this.npcTarget || line.targetEntityId === this.npcTarget || line.speakerEntityId === this.npcTarget)
      }
      if (selectedChannel === 'party') return line.channel === 'party' || line.channel === 'private'
      return line.channel === selectedChannel
    })
    $('sheetBody').innerHTML = lines.slice(-80).map((line) => (
      `<p class="chat-line"><span class="who">${escapeHtml(line.speaker || '??')}</span> · ${escapeHtml(line.text)}</p>`
    )).join('') || '<p class="sub">No messages yet.</p>'
    $('sheetBody').scrollTop = $('sheetBody').scrollHeight
  }

  renderActionSheet(kind) {
    const actions = this.sheet?.actions || []
    const categories = [
      ['all', 'All'], ['action', 'Actions'], ['bonus', 'Bonus'], ['spell', 'Spells'],
      ['feature', 'Features'], ['item', 'Items'], ['reaction', 'Reactions'],
    ].filter(([id]) => id === 'all' || actions.some((action) => action.category === id))
    if (kind === 'bag' && this.actionSheetCategory === 'all') this.actionSheetCategory = 'item'
    const filtered = this.actionSheetCategory === 'all'
      ? actions
      : actions.filter((action) => action.category === this.actionSheetCategory)
    const generic = /^(attack|damage|heal|save|use|check|utility)$/i
    const badge = (text, className = '') => text ? `<span class="action-badge ${className}">${escapeHtml(text)}</span>` : ''
    $('sheetBody').innerHTML = `
      <nav class="action-tabs" aria-label="Action categories">
        ${categories.map(([id, label]) => `<button type="button" data-category="${id}" class="${this.actionSheetCategory === id ? 'active' : ''}">${label}</button>`).join('')}
      </nav>
      ${this.actionTargetId ? '<p class="target-note">Choose an action for the selected target</p>' : ''}
      <div class="action-list">${filtered.map((action, index) => {
        const activation = action.activation?.type
        const activity = action.activityName && !generic.test(action.activityName) ? action.activityName : null
        const range = action.range?.value ? `${action.range.value} ${action.range.units || 'ft'}` : null
        const uses = action.uses ? `${action.uses.value}/${action.uses.max} uses` : null
        const resource = action.resource?.value != null ? `${action.resource.value}/${action.resource.max} slots` : action.resource?.label
        return `<button type="button" class="action-card" data-action-index="${index}" ${action.available === false ? 'disabled' : ''}>
          <span class="action-kind" data-kind="${escapeHtml(action.icon || 'attack')}" data-art-index="${index}"></span>
          <span class="action-copy"><strong>${escapeHtml(action.name)}</strong>${activity ? `<small>${escapeHtml(activity)}</small>` : ''}
            <span class="action-badges">${badge(activation)}${badge(range)}${badge(uses || resource, action.available === false ? 'empty' : '')}</span>
            ${action.unavailableReason ? `<small class="unavailable">${escapeHtml(action.unavailableReason)}</small>` : ''}
          </span>
        </button>`
      }).join('') || '<p class="empty-actions">Nothing usable in this category.</p>'}</div>`
    $('sheetBody').querySelectorAll('[data-art-index]').forEach((slot) => {
      const action = filtered[Number(slot.dataset.artIndex)]
      const src = assetUrl(action?.img)
      if (!src) return
      const img = document.createElement('img')
      img.src = src
      img.alt = ''
      img.loading = 'lazy'
      slot.classList.add('has-art')
      img.onerror = () => { slot.classList.remove('has-art'); img.remove() }
      slot.append(img)
    })
    $('sheetBody').querySelectorAll('[data-category]').forEach((button) => {
      button.onclick = () => {
        this.actionSheetCategory = button.dataset.category
        this.renderActionSheet(kind)
      }
    })
    $('sheetBody').querySelectorAll('[data-action-index]').forEach((button) => {
      button.onclick = async () => {
        const action = filtered[Number(button.dataset.actionIndex)]
        const targets = this.actionTargetId ? [this.actionTargetId] : []
        this.closeSheet()
        await this.chooseAction(action, targets)
      }
    })
  }

  addChat(payload) {
    this.chat.push(payload)
    $('chatPeek').textContent = `${payload.speaker}: ${payload.text}`
    this.scene()?.showSpeech(payload.speakerEntityId, payload.speaker, payload.text)
    if (!$('sheet').hidden && !$('chatForm').hidden) this.renderChat()
  }

  async sendChat() {
    const text = $('chatText').value.trim()
    if (!text) return
    const channel = $('chatChannel').value
    try {
      await this.bridge.command('chat.send', {
        text,
        channel,
        targetEntityId: channel === 'npc' ? this.npcTarget : undefined,
      })
      $('chatText').value = ''
    } catch (error) {
      this.float(error.message)
    }
  }

  onRoll(payload) {
    const total = payload.totals?.[0]
    const text = `${payload.speaker}: ${payload.flavor || 'roll'} ${total ?? ''}`.trim()
    this.chat.push({
      channel: payload.channel || 'party',
      speaker: payload.speaker,
      text: `${payload.flavor || 'Roll'}: ${total ?? '-'}`,
      createdAt: Date.now(),
      roll: true,
    })
    if (!$('sheet').hidden && !$('chatForm').hidden) this.renderChat()
    this.float(text)
    const targetId = payload.targetIds?.[0]
    if (targetId && total != null) this.scene()?.floatText(targetId, String(total), payload.isCrit ? '#e8c36a' : '#e07060')
  }

  onActionResult(payload) {
    const outcomes = (payload.applied || []).map((entry) => {
      if (!entry.hit) return `${entry.name}: miss`
      if (entry.hpDelta > 0) return `${entry.name}: ${entry.hpDelta} damage`
      if (entry.hpDelta < 0) return `${entry.name}: ${Math.abs(entry.hpDelta)} healed`
      return `${entry.name}: no damage`
    })
    const resultText = `uses ${payload.itemName || payload.action}${outcomes.length ? ` — ${outcomes.join(', ')}` : ''}`
    this.chat.push({
      channel: payload.channel || 'party',
      speaker: payload.speaker,
      speakerEntityId: payload.speakerEntityId,
      text: resultText,
      createdAt: payload.createdAt || Date.now(),
      action: true,
    })
    $('chatPeek').textContent = `${payload.speaker}: ${resultText}`
    if (!$('sheet').hidden && !$('chatForm').hidden) this.renderChat()
    if (outcomes.length) this.float(outcomes.join(' · '))
  }

  float(text) {
    const log = $('floatLog')
    const line = document.createElement('div')
    line.textContent = text
    log.appendChild(line)
    setTimeout(() => line.remove(), 2800)
  }

  debug(message) {
    const el = $('debugLog')
    if (!el) return
    const extra = message.type === 'world.snapshot' ? { revision: message.payload?.revision } : message
    el.textContent += `${message.type} ${JSON.stringify(extra)}\n`
    if (el.textContent.length > 8000) el.textContent = el.textContent.slice(-4000)
  }
}
