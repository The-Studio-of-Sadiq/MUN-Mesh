# Field test runbook (M5)

Goal: delivery and latency numbers from a real venue, and a list of what
breaks, before a real conference depends on it. Two runs:

1. **Field test:** 2 rooms, ~50 devices (real phones plus laptop bots), 60–90 minutes.
2. **Mock conference:** the same with real people playing delegates for a full session.

The app measures itself: the Secretariat's **Field test** panel shows live
results and exports them. Your job is to set up, run the script below, and
note what you see.

## What you need

| Per room | |
|---|---|
| Wi-Fi router | No internet needed. **AP/client isolation off**, DHCP pool ≥ 100, 5 GHz on if phones support it |
| 2 Windows laptops | Chair and co-chair (EB), MUN Toolkit installed, on the room's router |
| Phones | As many real Android phones as you can get (aim for 10+ in total), standalone APK installed |
| Power strip | Laptops relay for everyone; keep them plugged in |

Also:
- **Secretariat laptop** (creates the conference, runs the field test).
- **Bot laptop** for the load generator (Node.js and this repository; one per ~40 bots).
- **Room-to-room link:** a USB Wi-Fi adapter (or an ethernet cable) on one EB laptop, so it's on both rooms' networks.
- **Nearby test:** two phones that can be taken out of router range (a corridor).
- Notes sheet (shared doc or paper): time · room · what happened.

## Before the day

- [ ] Install the Windows app on every laptop (`npm run dist -w desktop`, then
      run the installer from `apps/desktop/release`), or run it from the repo
      with `npm run desktop`.
- [ ] Install the standalone APK on every phone (link from `npm run build:android:preview`).
      It opens straight into the app; no PC needed.
- [ ] On every phone: Bluetooth on, Location on (Nearby needs it on many Android
      versions), battery saver off for MUN Toolkit.
- [ ] Charge everything.
- [ ] Bot laptop: `npm install` in the repo.

## Setup at the venue (≈20 min)

1. **Routers:** power on, check isolation is off. Write down each room's network name.
2. **Secretariat laptop** on room A's network: **Create a conference** with two
   committees. Allow the app on **private networks** when Windows asks.
3. **EB laptops:** join with the Secretariat's join code (Join panel → Copy
   join code, sent by chat or USB stick) as **Executive Board**. Approve each on
   the Secretariat laptop.
4. **Bridge:** plug the USB adapter into one room-A EB laptop and connect it to
   room B's network. In its **Network** panel, check it shows links to laptops
   in both rooms.
5. **Phones:** each scans its committee's invite QR (EB console → Join).
   Approve them, or paste a roster first so codes let people in automatically.
   Note how long admitting everyone takes.
6. **Bots** (on the bot laptop, room B):
   ```bash
   npm run bots -- --invite "<room B committee's join code>" --count 30 --every 90
   ```
   Paste the roster it prints into room B's EB console (Join → Roster) first.

## The script (≈60 min)

Note the time of each step on the notes sheet.

| Time | Do | Watch for |
|---|---|---|
| 0:00 | Secretariat: **Field test → Start a test** | All devices appear in the panel within ~2 min |
| 0:05 | Everyone chats normally; bots run | Messages appear everywhere within a second or two |
| 0:10 | Pass chits; EBs approve and reject from the queue (A / R keys) | Recipients read approved chits; rejected stay sealed |
| 0:15 | EB attaches a 5 MB PDF; a phone attaches a photo | Hubs show **Save**; phones download on tap |
| 0:20 | EB attaches a **25 MB** file in room A | Time until a phone in room B finishes downloading it |
| 0:25 | EB mutes a delegate, then locks the channel for 2 min, then unlocks | Takes effect on all phones in both rooms within seconds |
| 0:30 | **Unplug room B's router** for 5 min, then plug it back | Room B phones show "Offline"; after power-up, everything catches up within ~1 min |
| 0:40 | **Close the chair's laptop** in room A (lid or quit) for 5 min | Room A carries on through the co-chair's laptop |
| 0:45 | **Pull the bridge** (unplug the USB adapter) for 5 min | Each room carries on; after re-plugging, both catch up |
| 0:50 | **Nearby:** phone A turns relay on and walks out of router range; phone B (in the room) has relay on | A shows "1 phone linked" and keeps chatting; note the distance where it drops |
| 0:55 | EB **removes** a delegate | That phone shows "You’ve been removed" |
| 1:00 | Secretariat: **Stop test**, then **Export results** | Save the JSON file |

## Pass criteria

- **Delivery:** ≥ 99% of pings on devices that stayed on the network, and 100%
  of pings eventually on devices that dropped off and came back. Outages should
  show as latency, not as loss.
- **Latency** (p95, from the panel):
  - < 2 s within a room;
  - < 5 s across the bridge;
  - Nearby-relayed phones reported separately.
- **Files:** 25 MB across rooms in under 5 minutes.
- **Moderation:** mute, lock and remove effective everywhere within 10 s.
- **Recovery:** after any outage, caught up within 60 s.
- **No crashes or freezes.** Note any, with the device model.

## Afterwards

Send these:
1. The exported `field-test-….json`.
2. The notes sheet.
3. Phone models and Android versions.
4. Screenshots of anything odd.

The exported results are what M5 asked for. Your notes say what to fix before
the mock conference.

## Known limits going in

- **Background:** phones stop syncing and relaying while the app is in the
  background; they catch up when reopened. Ask testers to keep the app open,
  and note how often that's a problem: it decides whether an Android foreground
  service comes next.
- **iPhones** aren't in this test (they need a TestFlight build and can't relay).
- **Latency** uses each device's clock. A phone set to the wrong time shows
  wrong latency, but correct delivery.
- **Bots** all share the bot laptop's network link, so they're lighter on the
  air than the same number of phones.
