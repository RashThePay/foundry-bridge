# Foundry Bridge (spike)

External **player client** ↔ **WebSocket bridge** ↔ **Foundry module** (DM panel + dnd5e).

Players never open Foundry. Foundry stays authoritative for tokens, chat, and (later) rolls.

## Quick test

### 1. Install deps + link module

```bash
npm install
npm run link-module
```

This junctions `module/lpc-bridge` into:

`%LOCALAPPDATA%\FoundryVTT\Data\modules\lpc-bridge`

### 2. Start the bridge

```bash
npm run bridge
```

- Test client: http://localhost:3847/
- WebSocket: `ws://localhost:3847/ws`

### 3. Enable in Foundry

1. Launch Foundry, open a world (ideally with a scene + at least one token)
2. **Settings → Manage Modules** → enable **LPC Bridge (spike)**
3. Reload the world as GM
4. You should see “LPC Bridge connected”

Module setting default URL: `ws://127.0.0.1:3847/ws`

### 4. Prove the pipe

In the browser test client:

1. Connect (auto on load)
2. **Send chat** → appears in Foundry chat as `[LPC] Hero`
3. Set X/Y and **Move token** → token jumps on the current scene
4. **Send intent** → GM whisper with the proposed action

Token tools also get a plug button: reconnect + push token list to clients.

## Protocol (JSON)

| type | from | meaning |
|------|------|---------|
| `hello` | both | `{ role: 'foundry' \| 'player', name? }` |
| `chat` | player | `{ text }` → Foundry `ChatMessage` |
| `move` | player | `{ tokenId?, tokenName?, x, y }` → `TokenDocument#update` |
| `intent` | player | `{ verb, target?, text? }` → GM whisper |
| `state` | foundry | scene + token list for the client |

## Next (not in spike)

- Auth / room codes
- LPC canvas client instead of this HTML form
- Intent queue UI in Foundry
- Call dnd5e roll helpers on resolve
