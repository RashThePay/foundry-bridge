# Foundry Bridge Protocol v1

This document defines the 2D LPC contract between an external game client, the
WebSocket gateway, and the Foundry module. Foundry is the authoritative rules
and world editor. External clients render an orthogonal 2D LPC view of that
world; they do not mutate Foundry documents directly.

## Envelope

Every frame is JSON and uses this envelope:

```json
{
  "v": 1,
  "kind": "command",
  "type": "token.move",
  "id": "01J...",
  "roomId": "default",
  "payload": {}
}
```

| Field | Required | Meaning |
|---|---:|---|
| `v` | yes | Protocol version. Currently `1`. |
| `kind` | yes | `hello`, `command`, `response`, `event`, or `system`. |
| `type` | yes | Namespaced message type. |
| `id` | commands | Client-generated request ID used to correlate responses. |
| `replyTo` | responses | ID of the command being answered. |
| `roomId` | after hello | Isolates one Foundry world/session from another. |
| `payload` | yes | Message-specific data. |

Unknown fields must be ignored. Unknown message types must receive a structured
`UNSUPPORTED_COMMAND` response rather than silently disappearing.

## Connection handshake

The first client frame must be `connection.hello`:

```json
{
  "v": 1,
  "kind": "hello",
  "type": "connection.hello",
  "payload": {
    "role": "foundry",
    "roomId": "campaign-alpha",
    "name": "GM",
    "accessKey": "optional-shared-secret",
    "capabilities": ["world.snapshot", "token.move", "chat.send"]
  }
}
```

Roles are `foundry`, `player`, and `spectator`. A room accepts one active
Foundry connection and any number of player/spectator connections. Connecting a
new Foundry session replaces the old connection in that room only.

The gateway answers with `connection.ready`, containing connection ID, room
status, and the negotiated protocol version. If a cached authoritative snapshot
exists, it is sent immediately after the ready event.

`BRIDGE_SECRET` may be configured on the gateway. When configured, all hello
frames must include the same `accessKey`. This is a deployment-level guard, not
a substitute for future player identity and actor authorization.

## Commands

Player/spectator commands are routed to the Foundry connection in the same
room. Foundry returns exactly one response for each command.

Initial command set:

| Type | Payload |
|---|---|
| `world.getSnapshot` | `{}` |
| `token.move` | `{ tokenId, destination: { x, y } }` |
| `chat.send` | `{ text }` |
| `intent.submit` | `{ targetEntityId?, verb?, text }` |
| `connection.ping` | `{ sentAt? }` |

Coordinates are 2D map units. X increases to the right and Y increases
downward, matching Foundry's canvas. By default one Foundry grid square equals
one world unit. LPC clients should treat these as map coordinates, not pixels.

Example success:

```json
{
  "v": 1,
  "kind": "response",
  "type": "token.move.result",
  "replyTo": "move-42",
  "payload": { "ok": true, "tokenId": "abc" }
}
```

Example failure:

```json
{
  "v": 1,
  "kind": "response",
  "type": "token.move.result",
  "replyTo": "move-42",
  "payload": {
    "ok": false,
    "error": { "code": "TOKEN_NOT_FOUND", "message": "Token abc is not in the active scene." }
  }
}
```

## Authoritative snapshot

Foundry emits `world.snapshot` after connecting, when requested, and after a
scene switch. The gateway caches only the latest snapshot per room so a
reconnecting client can render immediately while requesting a fresh copy.

```json
{
  "v": 1,
  "kind": "event",
  "type": "world.snapshot",
  "roomId": "campaign-alpha",
  "payload": {
    "revision": 17,
    "world": { "id": "world-id", "title": "Campaign", "system": "dnd5e" },
    "scene": {
      "id": "scene-id",
      "name": "Temple Yard",
      "dimensions": { "width": 40, "height": 30, "gridSize": 100 },
      "map": {
        "mapId": "lpc.fantasy-temple",
        "tilesetId": "lpc.terrain-interior",
        "lighting": {},
        "fog": {},
        "camera": { "preset": "follow" },
        "unitsPerGridSquare": 1
      }
    },
    "assets": [
      {
        "id": "lpc.goblin-01",
        "name": "Goblin 01",
        "kind": "creature",
        "spriteUrl": "assets/sprites/goblin.png",
        "previewUrl": "assets/previews/goblin.png",
        "defaultEntityType": "actor",
        "frameSize": { "width": 64, "height": 64 },
        "directions": 4,
        "animations": ["idle", "walk", "slash", "hurt"],
        "defaultScale": { "x": 1, "y": 1 },
        "tags": ["goblin", "humanoid"]
      }
    ],
    "entities": []
  }
}
```

An entity has a stable Foundry document identity and 2D LPC metadata:

```json
{
  "id": "Token.token-id",
  "documentType": "Token",
  "documentId": "token-id",
  "entityType": "actor",
  "name": "Goblin",
  "spriteId": "lpc.goblin-01",
  "transform": {
    "position": { "x": 4, "y": 7 },
    "facing": "down",
    "scale": { "x": 1, "y": 1 }
  },
  "visible": true,
  "selectable": true,
  "interaction": {},
  "actor": { "id": "actor-id", "hp": 7, "maxHp": 7 }
}
```

`facing` is one of `down`, `left`, `right`, or `up`. Clients use it to select
the matching LPC directional row. `directions: 8` assets may additionally
interpret diagonal movement locally; the authored facing remains cardinal.

Foundry stores 2D authoring metadata in document flags under `lpc-bridge`:

- Scene: `flags.lpc-bridge.world2d`
- Token/Tile: `flags.lpc-bridge.entity2d`

Raw engine paths, shader uniforms, and renderer-specific material configuration
do not belong in Foundry scene data. Foundry stores logical `spriteId` values;
the client resolves them through the snapshot's asset registry. Sprite sheet
URLs live in that registry rather than being repeated on each Scene entity.

LPC character sheets are typically 64×64 frames. Tilesets are typically 32×32.
The registry records `frameSize` and `animations` so the client can slice sheets
without a second asset catalog.

## Incremental events

After a snapshot, clients follow ordered revisions:

- `entity.created`
- `entity.updated`
- `entity.deleted`
- `scene.updated`
- `scene.activated`
- `actor.updated`
- `chat.message`

Every world-changing event includes `payload.revision`. If a client detects a
revision gap, it must send `world.getSnapshot` and replace local state.

## Authority and permissions

- The gateway authenticates/routs connections but contains no RPG rules.
- Foundry validates every command and owns all authoritative mutations.
- A client may never select an arbitrary actor by name as an authorization
  mechanism. Actor ownership checks will be added when persistent player
  identities are introduced.
- Spectators may request snapshots and receive events but may not send gameplay
  commands.

## Compatibility

The spike protocol (`hello`, `state`, `move`, `chat`, `intent`,
`request-state`) remains accepted temporarily. New code must emit v1 envelopes.
Compatibility can be removed after the first real client migrates.

Older 3D authoring flags (`world3d`, `entity3d`, `prefabId`, `modelUrl`) are
read as a one-way fallback and rewritten as 2D flags when the GM saves from the
authoring UI.
