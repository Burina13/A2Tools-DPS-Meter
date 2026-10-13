# Party fork changelog

Changes of the Burina13 fork on top of upstream A2Tools-DPS-Meter. Upstream's
own changes are in its releases; this file tracks only what the fork adds.

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
