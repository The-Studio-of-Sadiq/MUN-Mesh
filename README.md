# MUN Toolkit

An offline chat and file network for Model United Nations conferences of
400–500 people. Messages hop from device to device (A → B → C), so delegates
who aren't on the same network still get them. Each committee's Executive
Board moderates from a laptop.

Status: **M2**: core protocol (verified at 503 simulated devices), file sharing, plus the
Windows app (EB console, Secretariat, delegates) and the phone app. See
[PLAN.md](PLAN.md) for the design, milestones and what's verified.

## Try it

```bash
npm install
npm test          # unit, network, TCP and small-conference tests
npm run harness   # full simulated conference: 10 committees × 48 delegates, 30 min
npm run desktop   # the Windows app (builds the UI first)
npm run e2e       # drives three Windows app instances plus scripted phones end to end
npm run android   # the phone app (needs a dev build: it uses native TCP sockets)
```

Run several Windows instances on one PC with `--profile=name`, e.g.
`npx electron apps/desktop --profile=chair`.

Harness options: `--committees 10 --delegates 48 --minutes 30 --seed 1 --json report.json`.

## What's in `packages/core`

| File | What it does |
|---|---|
| `types.ts` | Conference, roles, event kinds and their bodies |
| `event.ts` | Signing and verifying events; shape checks for hostile input |
| `crypto/` | Ed25519 signatures; sealed messages (X25519 + XChaCha20-Poly1305); native Node speed-up |
| `hlc.ts` | Hybrid logical clock: consistent ordering across devices with wrong clocks |
| `permissions.ts` | Certs, revocation, and who may publish what |
| `store.ts` | Append-only log per (scope, author); summaries for catch-up sync |
| `replica.ts` | One device's copy: check → hold until cert → authorize → store; fork detection |
| `view.ts` | What a committee shows: mutes, locks, slow mode, kicks, pins, chit queue, EB threads |
| `node.ts` | The mesh: wire protocol, flooding to neighbours, catch-up on reconnect |
| `actions.ts` | App-level calls: post, chits, approve/reject, DMs, EB channel, mute, kick… |
| `sim/` | Deterministic network simulator and the conference scenario the harness runs |

The simulator only fakes the *links* (latency, bandwidth, shared router
airtime, drop-outs). Every device in it runs the real `MeshNode`, and every
message goes through JSON as it would on a socket.

## How a message travels

1. The author's device signs the event and sends it to every neighbour that
   keeps that scope (its committee, `global`, or `eb`).
2. Each neighbour checks the signature and the author's cert, stores the event,
   and passes it on. Duplicates are dropped by id.
3. When two devices link up (and every 20 s after), they swap a short summary
   of what they hold and send each other what's missing. Devices that were
   offline, or rooms that were cut off, catch up this way.

## How the EB stays in control without a server

- The Secretariat's root key certifies EB laptops; EB laptops certify delegates.
  Every device checks every event against those certs, so a hacked app can't post
  as someone else or moderate.
- Mutes and kicks name the offender's own sequence number, so backdating a
  message doesn't get round them.
- A chit is encrypted to the EB only. Approving it hands the content key to the
  recipient; until then the recipient's device relays the bytes but can't read them.
- A device that signs two versions of one message is caught. Every device
  receives the proof and hides it from that point on.
