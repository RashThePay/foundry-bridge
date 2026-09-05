# Foundry Bridge

Foundry Bridge turns Foundry VTT into the authoritative rules engine, world
editor, and GM control plane for an external **2D LPC** game client.

```text
External 2D LPC clients
        ↕ WebSocket Protocol v1
Room-aware gateway
        ↕
Foundry module
  ├─ scene/map state
  ├─ actor and token state
  ├─ rules and rolls
  └─ GM authoring/control
```

Players do not need to open Foundry. The external client can be implemented in
Phaser, Godot 2D, PixiJS, or another 2D renderer because the bridge protocol
exposes LPC sprite IDs and map coordinates rather than Foundry document
operations.

## Current foundation

- Versioned JSON protocol with commands, responses, events, and structured errors
- Multiple isolated rooms on one gateway
- Optional deployment access key through `BRIDGE_SECRET`
- Foundry-authoritative command handling
- Cached world snapshot for reconnecting clients
- Revisioned incremental entity/actor/scene events
- 2D X/Y map coordinates and logical LPC sprite IDs
- Token movement, public chat, freeform player intents, and resync
- Player and spectator roles
- Persistent LPC sprite registry with sheet/preview file picking
- Foundry toolbar authoring tools for Scene settings and selected entities
- One-click sprite placement as a Foundry Tile proxy
- Temporary compatibility for the original spike messages

The full contract is documented in [PROTOCOL.md](PROTOCOL.md).

The Foundry module requires **Foundry VTT 14** (verified on 14.367) and does
not load on v13 worlds.

## Local setup

### 1. Install and link the module

```bash
npm install
npm run link-module
```

The link script creates a Windows junction from `module/lpc-bridge` to:

```text
%LOCALAPPDATA%\FoundryVTT\Data\modules\lpc-bridge
```

### 2. Start the gateway

```bash
npm run bridge
```

- Test client: `http://localhost:3847/`
- WebSocket: `ws://localhost:3847/ws`
- Health/status: `http://localhost:3847/health`

To protect a deployed gateway with a shared key:

```bash
BRIDGE_SECRET=replace-me npm run bridge
```

Set the same value in the Foundry module and external client. This protects the
gateway during personal/private use; persistent player identity and per-actor
authorization remain separate future work.

### 3. Enable the Foundry module

1. Open a Foundry world as GM.
2. Enable **Foundry Bridge** in Manage Modules.
3. Configure the WebSocket URL, room ID, and optional access key in Module Settings.
4. Reload the world.

Only the active GM client connects to the gateway. The toolbar plug button
reconnects and pushes a fresh authoritative snapshot.

### 4. Use the test client

Open `http://localhost:3847/`, enter the same room ID/access key, and connect.
The test client can:

- receive the current scene and token snapshot
- follow token and actor updates
- move a token using 2D map coordinates
- send public chat into Foundry
- submit a freeform intent as a GM whisper
- request an authoritative resync

## 2D LPC authoring in Foundry

Four tools are added to Foundry's Token controls:

- **LPC Sprite Registry** registers sprite sheets, previews, LPC kinds,
  frame size, 4/8 directions, animation names, tags, and default scale.
- **LPC Scene Settings** configures the map sprite, tileset ID, world scale,
  lighting tint, fog overlay, and camera mode (`follow`, `locked`, or
  `top-down`).
- **Selected Entity LPC Inspector** assigns a sprite, facing, and scale to the
  currently controlled Token or Tile, along with visibility, selection,
  freeform interaction, and external-controller bindings.
- **Reconnect and push 2D world** sends a complete authoritative snapshot.

The Sprite Registry can also place a sprite directly in the active Scene. It
creates a normal Foundry Tile as the editable proxy while the external client
renders the registered LPC sheet.

### Stored data

The module reads 2D LPC metadata from Foundry flags.

Scene:

```js
await canvas.scene.setFlag('lpc-bridge', 'world2d', {
  mapId: 'lpc.medieval-village',
  tilesetId: 'lpc.terrain-exterior',
  unitsPerGridSquare: 1,
  lighting: { preset: 'sunset' },
  fog: { enabled: false },
  camera: { preset: 'follow' },
})
```

Token or Tile document:

```js
await document.setFlag('lpc-bridge', 'entity2d', {
  spriteId: 'lpc.goblin-01',
  entityType: 'actor',
  facing: 'down',
  scale: { x: 1, y: 1 },
  selectable: true,
  interaction: { freeform: true },
  controllers: [],
})
```

These examples expose the same persisted data model written by the authoring
UI. Clients receive the sprite registry once per world snapshot and entities
refer to sheets through stable logical IDs.

Older 3D flags (`world3d` / `entity3d`) are still read as a fallback until the
GM saves the 2D authoring forms.

## Development

```bash
npm test
```

Gateway tests cover room isolation, request/response correlation, cached
snapshot replay, and access-key rejection. The Foundry module must additionally
be exercised in Foundry v14 because it depends on the live Foundry runtime. The
module is verified against Foundry 14.367.

## Next product layer

The next implementation area is a real external 2D LPC client:

- load the Scene map/tileset and registered LPC sheets
- render and live-update Token/Tile entities with directional animations
- follow/locked camera and object selection
- live preview/open-scene commands from Foundry
- movement and facing feedback from the 2D client when useful
- persistent player identity and actor-control bindings

That layer will write the flags already represented by Protocol v1 rather than
introducing a second scene format.
