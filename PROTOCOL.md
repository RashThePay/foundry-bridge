# Foundry Bridge Protocol v2

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
| `audience` | events | Optional `{ connectionIds?, roles? }`. The gateway delivers the event only to matching player/spectator sockets. Omitted audience broadcasts to every client in the room. |

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
    "claimedTokenId": "optional-reconnect-token-id",
    "capabilities": ["world.snapshot", "token.move", "chat.send"]
  }
}
```

Roles are `foundry`, `player`, and `spectator`. A room accepts one active
Foundry connection and any number of player/spectator connections. Connecting a
new Foundry session replaces the old connection in that room only.

`name` is the player-facing display name. `claimedTokenId` is a reconnect hint:
Foundry may restore control of that token if it is still bound to this name.

The gateway answers with `connection.ready`, containing connection ID, room
status, and the negotiated protocol version. If a cached authoritative snapshot
exists, it is sent immediately after the ready event.

In the default open-access mode, Foundry connects with a room name and players
select any available character without an invite or PIN. The optional secure
mode supports owner-created campaigns, Foundry credentials, invites, hashed
character PINs, and revocable sessions.

## Commands

Player/spectator commands are routed to the Foundry connection in the same
room. Foundry returns exactly one response for each command.

| Type | Payload |
|---|---|
| `world.snapshot.request` | `{}` |
| `movement.request` | `{ destination: { x, y } }` |
| `door.toggle` | `{ wallId }` |
| `chat.send` | `{ text, channel?: "all"\|"party"\|"npc", targetEntityId? }` |
| `intent.submit` | `{ targetEntityId?, verb, text }` |
| `action.preflight` | `{ itemId, activityId?, targetIds? }` |
| `action.execute` | `{ itemId, activityId?, targetIds?, options?: { rollMode, bonus, channel } }` |
| `combat.rollInitiative` | `{ tokenId }` |
| `connection.ping` | `{ sentAt? }` |

Spectators may send only `world.getSnapshot` and `connection.ping`.

Coordinates are 2D map units. X increases to the right and Y increases
downward, matching Foundry's canvas. By default one Foundry grid square equals
one world unit. LPC clients should treat these as map coordinates, not pixels.

`token.moved` is emitted only after Foundry's own Token pathfinding and movement
pipeline accepts and applies the move. Its payload includes the authoritative
`path`, `destination`, `facing`, and `movementSpeed` in world units per second.
The client never predicts movement. Foundry rejects destinations blocked by its
walls, doors, surfaces, regions, token locks, or movement hooks, as well as
tokens the connection does not control.

`chat.send` channels:

- `all` (default) — public table talk, spoken as the claimed character
- `party` — delivered by the bridge to every connected, claimed player; Foundry
  keeps a GM-only audit card because remote players are not Foundry users
- `npc` — a private per-player thread with one NPC (`targetEntityId` required).
  Two players speaking to the same NPC remain separate, and the NPC does not
  speak until the GM replies to the selected conversation

`intent.submit` is a declared custom interaction. `verb` and `text` are
required. Include `targetEntityId` when the player tapped an entity.

`action.preflight` checks turn ownership, preparation/equipment, remaining
uses or slots, target requirements, templates, and range without consuming
anything. `action.execute` repeats those checks and then executes the
Foundry/dnd5e item or activity. For attacks, `rollMode` is `normal`,
`advantage`, or `disadvantage`, and `bonus` is a situational modifier from -20
through 20. `channel` is `party` (all claimed players) or `private` (the acting
player and GM only). The client chooses the inputs but never rolls dice. Results arrive as
`roll.result` and `chat.message` events.

Action artwork is not linked to Foundry's private filesystem. When an actor
sheet is synchronized, each referenced icon is hashed, copied into the
campaign's bridge asset store, and rewritten to a session-protected immutable
asset URL. This is a per-campaign cache, not a redistributed global icon pack.

Example success:

```json
{
  "v": 1,
  "kind": "response",
  "type": "token.move.result",
  "replyTo": "move-42",
  "payload": { "ok": true, "tokenId": "abc", "destination": { "x": 4, "y": 7 }, "facing": "right" }
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
scene switch. The gateway caches only the latest unscoped snapshot per room so
a reconnecting client can render immediately while requesting a fresh copy.

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
        "backgroundUrl": "/rooms/campaign-alpha/assets/ab12…",
        "lighting": {},
        "fog": {},
        "camera": { "preset": "follow" },
        "unitsPerGridSquare": 1
      },
      "walls": [
        {
          "wallId": "wall-id",
          "a": { "x": 0, "y": 0 },
          "b": { "x": 4, "y": 0 },
          "move": true,
          "door": "door",
          "doorState": "closed"
        }
      ]
    },
    "combat": {
      "started": false,
      "round": 0,
      "turn": 0,
      "combatantId": null,
      "combatants": []
    },
    "playableCharacters": [],
    "assets": [],
    "entities": []
  }
}
```

The `walls` collection contains only ordinary doors and already-open secret
doors needed for client interaction. Collision walls remain private to Foundry,
which authorizes every movement request.

`backgroundUrl`, `textureUrl`, and registry `spriteUrl` values are gateway
asset URLs when the module has uploaded the file. Clients must load images from
the gateway, not from Foundry's origin.

An entity has a stable Foundry document identity and 2D LPC metadata:

```json
{
  "id": "Token.token-id",
  "documentType": "Token",
  "documentId": "token-id",
  "entityType": "actor",
  "name": "Goblin",
  "spriteId": "lpc.goblin-01",
  "textureUrl": "/rooms/campaign-alpha/assets/cd34…",
  "transform": {
    "position": { "x": 4, "y": 7 },
    "facing": "down",
    "scale": { "x": 1, "y": 1 }
  },
  "visible": true,
  "selectable": true,
  "interaction": { "freeform": true },
  "disposition": -1,
  "actor": { "id": "actor-id", "hp": 7, "maxHp": 7, "type": "npc" }
}
```

`facing` is one of `down`, `left`, `right`, or `up`. Universal LPC sheets use
row order **up, left, down, right** (not down/left/right/up). Clients map the
authored facing onto that row. `directions: 8` assets may additionally
interpret diagonal movement locally; the authored facing remains cardinal.

`playableCharacters` lists scene tokens a player may claim:

```json
{
  "tokenId": "token-id",
  "actorId": "actor-id",
  "name": "Mira",
  "textureUrl": "/rooms/campaign-alpha/assets/…",
  "claimedByConnectionId": null,
  "claimedByName": null
}
```

Foundry stores 2D authoring metadata in document flags under `lpc-bridge`:

- Scene: `flags.lpc-bridge.world2d`
- Token/Tile: `flags.lpc-bridge.entity2d`

Raw engine paths, shader uniforms, and renderer-specific material configuration
do not belong in Foundry scene data. Foundry stores logical `spriteId` values;
the client resolves them through the snapshot's asset registry. Sprite sheet
URLs live in that registry rather than being repeated on each Scene entity.

LPC character sheets from the
[Universal LPC Character Generator](https://liberatedpixelcup.github.io/Universal-LPC-Spritesheet-Character-Generator/)
are 64×64 frames, 13 columns wide. Direction rows are **up, left, down, right**.
Classic sheets are 21 rows (`spellcast` through `hurt`); expanded sheets are 54
rows and also include `idle`, `run`, `combat_idle`, `slash` variants, and more.
The registry records `frameSize`, `layout` (`auto` / `lpc` / `custom`), and
`animations` so the client can slice sheets without a second asset catalog.

`token.animated` is `{ tokenId, animation, targetIds }` after a successful
`action.use`, so every client can play slash, thrust, spellcast, or shoot.

## Incremental events

After a snapshot, clients follow ordered revisions:

- `entity.created`
- `entity.updated`
- `entity.deleted`
- `scene.updated`
- `scene.activated`
- `wall.updated`
- `wall.deleted`
- `actor.updated`
- `actor.sheet`
- `combat.updated`
- `chat.message`
- `roll.result`
- `action.result`
- `action.undone`
- `token.animated`
- `intent.raised`
- `intent.resolved`

Every world-changing event includes `payload.revision`. If a client detects a
revision gap, it must send `world.snapshot.request` and replace local state.

### Combat

```json
{
  "started": true,
  "round": 2,
  "turn": 1,
  "combatantId": "combatant-id",
  "combatants": [
    { "id": "combatant-id", "tokenId": "token-id", "name": "Mira", "initiative": 17, "defeated": false, "isPC": true }
  ]
}
```

### Actor sheet

Sent to the claiming connection when a character is claimed and whenever that
actor changes. Contains HP, AC, speeds, conditions, and usable Foundry actions
(weapons, spells, features, items) with `itemId` / `activityId` for `action.use`.

`actor.updated` is the public live-state delta for every token backed by the
changed actor. It contains `tokenIds`, `hp`, `maxHp`, `tempHp`, `conditions`,
and `dead`; raw Foundry actor update data is never sent to players. Actor,
embedded-item, and active-effect hooks produce these deltas automatically, so
the GM does not need to push a new world snapshot after damage or conditions.

### Fast resolution and undo

For attack, damage, healing, and save activities, Foundry rolls all configured
parts and applies them through dnd5e's actor damage API. Attack totals are
checked against target AC; each save target rolls the activity's configured
ability and DC, with `damage.onSave` determining full, half, or zero damage.
`action.result` includes normalized `applied[]`, `saves[]`, and a local
`resolutionId`. Undo remains a GM-local operation in the Live Table: it restores
recorded HP/temp HP and asks dnd5e to refund the activity's consumption deltas.
Undo refuses to overwrite a target whose HP changed again after that action.

### Chat

`chat.message` payload:

```json
{
  "messageId": "…",
  "channel": "all",
  "speaker": "Mira",
  "speakerEntityId": "Token.token-id",
  "speakerActorId": "actor-id",
  "targetEntityId": null,
  "text": "Hello",
  "createdAt": 0
}
```

### Rolls

`roll.result` payload includes `speaker`, `flavor`, `totals[]`, `isCrit`, and
`targetIds` so the client can show floating numbers without parsing HTML.

### Intents

`intent.raised` is delivered to the originating player (the GM queue is local
to Foundry). `intent.resolved` is `{ intentId, ok, narrative }` to that player.

## HTTP assets

The gateway stores binary files per room so phones never talk to Foundry HTTP.

- `PUT /rooms/:roomId/assets/:hash` — Foundry/GM upload. Body is the file.
  Header `x-bridge-key` must match `BRIDGE_SECRET` when configured.
  `:hash` is lowercase hex SHA-256 (16–64 characters).
- `GET /rooms/:roomId/assets/:hash` — public within the deployment; CORS `*`.

## Authority and permissions

- The gateway authenticates/routes connections and assets but contains no RPG rules.
- Foundry validates every command and owns all authoritative mutations.
- A client may only move, act, and speak as a token it has claimed.
- Spectators may request snapshots and receive unscoped events but may not send gameplay commands.

## Compatibility

Protocol v1 and the spike message format are intentionally rejected. Older 3D
flags are no longer read; supported documents use the versioned 2D flag model.
