# Foundry Bridge

Foundry Bridge turns Foundry VTT into the authoritative rules engine, world
editor, and GM control plane for a **mobile-first 2D RPG client**. Players open
the client on a phone, claim a character, and play. The GM stays in Foundry.

```text
Player phones (Phaser 3, portrait)
        ↕ WebSocket Protocol v1
Room-aware gateway (also serves the client + scene assets)
        ↕
Foundry module
  ├─ scene map, tokens, tiles, walls, doors
  ├─ actor sheets, combat, rolls
  ├─ chat, NPC voice, custom intents
  └─ live GM panel
```

Players never need Foundry. The client renders the scene the DM authored:
background map, tokens, objects, walls, and doors. D&D actions and spells are
whatever exists on the Foundry actor. Custom interactions are declared intents
the DM resolves.

## Current product

- Versioned JSON protocol with commands, responses, events, audience scoping, and structured errors
- Multiple isolated rooms on one gateway
- Optional deployment access key through `BRIDGE_SECRET`
- Gateway asset cache so phones load maps and tokens without reaching Foundry HTTP
- Foundry-authoritative movement (walls, closed/locked doors, combat snap)
- Character claim/release and reconnect-by-name
- Public, party, and NPC chat; GM speak-as-NPC
- Custom intent queue with narrate / deny
- Combat state, initiative, and `action.use` through dnd5e items/activities
- Phaser 3 portrait client with tap-to-move, interact sheets, action bar, and chat
- Foundry toolbar authoring plus a live player-table panel

The full contract is documented in [PROTOCOL.md](PROTOCOL.md).

## Remote deployment

The bridge is the only public component. Foundry and all player browsers make
outbound connections to it, so the DM never exposes Foundry or configures port
forwarding. Copy `.env.example`, set the public HTTPS origin, then run
`docker compose up -d` behind a TLS reverse proxy.

The default `BRIDGE_ACCESS_MODE=open` flow needs no invites, PINs, or secrets.
Set the same room name in Foundry and the player client; players select an
available character and play. `secure` mode retains campaign credentials,
invites, PINs, session revocation, and private deployment controls when needed.

The Foundry module requires **Foundry VTT 14** (verified on 14.367) and does
not load on v13 worlds. Actions are built for the **dnd5e** system.

## Local setup

### 1. Install and link the module

```bash
npm install
npm run build
npm run link-module
```

The link script creates a Windows junction from `module/lpc-bridge` to:

```text
%LOCALAPPDATA%\FoundryVTT\Data\modules\lpc-bridge
```

### 2. Start the gateway (and optional Vite dev client)

Production-style (serves `client/dist`):

```bash
npm run bridge
```

Development (gateway + Vite with WebSocket/asset proxy):

```bash
npm run dev
```

- Player client: `http://localhost:3847/` or Vite at `http://localhost:5173/`
- WebSocket: `ws://localhost:3847/ws`
- Health/status: `http://localhost:3847/health`

To protect a deployed gateway with a shared key:

```bash
BRIDGE_SECRET=replace-me npm run bridge
```

Set the same value in the Foundry module and the client access-key field.

Phones on the same network should open the **machine's LAN address**, not
`127.0.0.1`, so the gateway can serve the map and token images.

### 3. Enable the Foundry module

1. Open a Foundry world as GM.
2. Enable **Foundry Bridge** in Manage Modules.
3. Configure the WebSocket URL, room ID, and optional access key in Module Settings.
4. Reload the world.

Only the active GM client connects to the gateway. Look for the **satellite-dish**
control on the left of the canvas (Foundry Bridge). That layer has:

- **Live player table** — connected players, intent queue, NPC desk, combat shortcuts
- LPC sprite registry, scene extras, and entity inspector
- Reconnect and push world

The same buttons also appear on the Token tools.

### 4. Play on a phone

1. Open the client URL.
2. Enter the same room ID (and access key if used).
3. Claim a character (Foundry actor type `character`, or a token marked claimable).
4. Tap the map to move, tap a creature or object to interact, use the action bar
   in combat, and chat with the party or an NPC.

The DM sees movement and chat in Foundry, answers as NPCs from the live panel,
and resolves custom intents without leaving the canvas.

## How authority is split

| Player does | Client shows | Foundry decides |
|---|---|---|
| Tap map | Walk animation | Collision, doors, control, combat snap |
| Tap door | Open/closed icon | Locked/secret/open |
| Use a spell or feature | Targeting, then the roll | dnd5e `activity.use()` / `item.use()` |
| Talk to an NPC | Private thread | GM reply as that NPC |
| Declare a custom action | Pending intent | GM narrate or deny |

## 2D authoring in Foundry

The default look is the **Foundry scene background plus token art**. For walk,
idle, combat, and action animations:

1. Download the full PNG from the
   [Universal LPC Character Generator](https://liberatedpixelcup.github.io/Universal-LPC-Spritesheet-Character-Generator/).
2. Put it in Foundry (File Picker) and register it in **LPC Sprite Registry**
   (64×64 frames, Auto-detect layout).
3. Select the token → **LPC Entity Inspector** → choose that sprite.

The client reads the generator layout (classic 21-row or expanded 54-row,
direction order up / left / down / right). It plays walk while moving,
idle or combat idle when standing, slash / thrust / spellcast / shoot on
`action.use`, and hurt when HP drops.

Scene flags (`flags.lpc-bridge.world2d`) still hold camera, lighting, fog, and
logical map IDs. Token/Tile flags (`entity2d`) hold sprite ID, facing, scale,
controllers, claimable, and freeform interaction.

Older 3D flags (`world3d` / `entity3d`) are still read as a fallback until the
GM saves the 2D authoring forms.

## Development

```bash
npm test
npm run dev
```

Gateway tests cover room isolation, request/response correlation, cached
snapshot replay, access-key rejection, audience-scoped events, spectator
denial, and asset upload. The Foundry module must additionally be exercised in
Foundry v14 because it depends on the live Foundry runtime.
