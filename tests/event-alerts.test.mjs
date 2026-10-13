import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Local-time texts are asserted in a fixed zone, whatever machine runs this.
process.env.TZ = "Europe/Bratislava";

const source = readFileSync(new URL("../public/src/js/eventAlerts.js", import.meta.url), "utf8");

function core({ at } = {}) {
  const store = new Map();
  const module = { exports: {} };
  vm.runInNewContext(source, { module, Date, Intl });
  let t = at ?? 1_760_000_000;
  const api = module.exports.createEventAlertsCore({
    getSetting: (k) => (store.has(k) ? store.get(k) : null),
    setSetting: (k, v) => store.set(k, String(v)),
    now: () => t,
  });
  return { api, store, setNow: (x) => { t = x; }, nowVal: () => t };
}

const PAYLOAD = (now) => ({
  verzia: 1,
  generovane: now,
  horizontDni: 8,
  serverTz: "Asia/Tokyo",
  varovanie: "komunitny rozpis",
  eventy: [
    {
      id: "rift", nazovSk: "Spacetime Rift", nazovEn: "Spacetime Rift",
      ikona: "🌀", kategoria: "denne", skupina: "", miesto: "portál 10 min",
      trvanieMin: 60, dolezite: false, vyskyty: [now + 1800, now + 12600],
    },
    {
      id: "abyss-siege", nazovSk: "Abyss Siege Boss", nazovEn: "Abyss Siege Boss",
      ikona: "🏰", kategoria: "abyss", skupina: "", miesto: "Abyss",
      trvanieMin: 0, dolezite: true, vyskyty: [now + 600],
    },
  ],
  bossy: [
    {
      id: "boss-gartua", nazovSk: "Immortal Gartua", nazovEn: "Immortal Gartua",
      ikona: "💎", kategoria: "field-bossy", miesto: "Immortal Isle",
      trvanieMin: 0, dolezite: false, respawnH: 12, vyskyty: [now + 3600],
    },
  ],
});

test("parseSchedule normalizes events and merges field bosses", () => {
  const { api, nowVal } = core();
  const s = api.parseSchedule(PAYLOAD(nowVal()));
  assert.equal(s.events.length, 3);
  const gartua = s.events.find((e) => e.id === "boss-gartua");
  assert.equal(gartua.category, "field-bossy");
  assert.deepEqual(Array.from(gartua.occurrences), [nowVal() + 3600]);
  assert.equal(api.parseSchedule({ verzia: 2, eventy: [] }), null);
  assert.equal(api.parseSchedule(null), null);
});

test("defaults: only important events are on, lead 10, sound chime", () => {
  const { api, nowVal } = core();
  const s = api.parseSchedule(PAYLOAD(nowVal()));
  const rift = s.events.find((e) => e.id === "rift");
  const siege = s.events.find((e) => e.id === "abyss-siege");
  assert.equal(api.eventConfig(rift).on, false);
  assert.equal(api.eventConfig(siege).on, true);
  assert.equal(api.eventConfig(siege).lead, 10);
  assert.equal(api.eventConfig(siege).sound, "chime");
  assert.equal(api.eventConfig(siege).open, false);
});

test("due: lead-time alert fires once inside its window, never for a disabled event", () => {
  const { api, setNow, nowVal } = core();
  const base = nowVal();
  const s = api.parseSchedule(PAYLOAD(base));
  // siege opens at base+600 with lead 10 min: its alert window opened in the past
  let due = api.due(s, base + 30);
  assert.equal(due.length, 1);
  assert.equal(due[0].event.id, "abyss-siege");
  assert.equal(due[0].kind, "pre");
  api.markFired(due[0].key);
  assert.equal(api.due(s, base + 40).length, 0, "already fired");
  // rift is off by default: nothing even inside its window
  setNow(base + 1800 - 300);
  assert.equal(api.due(s, base + 1800 - 300).length, 0);
});

test("due: lead 0 = alert at open; 'also when it opens' adds a second alert", () => {
  const { api, nowVal } = core();
  const base = nowVal();
  const s = api.parseSchedule(PAYLOAD(base));
  const rift = s.events.find((e) => e.id === "rift");
  api.setEventConfig(rift, { on: true, lead: 0 });
  assert.equal(api.due(s, base + 1790).length, 0, "nothing before open with lead 0");
  let due = api.due(s, base + 1805);
  assert.deepEqual(Array.from(due, (d) => [d.event.id, d.kind]), [["rift", "open"]]);
  // lead 5 + open: two alerts for one occurrence
  api.setEventConfig(rift, { lead: 5, open: true });
  due = api.due(s, base + 1800 - 290);
  assert.deepEqual(Array.from(due, (d) => d.kind), ["pre"]);
  api.markFired(due[0].key);
  due = api.due(s, base + 1805);
  assert.deepEqual(Array.from(due, (d) => d.kind), ["open"]);
});

test("snooze re-arms exactly once and respects the relevance cutoff", () => {
  const { api, nowVal } = core();
  const base = nowVal();
  const s = api.parseSchedule(PAYLOAD(base));
  const due = api.due(s, base + 30);
  api.snooze(due[0]); // marks fired + snoozeAt = now + 300
  assert.equal(api.due(s, base + 40).length, 0, "silenced after snooze");
  const again = api.due(s, base + 340);
  assert.equal(again.length, 1);
  assert.equal(again[0].snoozed, true);
  api.markFired(again[0].key);
  assert.equal(api.due(s, base + 350).length, 0, "snooze is one-shot");
});

test("category bulk on/off writes every event of the group", () => {
  const { api, nowVal } = core();
  const s = api.parseSchedule(PAYLOAD(nowVal()));
  api.setCategory(s, "denne", true);
  assert.equal(api.eventConfig(s.events.find((e) => e.id === "rift")).on, true);
  api.setCategory(s, "abyss", false);
  assert.equal(api.eventConfig(s.events.find((e) => e.id === "abyss-siege")).on, false);
});

test("master switch gates everything (the rollback flag)", () => {
  const { api, store, nowVal } = core();
  const s = api.parseSchedule(PAYLOAD(nowVal()));
  store.set("dpsMeter.eventAlertsEnabled", "false");
  assert.equal(api.due(s, nowVal() + 30).length, 0);
});

test("volume clamps to 0..100 and defaults to 70", () => {
  const { api, store } = core();
  assert.equal(api.volume(), 70);
  store.set("dpsMeter.eventAlertsVolume", "250");
  assert.equal(api.volume(), 100);
  store.set("dpsMeter.eventAlertsVolume", "-5");
  assert.equal(api.volume(), 0);
  store.set("dpsMeter.eventAlertsVolume", "35");
  assert.equal(api.volume(), 35);
});

test("nextText renders the user's LOCAL time, SK and EN, incl. the DST switch", () => {
  // Wed 2026-10-21 07:00 UTC = 09:00 CEST; Wed 2026-10-28 07:00 UTC = 08:00 CET
  const before = Date.UTC(2026, 9, 21, 7, 0) / 1000;
  const after = Date.UTC(2026, 9, 28, 7, 0) / 1000;
  const { api, setNow } = core();
  const ev = {
    id: "tyzdenny-reset", nameSk: "Týždenný reset", nameEn: "Weekly reset",
    icon: "🗓️", category: "reset", place: "", durationMin: 0, important: false,
    occurrences: [before, after],
  };
  setNow(before - 32 * 60);
  assert.equal(api.nextText(ev, "sk", before - 32 * 60), "Najbližšie o 9:00 · o 32 min");
  assert.equal(api.nextText(ev, "en", before - 32 * 60), "Next at 9:00 AM · in 32 min");
  // after the October switch the same UTC instant is an hour earlier locally
  setNow(after - 32 * 60);
  assert.equal(api.nextText(ev, "sk", after - 32 * 60), "Najbližšie o 8:00 · o 32 min");
  // a running event with a duration says so
  const rift = { ...ev, id: "rift", durationMin: 60, occurrences: [before] };
  assert.match(api.nextText(rift, "en", before + 600), /^Open now/);
});

test("quiet-hold relevance: deliver after combat only while the event still matters", () => {
  const { api, nowVal } = core();
  const base = nowVal();
  const alert = { ts: base + 60 };
  assert.equal(api.stillRelevant(alert, base + 100), true);
  assert.equal(api.stillRelevant(alert, base + 60 + 121), false);
});
