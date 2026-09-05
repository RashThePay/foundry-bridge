# Foundry Bridge

Foundry Bridge turns Foundry VTT into the authoritative rules engine, world
editor, and GM control plane for an external game client.

```text
External 2D/3D clients
        ↕ WebSocket Protocol v1
Room-aware gateway
        ↕
Foundry module
  ├─ scene/world state
  ├─ actor and token state
  ├─ rules and rolls
  └─ GM authoring/control
```

Players do not need to open Foundry. The external client can be implemented in
Godot, Three.js, Phaser, or another renderer because the bridge protocol does
not expose renderer-specific paths or Foundry document operations.

## Current foundation

- Versioned JSON protocol with commands, responses, events, and structured errors
- Multiple isolated rooms on one gateway
- Optional deployment access key through `BRIDGE_SECRET`
- Foundry-authoritative command handling
- Cached world snapshot for reconnecting clients
- Revisioned incremental entity/actor/scene events
- Renderer-neutral X/Y/Z transforms and logical prefab IDs
- Token movement, public chat, freeform player intents, and resync
- Player and spectator roles
- Temporary compatibility for the original spike messages

The full contract is documented in [PROTOCOL.md](PROTOCOL.md).

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
- move a token using world coordinates
- send public chat into Foundry
- submit a freeform intent as a GM whisper
- request an authoritative resync

## 3D authoring data in Foundry

The module reads renderer-neutral metadata from Foundry flags.

Scene:

```js
await canvas.scene.setFlag('lpc-bridge', 'world3d', {
  environmentId: 'quaternius.medieval-village',
  worldUnitsPerGridSquare: 1,
  lighting: { preset: 'sunset' },
  fog: { enabled: false },
  camera: { preset: 'isometric' },
})
```

Token or Tile document:

```js
await document.setFlag('lpc-bridge', 'entity3d', {
  prefabId: 'quaternius.goblin-01',
  entityType: 'actor',
  rotation: { x: 0, y: 180, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
  heightOffset: 0,
  selectable: true,
  interaction: { freeform: true },
  controllers: [],
})
```

These console examples expose the real persisted data model. A dedicated
Foundry scene/prefab authoring UI is the next product layer; clients will not
need to change when that UI is introduced.

## Development

```bash
npm test
```

Gateway tests cover room isolation, request/response correlation, cached
snapshot replay, and access-key rejection. The Foundry module must additionally
be exercised in Foundry v12/v13 because it depends on the live Foundry runtime.

## Next product layer

The next implementation area is the actual Foundry authoring experience:

- asset registry with logical prefab IDs and previews
- scene environment configuration
- selected Token/Tile 3D inspector
- create/update/delete prefab placement from the Foundry canvas
- live preview/open-scene commands for the external client
- persistent player identity and actor-control bindings

That layer will write the flags already represented by Protocol v1 rather than
introducing a second scene format.
