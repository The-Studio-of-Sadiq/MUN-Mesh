# MUN Toolkit — Plan (draft for review)

An offline chat and file network for a Model United Nations conference of
400–500 people. Messages hop across devices (A → B → C) so delegates who are
not on the same network still receive them. The Executive Board (EB) runs and
moderates each committee from a laptop.

v1 scope: **chat + files only**. Procedure tools (roll call, speakers' list,
motions, voting) come after the network is proven.

## Decisions so far

| Topic | Decision |
|---|---|
| Offline | Hybrid: no internet; room routers/laptop hubs where available, phone-to-phone relay as fallback |
| Devices | Android phones, iPhones, Windows laptops (EB + some delegates) |
| Channels | Committee channel, delegate↔delegate chits, delegate↔EB private, Secretariat/global |
| EB control | Approve chits, read all DMs in their committee, mute/lock/kick, broadcasts + pins |
| Files | Any type, 25 MB default cap, EB adjustable per committee |
| Identity | Roster CSV import by Secretariat + QR walk-in with EB approval |
| Repo | New repo here, same stack as the adjudicator |

## What went wrong with the first prototype (MUN-Toolkit)

Lessons, so this attempt avoids them:

1. **The network was simulated, not built.** `src/connection_layer.js` decides links
   from pixel distance on a canvas and fakes handshakes with `setTimeout`. Nothing in
   the web part ever opened a socket.
2. **The Android part never sent a message.** `DtnRouter.broadcastMunMessage` is a
   `TODO`; there is no Activity, UI or resources, so it cannot build into an app.
3. **The PRD said "build on Briar," but no Briar code is present.** Briar is also
   Android-only, so it cannot serve iPhones or EB laptops.
4. **It used the wrong routing for chat.** Spray-and-wait caps each message at 4–8 copies.
   That suits sparse field networks; in a committee every member must get every
   message, and capped copies mean some never do.
5. **BLE + Wi-Fi Direct as the only transports.** A Wi-Fi Direct group holds ~8
   devices, iPhones can't join it, and BLE is too slow for files.
6. **"The Chair is not a server," but nothing could enforce the Chair's authority.**
   With no authority anywhere, chit approval, mutes and kicks can't be enforced.
   This plan makes EB authority cryptographic (signed certificates and control events).
   That keeps the "no single server" goal and still lets the EB control the chat.

Lesson for process: core logic is real, shared code with tests from day one; a
simulator may *drive* that code, never replace it.

## Architecture

```
packages/core   Pure TypeScript, unit tested. Events, signatures, sync, routing,
                permissions, chit moderation, file manifests. Runs everywhere.
apps/desktop    Electron (Windows). EB console + hub: TCP server/client, full
                replica of the committee, file cache, bridges networks.
apps/app        Expo / React Native (Android + iOS). Delegate app. Android also
                relays over Nearby Connections (phase 4).
```

Same split as the adjudicator, with one change: here **every node relays**,
not only the host.

### Physical network (hybrid)

```
 Room A (DISEC)                         Room B (UNSC)
 ┌───────────────────┐   bridge link    ┌───────────────────┐
 │ Router / AP  ◄────┼── EB laptop ─────┼──►  Router / AP   │
 │  phones, laptops  │  (Wi-Fi + 2nd    │  phones, laptops  │
 │  EB laptop (hub)  │   adapter/LAN)   │  EB laptop (hub)  │
 └───────────────────┘                  └───────────────────┘
        ▲ Android phones outside coverage relay via Nearby (BT/Wi-Fi Direct)
```

- **Each room needs a real access point.** A Windows Mobile Hotspot caps at **8
  clients** and an Android hotspot at ~10–15, so a 40-delegate room needs a cheap
  router (no internet needed). A laptop hotspot only works for small rooms.
- **How rooms connect:** any device on two networks at once becomes a bridge. Usually
  that's an EB laptop on the room Wi-Fi plus a second adapter (USB Wi-Fi dongle or
  ethernet) on the neighbouring room's network, or on a cabled backbone between routers.
- **Venue Wi-Fi with client isolation** blocks device-to-device traffic, as the
  adjudicator found; use our own routers.

### Several routers in one room

Routers only carry traffic. The session (messages, chits, mutes, roster) lives
in signed events copied onto every device, so nothing depends on which router
a device is on.

- **Preferred: one network.** Cable the routers together. One router hands out
  addresses (DHCP); the others run in "access point" mode on the same subnet,
  ideally with the same Wi-Fi name. A mesh router kit (Deco-style, or OpenWrt
  802.11s) does the same without cables. Every device then sees every other one
  directly, and the session runs exactly as with one router.
- **Fallback: separate networks.** Routers that aren't linked form separate
  islands. Each island needs at least one bridge device on two networks: an EB
  laptop with a second adapter, a delegate laptop, or an Android phone over
  Nearby. Islands keep chatting locally and sync through the bridge; if a bridge
  drops, they catch up when it returns.
- **Finding the hub:** devices find hubs by UDP broadcast on the local network.
  The QR code also carries the hub addresses, for routers that block broadcast.
- **Redundancy:** each committee can run two hubs (chair and co-chair laptops),
  both full copies. Phones connect to both plus a few peers, so losing one laptop
  or one router doesn't stop the committee.
- **Router settings checklist:** AP/client isolation off, no internet needed, DHCP
  pool large enough (≥ 100), 5 GHz for files where devices support it.

### Messages: signed, append-only logs

Every device has an Ed25519 key. Every message is an **event**:

```
{ id: hash, author: deviceKey, seq: n, channel, kind, body | encBody,
  hlc: hybrid-logical-clock, sig }
```

- Each author's events form an append-only log (`seq` 1, 2, 3 …).
- `id` = hash of the content, so every node can drop duplicates.
- A hybrid logical clock (HLC) gives consistent ordering without synced clocks.

### Routing and sync (how A → B → C works)

1. **Live flooding.** A new event goes out on every link. A node that hasn't
   seen its `id` stores it and forwards it to its other links; a node that has drops it.
2. **Catch-up on reconnect.** When two nodes link up, each sends a per-channel
   summary `{author → highest seq}`. Each then sends the other what it's missing.
   A phone that walks out and back in, or a room whose bridge drops, catches up
   automatically. 500 authors make a summary of about 4 KB.
3. **What each node keeps.**
   - Hubs (EB laptops) keep everything.
   - Phones keep their committee, the global channel and their own DMs, plus a
     bounded relay buffer for other traffic passing through (size and time limits).

No spray limits: every subscriber of a channel eventually gets every event.

### Files

- Files are split into 256 KB chunks, each addressed by its hash.
- The message carries only a manifest (name, type, size, chunk hashes).
- Chunks are pulled from whichever neighbour has them, rarest first. Transfers
  resume after a disconnect.
- Hubs cache every file in their committee, so files spread hub to hub instead
  of phone to phone.
- The size cap and blocked file types are EB settings. Every node enforces them
  (oversized manifests are dropped).

### Identity, trust and EB authority

```
Secretariat root key  ──signs──►  EB certificates (committee, role)
EB key                ──signs──►  delegate certificates (country, committee)
```

- **Join:** scan the committee QR (it carries the conference public key and hub
  address) or enter a roster code. The EB approves the device and its certificate
  spreads. Devices without a valid certificate are ignored by everyone.
- **Kick:** the EB signs a revocation event; every node then drops that device's
  events.
- **Mute / lock channel / slow mode:** signed EB control events. Hubs refuse to
  relay muted posts, and honest clients refuse to post or show them.
- **Chits:** a delegate's chit is encrypted **to the EB only**. When the EB
  approves it, the EB wraps the content key for the recipient and signs a
  release event. Until then the recipient's device can't read it, even when it
  relays the bytes.
- **Delegate ↔ EB private messages** are encrypted to that EB. The EB can read
  all DMs in their committee by design, and the app tells delegates so.
- **Secretariat / global:** announcements only Secretariat keys can post, and an
  EB-to-EB channel across committees.

### Roles

| Role | Can |
|---|---|
| Secretariat | Create conference, import roster, issue EB certs, global announcements, see all committees' health |
| EB (chair / co-chair / rapporteur) | Approve devices, approve/reject chits, read committee DMs, mute/lock/kick, pin, set file rules, broadcast to committee |
| Delegate | Post in committee channel, send chits (via EB), message EB, send files |
| Observer / press | Read committee channel |

## EB console (laptop-first)

Built for a 13–15" screen, keyboard first, in Electron.

```
┌──────────────┬──────────────────────────────────┬────────────────────┐
│ Channels     │  #DISEC                           │ Chit queue (12)    │
│  #DISEC  ●   │  ─────────────────────────────── │ France → USA       │
│  EB-to-EB    │  [messages, files, pins]          │  "Support cl. 4?"  │
│  Global      │                                   │  [A]pprove [R]eject│
│ Delegates 48 │                                   ├────────────────────┤
│  🟢 France   │                                   │ Files / pins       │
│  🔴 Brazil   │  [composer · attach · broadcast]  │ Network: 3 hubs,   │
│  ...         │                                   │ 46 online, 2 hops  │
└──────────────┴──────────────────────────────────┴────────────────────┘
```

- Keyboard: `A`/`R` approve/reject the top chit, `J`/`K` move through the queue, `/`
  search, `Ctrl+K` jump to a delegate.
- Roster panel: presence, last seen, hop count, mute/kick from the context menu.
- Controls: lock channel, slow mode, file cap and types, pin message/file.
- Network panel: links, bridges, sync backlog per peer. Helps diagnose a dead room.

The delegate app is phone-first: committee channel, chits, EB line, files.

## Milestones

| # | Deliverable | Done when |
|---|---|---|
| M0 | `packages/core`: events, keys/certs, HLC, flooding + catch-up sync, permissions, chit flow | Unit tests pass. A headless harness runs **500 real core nodes** over in-memory links in a multi-room topology with bridges and drop-outs, and every subscriber gets every event. |
| M1 | Electron hub + EB console, TCP NDJSON transport, delegate app on LAN, QR/roster join | Two laptops + several phones in two "rooms" exchange messages through a bridge |
| M2 | Chunked files with resume and caps | 25 MB file crosses 2 hops; resumes after pulling the Wi-Fi |
| M3 | Full moderation: chit approve/release, mute/lock/kick, read DMs, pins, global channel | All EB actions take effect across hops, including on reconnect |
| M4 | Android Nearby Connections relay | A phone out of router range reaches the room through another phone |
| M5 | Field test: ~50 real devices, then a mock conference | Delivery and latency numbers from a real venue |

## M0 status: done (2026-10-23)

`npm run harness` (10 committees × 48 delegates, 503 devices, 1,406 links,
30 simulated minutes, seed 1) passes every check:

- Every device holds every event of every scope it keeps. Every device in a
  committee shows the same channel, chit statuses, mutes, locks and pins.
- 776 approved chits readable by their recipients; 160 rejected ones stay sealed.
- Muted, locked, kicked and forking devices are handled everywhere. The late
  joiner receives the full history.
- Latency while the network is up: p50 17 ms, p99 151 ms, max 0.5 s. Overall,
  including devices that were offline or cut off: 92.8% under 1 s.
- Everything settled 45 s after activity stopped. Runs in ~2.5 min of wall time.

Known limits, for M1:
- **Sync summaries are heavy:** 695 MB of the 1.7 GB total, mostly hub↔hub
  summaries of every scope every 20 s. Send only scopes that changed, or a hash
  first. Duplicate floods (1 GB of `ev`) can drop with "have/want" for large batches.
- ~~Lock relies on timestamps~~ → fixed in M3 (sequence numbers). Slow mode
  still uses timestamps: the app enforces it, but a modified app could space its
  timestamps out.
- ~~Kicked devices stay linked~~ → fixed in M3 (cut off and refused).
- ~~Conflicting EB chit decisions~~ → fixed in M3 (approval wins).
- **The simulator** counts a phone→router→hub hop as one airtime use.

## M1 status: built, verified on Windows (2026-10-23)

- **Core:**
  - newline-delimited JSON over TCP (`device.ts`);
  - a connection manager that listens, redials with back-off, learns hub
    addresses from neighbours, and drops duplicate links;
  - signed join requests that spread to whoever can approve them;
  - invite codes for QR, and UDP hub beacons.
- **One Expo app** (`apps/app`) for Android, iOS and Windows (via Electron):
  - Secretariat creates the conference;
  - join by QR or code, then wait for approval;
  - **EB console** (three panes):
    - channels and members (mute, remove, message);
    - committee chat with lock, slow mode, pins and announcements;
    - work queue: chits (A/R keys), join requests with invite QR and roster
      auto-approval, private threads, network diagnostics;
  - **delegate app:** committee, chits, chair thread, conference news.
- **Electron shell** (`apps/desktop`): socket bridge, append-only event log, UDP discovery.
- **Verified:** `npm run e2e` drives the real Windows app over the DevTools
  protocol: Secretariat + two EB laptops + a laptop delegate, plus four scripted
  phones over TCP. Twelve steps pass: create, approve staff, roster auto-approval,
  manual approval, chat both ways, a chit approved with the A key, a mute, the EB
  channel, a global announcement, a laptop delegate getting the history, and a
  chair laptop restart that catches up through the Secretariat's hub.
  `tcp.test.ts` covers two rooms joined only by a bridge laptop, over real sockets.

Not verified yet:
- **Phones.** Nothing has run on an Android or iOS device. The Android JS bundle
  compiles, but TCP sockets, file storage and the camera on device need a dev
  build (EAS) and a real-phone test.
- **Two physical networks.** Bridging was tested on one machine. A real
  bridge laptop with two adapters is part of the M5 field test.
- **Not built yet:**
  - Phones don't listen for UDP beacons, so they find hubs from the invite and
    from hubs' hellos.
  - English only.
  - No file sending (M2).

## M2 status: built, verified on Windows and in the simulator (2026-10-23)

- **Files** (`packages/core/src/files.ts`):
  - every file is encrypted with its own key and split into 256 KB chunks named by
    their hash, so any device can check a chunk and relay it without reading it;
  - public posts carry the key; private threads and the EB channel seal it.
- **Transfer:**
  - a device asks neighbours for chunks it lacks, hubs first, with a few requests
    in flight per link and timeouts;
  - a hub or bridge (or a phone, when another phone asks it) that knows the file
    but lacks a chunk starts fetching it, answers "ask again soon", and pushes the
    chunk to the asker when it arrives;
  - nobody waits on anybody, so requests can't go round in circles. An earlier
    version that waited on each other deadlocked between three hubs;
    `files.test.ts` keeps that triangle as a regression test;
  - chunks are stored one by one, so a broken download resumes.
- **Who downloads what:** hubs fetch every file the rules allow. Phones fetch files
  up to 2 MB by themselves; bigger ones on tap.
- **Rules per committee** (EB console, "Files: up to … MB"): a size limit (25 MB by
  default, up to 100) and blocked types. Every device refuses to fetch what the
  rules forbid, and the app refuses to send it.
- **UI:** Attach in every composer (committee, announcements, private threads, EB
  channel); file cards with progress, Download and Save (a download on Windows,
  the share sheet on phones).
- **Verified:**
  - Simulator: a 25 MB file crosses two hops (phone → hub → bridge → hub → phone),
    with the last link pulled mid-transfer, and arrives byte for byte; both hubs keep
    a copy.
  - Also simulated:
    - a file passing along a chain of three phones;
    - a private file relayed by a delegate who can't open it;
    - size and type limits;
    - forged chunks rejected;
    - the three-hub triangle.
  - `npm run e2e`: on the real Windows app, a phone's 3 MB file is fetched by the
    hub and shown in the console, and isn't pushed to other phones until asked. A
    small file from the EB reaches phones by itself, and file rules set in the
    console reach the phones. 20 steps in all.

Not verified: picking and saving files on a real phone (document picker, share sheet).

## M3 status: built and verified (2026-10-23)

Moderation that holds against a misbehaving device, across hops and reconnects:

- **Removed devices are cut off.**
  - When a revocation arrives, every device sends the removed device a `bye` and
    drops the link (sockets now close gracefully, so the revocation and `bye`
    arrive first), and turns it away if it reconnects.
  - The removed device shows "You've been removed".
  - The Secretariat can remove EB laptops from its roster; EBs remove delegates
    and observers.
- **Devices waiting for approval** get only certs, revocations and conference
  announcements, and no files. The moment a device receives its own cert it asks
  its neighbours for everything else.
- **Locks use per-delegate sequence numbers,** like mutes, so a backdated
  post can't slip through. Delegates who join during a lock are covered from
  their first post.
- **Chits:** any approval wins (once the key is out, "rejected" would be a promise
  the system can't keep). The queue offers "Approve instead" on rejected chits;
  approvals are final.
- **Verified:**
  - 46 tests, including:
    - a kicked device over real TCP, refused on every redial;
    - a pending device that gets only announcements until approved, then the history;
    - a backdated post during a lock;
    - approval overturning a rejection.
  - Harness at 503 devices: all 29 checks pass; steady delivery p50 17 ms, p99 142 ms.
  - `npm run e2e`, now 23 steps on the real Windows app: a lock from the
    console, removing a delegate (cut off, hears nothing more), and the Secretariat
    removing an EB laptop.

Still open:
- **Slow mode** can be dodged by a modified app (above).
- **Spam:** a member flooding valid posts is only limited by mute/remove, not by
  relays.

## M4 status: built; verified in tests, not yet on phones (2026-10-23)

- **`core/nearby.ts`:** links phones of the same conference over Android Nearby
  Connections and hands each link to `Device`, so relaying, sync, files and
  moderation work over it unchanged.
  - Text goes in numbered pieces under Nearby's 32 KB limit, reordered on arrival.
  - Only the phone with the smaller key dials; up to 3 Nearby links per phone.
  - Phones of another conference are ignored by name, before connecting.
- **Native module** `apps/app/modules/nearby` (Kotlin, `play-services-nearby`
  19.3, `P2P_CLUSTER`). It accepts connections automatically, since every
  message is signed and checked anyway.
- **App:** a "Relay for nearby phones" switch on the waiting screen (so a phone
  out of range can ask to join through others) and the delegate screen.
  - Relaying phones keep every committee's messages, so they can pass anything on.
  - Bluetooth and nearby-devices permissions are asked for when it's switched on.
- **Fix found by the tests:** a neighbour held back as unapproved now gets what
  it lacks as soon as its cert arrives, rather than up to 20 s later.
- **Verified:**
  - 49 tests. Through a simulated radio (out-of-order delivery, a phone of
    another conference nearby), a phone with no Wi-Fi posts to the room, receives
    the chair's messages, and downloads a 600 KB file relayed by the phone next to it.
  - The development build with the Kotlin module compiles on EAS. Windows e2e
    still passes (23 steps).
- **Not verified:** Nearby on real phones. TESTING.md has a two-phone checklist.
- **Limits:**
  - Relaying stops when Android puts the app in the background (an Android
    foreground service would fix that).
  - iPhones can't take part over Nearby; they use Wi-Fi only.

## Open questions

Resolved: routers are available, one or more per room. iOS ships in v1:
delegates install from the App Store or TestFlight beforehand, with internet,
and only the committee runs offline. iPhones are full participants but weak
relays (iOS pauses the app in the background).

1. **Apple developer account:** is there one ($99/yr) to publish through
   TestFlight/App Store? The build itself runs on EAS cloud from Windows.
2. **Routers:** cabled together per room, or separate networks?
3. **Size:** how many committees, and the largest committee size?
4. **Roster CSV:** what columns do you already have (name, country, committee,
   email/phone)?
5. **Languages:** English only, or Bangla too (the adjudicator's i18n setup carries over)?
6. **Name/branding** for the app.
