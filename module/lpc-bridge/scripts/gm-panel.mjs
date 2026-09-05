import { resolveIntent, speakAsNpc } from './chat.mjs'
import { MODULE_ID, tokenDisplayName } from './snapshot.mjs'

const ApplicationV2 = foundry.applications?.api?.ApplicationV2

function escape(value) {
  return foundry.utils.escapeHTML(String(value ?? ''))
}

function npcTokens(bridge) {
  const scene = bridge.activeScene()
  if (!scene) return []
  return [...scene.tokens].filter((token) => token.actor?.type !== 'character')
}

class BridgeMonitor extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: 'lpc-bridge-monitor',
    classes: ['lpc-bridge-monitor'],
    tag: 'div',
    window: { title: 'Foundry Bridge · Live table', icon: 'fa-solid fa-satellite-dish', resizable: true },
    position: { width: 440, height: 720 },
  }

  constructor(bridge, options = {}) {
    super(options)
    this.bridge = bridge
  }

  async _prepareContext() {
    const combat = this.bridge.combatState()
    return {
      connected: this.bridge.ws?.readyState === WebSocket.OPEN,
      roomId: this.bridge.roomId,
      players: [...this.bridge.clients.entries()].map(([id, client]) => {
        const token = this.bridge.activeScene()?.tokens?.get(client.claimedTokenId)
        return {
          id,
          name: tokenDisplayName(token) || client.characterName || 'Not in character',
          status: token ? 'in play' : 'waiting to claim',
        }
      }),
      intents: [...this.bridge.intents.values()].filter((intent) => intent.status === 'open'),
      npcs: npcTokens(this.bridge),
      npcThreads: [...this.bridge.npcThreads.values()].filter((thread) => thread.connectionId),
      resolutions: this.bridge.resolutions.slice(0, 6),
      combat,
    }
  }

  async _renderHTML(context) {
    const players = context.players.map((player) => `
      <li data-connection-id="${escape(player.id)}">
        <strong>${escape(player.name)}</strong>
        <small>${escape(player.status)}</small>
        <button type="button" data-action="release" data-connection-id="${escape(player.id)}">Release</button>
      </li>`).join('') || '<li class="fb-empty">No players connected.</li>'

    const intents = context.intents.map((intent) => `
      <article class="fb-intent" data-intent-id="${escape(intent.id)}">
        <header><strong>${escape(intent.character)}</strong> wants to <em>${escape(intent.verb)}</em></header>
        <p>${escape(intent.text)}</p>
        <small>${escape(intent.targetName || 'the world')}</small>
        <div class="fb-row-actions">
          <button type="button" data-action="narrate" data-intent-id="${escape(intent.id)}">Narrate</button>
          <button type="button" data-action="deny" data-intent-id="${escape(intent.id)}">Deny</button>
          <button type="button" data-action="speak-intent" data-intent-id="${escape(intent.id)}">Speak as target</button>
        </div>
      </article>`).join('') || '<p class="fb-empty">No open intents.</p>'

    const npcOptions = context.npcs.map((token) => `<option value="Token.${escape(token.id)}">${escape(token.name)}</option>`).join('')
    const selectedNpc = this._npcId || context.npcs[0] && `Token.${context.npcs[0].id}`
    const npcThreads = context.npcThreads.filter((thread) => thread.entityId === selectedNpc)
    const selectedThread = npcThreads.find((thread) => thread.key === this._npcThreadKey) || npcThreads[0] || null
    this._npcThreadKey = selectedThread?.key || null
    const thread = selectedThread || { messages: [] }
    const threadOptions = npcThreads.map((entry) => `<option value="${escape(entry.key)}">${escape(entry.playerName || 'Player')}</option>`).join('')
    const threadHtml = thread.messages.slice(-12).map((line) => `
      <p class="fb-thread-line"><strong>${escape(line.name || line.from)}</strong> ${escape(line.text)}</p>
    `).join('') || '<p class="fb-empty">No NPC conversation yet.</p>'

    const combatLine = context.combat.started
      ? `Round ${context.combat.round} · ${escape(context.combat.combatants.find((entry) => entry.id === context.combat.combatantId)?.name || '—')}`
      : 'No combat'

    const resolutions = context.resolutions.map((resolution) => {
      const targets = resolution.applied.map((entry) => {
        if (!entry.hit) return `${entry.name}: miss`
        if (entry.multiplier === 0.5) return `${entry.name}: saved, half`
        return entry.name
      }).join(' · ')
      return `<li class="fb-resolution ${resolution.undoneAt ? 'is-undone' : ''}">
        <span><strong>${escape(resolution.label)}</strong><small>${escape(targets || 'resource used')}</small></span>
        <button type="button" data-action="undo-resolution" data-resolution-id="${escape(resolution.id)}" ${resolution.undoneAt ? 'disabled' : ''}>
          ${resolution.undoneAt ? 'Undone' : 'Undo'}
        </button>
      </li>`
    }).join('') || '<li class="fb-empty">No Fast-mode resolutions yet.</li>'

    const html = `<div class="foundry-bridge-authoring lpc-bridge-panel">
      <section>
        <header class="fb-panel-head">
          <strong>${context.connected ? 'Connected' : 'Offline'}</strong>
          <small>Room ${escape(context.roomId)}</small>
        </header>
        <div class="fb-row-actions">
          <button type="button" data-action="push">Push world</button>
          <button type="button" data-action="reconnect">Reconnect</button>
        </div>
      </section>
      <section>
        <h3>Players</h3>
        <ul class="fb-player-list">${players}</ul>
      </section>
      <section>
        <h3>Combat</h3>
        <p>${combatLine}</p>
        <div class="fb-row-actions">
          <button type="button" data-action="next-turn">Next turn</button>
          <button type="button" data-action="end-combat">End combat</button>
        </div>
      </section>
      <section>
        <header class="fb-panel-head"><h3>Fast mode</h3><small>Foundry rolls and applies results</small></header>
        <ul class="fb-player-list fb-resolution-list">${resolutions}</ul>
      </section>
      <section>
        <h3>Intent queue</h3>
        ${intents}
      </section>
      <section>
        <h3>NPC desk</h3>
        <div class="form-group">
          <label>Speak as</label>
          <select name="npcId">${npcOptions}</select>
        </div>
        <div class="form-group">
          <label>Conversation</label>
          <select name="npcThread" ${threadOptions ? '' : 'disabled'}>${threadOptions || '<option>No private conversations</option>'}</select>
        </div>
        <div class="fb-thread">${threadHtml}</div>
        <div class="form-group stacked">
          <textarea name="npcText" rows="2" placeholder="Reply as this NPC…"></textarea>
        </div>
        <div class="fb-row-actions">
          <button type="button" data-action="npc-public">Say in scene</button>
          <button type="button" data-action="npc-private" ${selectedThread ? '' : 'disabled'}>Reply privately</button>
        </div>
      </section>
    </div>`
    const wrap = document.createElement('div')
    wrap.innerHTML = html
    return wrap.firstElementChild
  }

  _replaceHTML(result, content) {
    const host = content instanceof HTMLElement ? content : content?.element || this.element
    if (!host) return
    if (typeof result === 'string') host.innerHTML = result
    else if (result instanceof HTMLElement) host.replaceChildren(result)
    else host.innerHTML = String(result || '')
    this._bind(host)
  }

  _bind(root) {
    const select = root.querySelector('[name="npcId"]')
    if (select) {
      if (this._npcId) select.value = this._npcId
      this._npcId = select.value
      select.addEventListener('change', () => {
        this._npcId = select.value
        this._npcThreadKey = null
        this.render({ force: true })
      })
    }
    const threadSelect = root.querySelector('[name="npcThread"]')
    if (threadSelect && !threadSelect.disabled) {
      if (this._npcThreadKey) threadSelect.value = this._npcThreadKey
      this._npcThreadKey = threadSelect.value
      threadSelect.addEventListener('change', () => {
        this._npcThreadKey = threadSelect.value
        this.render({ force: true })
      })
    }
    root.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', (event) => this._onAction(event.currentTarget))
    })
  }

  async _onAction(button) {
    const action = button.dataset.action
    const bridge = this.bridge
    const root = this.element
    try {
      if (action === 'push') await bridge.pushSnapshot()
      if (action === 'reconnect') {
        bridge.connect()
        setTimeout(() => bridge.pushSnapshot(), 400)
      }
      if (action === 'release') await bridge.releaseConnection(button.dataset.connectionId)
      if (action === 'next-turn') await game.combat?.nextTurn?.()
      if (action === 'end-combat') await game.combat?.endCombat?.()
      if (action === 'undo-resolution') {
        await bridge.undoResolution(button.dataset.resolutionId)
        ui.notifications?.info('Fast-mode resolution undone.')
      }
      if (action === 'narrate' || action === 'deny' || action === 'speak-intent') {
        const intent = bridge.intents.get(button.dataset.intentId)
        if (!intent) return
        if (action === 'deny') {
          await resolveIntent(bridge, intent.id, { ok: false, narrative: 'That does not work.' })
          return
        }
        if (action === 'speak-intent' && intent.targetEntityId) {
          this._npcId = intent.targetEntityId
          this._npcThreadKey = bridge.threadFor(intent.targetEntityId, intent.connectionId).key
          await resolveIntent(bridge, intent.id, { ok: true, narrative: '' })
          this.render({ force: true })
          return
        }
        const narrative = await foundry.applications.api.DialogV2.prompt({
          window: { title: 'Narrate the result' },
          content: `<p>${escape(intent.character)} wanted to ${escape(intent.verb)}.</p><textarea name="narrative" rows="3" placeholder="What happens?"></textarea>`,
          ok: {
            label: 'Narrate',
            callback: (_event, buttonEl) => buttonEl.form?.querySelector('[name="narrative"]')?.value
              || (buttonEl.querySelector?.('[name="narrative"]')?.value)
              || '',
          },
        }).catch(() => null)
        if (narrative != null) await resolveIntent(bridge, intent.id, { ok: true, narrative: String(narrative).trim() || `${intent.character} succeeds.` })
      }
      if (action === 'npc-public' || action === 'npc-private') {
        const entityId = root.querySelector('[name="npcId"]')?.value
        const connectionId = action === 'npc-private'
          ? bridge.npcThreads.get(root.querySelector('[name="npcThread"]')?.value)?.connectionId
          : null
        const text = root.querySelector('[name="npcText"]')?.value
        await speakAsNpc(bridge, { entityId, text, publicBroadcast: action === 'npc-public', connectionId })
        const box = root.querySelector('[name="npcText"]')
        if (box) box.value = ''
      }
    } catch (error) {
      console.error(`${MODULE_ID} | GM panel action failed`, error)
      ui.notifications?.error(error?.message || 'Bridge panel action failed.')
    }
    this.render({ force: true })
  }
}

export function installGmPanel(bridge) {
  const open = () => {
    if (!bridge.gmPanel) bridge.gmPanel = new BridgeMonitor(bridge)
    bridge.gmPanel.render({ force: true })
  }
  bridge.openGmPanel = open
  return open
}
