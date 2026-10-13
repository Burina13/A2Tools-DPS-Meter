# Party fork changelog

Changes of the Burina13 fork on top of upstream A2Tools-DPS-Meter. Upstream's
own changes are in its releases; this file tracks only what the fork adds.

## party-v2.64.1 — 2026-10-13

**Why this release exists:** on a player's machine, upstream's v2.0.63 MSI
replaced the party fork. party-v2.0.62-1 still checked upstream's update
manifest (a2tools.app), and because the fork shipped under upstream's own
product name and identifier, the upstream installer treated our install as
its older self and upgraded over it. Both holes are closed here.

- **Own identity — installs BESIDE the genuine A2Tools meter, never over
  it, and upstream can never again upgrade over us**: product name
  "Tvoj Tatko DPS Meter", identifier `sk.tvojtatko.dps-meter`, its own
  pinned WiX upgrade code, its own icon (dark badge, three bars, TT).
  Installing this release also sweeps the fork's own older builds that
  still wore upstream's identity (2.1.0, 2.2.0) — but deliberately NOT
  upstream's 2.0.x line, which players may keep side by side.
- **Versioning**: `2.<upstream patch>.<party build>` — 2.64.1 = upstream
  v2.0.64 + party build 1. Sorts above both upstream (2.0.x) and the old
  party line, so every install sees updates. (A `2.0.64-tt.1` style
  pre-release tag was rejected: Windows MSI versions must be numeric and
  the in-app comparison treats a pre-release as older at equal value.)
- **Settings → "Tvoj Tatko", first section**: the party upload toggle, the
  server URL (prefilled with the party server), the personal key from
  `/dpsmeter kluc`, the last successful upload, a connection test button
  (probes the server without storing anything: distinguishes unreachable /
  bad key / OK) and a link to the party logs web. Upstream's A2 Tools
  Account section stays and all upstream sending (account upload, Send Logs
  to Dev) remains OFF unless turned on.
- **Merged upstream v2.0.64**: themes and bar textures with a live preview,
  the capture-device lock, deaths on the Details chart, meter update rate
  setting, plugin decoder events — plus the Slovak translation for all the
  new settings.
- Tests: `tests/party-updater.test.mjs` pins the update manifest to this
  fork's repository and fails the build if upstream's manifest or identity
  ever creeps back in.

## party-v2.2.0 — 2026-10-13

- **Real in-game artwork in Event Alerts**: events backed by a boss (Watcher
  Kaira, the Executors, all four field bosses) show the boss portrait from
  the party log web (`ikonaUrl` in `/api/eventy`) instead of an emoji, both
  on the settings cards and in the overlay banner.
  - Events with no artwork (rifts, sieges, resets…) draw a grey two-letter
    badge — never an emoji/dot placeholder; missing ones are logged to the
    console (`[eventAlerts] no icon artwork for: …`).
  - Class icons next to players in the meter and skill icons in the details
    panel were already real game art upstream and are unchanged.

## party-v2.1.0 — 2026-10-13

- **Event Alerts** (Settings → Event Alerts): sound, Windows toast and an
  overlay banner before AION 2 world events — Spacetime Rift, Watcher Kaira,
  the Executors, Abyss Siege, Artifact Siege, Dimensional Invasion, Beritra
  Air Raid, Shugo Festival, Abyss Rift Zone, field bosses (live respawn
  timers typed into Discord) and the daily/weekly reset.
  - The schedule comes from the party server (`/api/eventy`), the SAME source
    the Discord timer uses, and is cached locally — the list keeps working
    offline with the last known copy.
  - Groups (Daily / Abyss / Field bosses / Reset) with bulk on/off; per event
    a lead time (0/1/2/5/10/15/30 min), one of four synthesized sounds with a
    ▶ preview, and "also when it opens".
  - Global volume, quiet mode while the meter is measuring an encounter
    (alerts deliver right after the fight if still relevant), one-shot snooze.
  - Everything is OFF by default except the Executors and the Abyss Siege
    Boss. Master switch `dpsMeter.eventAlertsEnabled` is the rollback flag.
  - "Next at … · in …" countdowns are in the user's local time; the server
    publishes UTC.
- **Slovak UI** (`Settings → Language → Slovenčina`): full translation of the
  app UI; game data (skill names, NPCs) stays English.
- **Update checks now point at this fork's releases** (`latest-party.json` on
  the main branch) instead of a2tools.app — upstream's installer would
  silently drop the party features.
- One-time "What's new" card in the app after an update.

## party-v2.0.62-1 — 2026-10-13

- Party upload `ext`: per-event damage, damage taken, deaths and boss HP for
  the party server's timeline and death recap.

## party-v2.0.57-1 — 2026-10-11

- Party upload: finished boss fights go to the party's own server, which
  merges everyone's captures into one canonical result posted to Discord.
- GitHub Actions release workflow (MSI + SHA256 sums on `party-v*` tags).
