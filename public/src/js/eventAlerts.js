// eventAlerts.js — fork: Event Alerts for the party's AION 2 world events.
//
// The schedule comes from the party's own server (GET /api/eventy on the
// party-upload host): ids, SK/EN names, categories, durations and the next
// occurrences as UTC timestamps. The server only republishes what the party's
// Discord timer computed, so the meter, the API and the Discord channel can
// never disagree. The client caches the last payload in settings and keeps
// working offline with it.
//
// createEventAlertsCore() is pure (no DOM, no Tauri) and unit-tested in
// tests/event-alerts.test.mjs; the IIFE at the bottom wires it to the app:
// the alert engine runs in the MAIN window (it is alive while the meter is),
// the Settings window renders the per-event cards.

"use strict";

function createEventAlertsCore({
  getSetting,
  setSetting,
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  const KEYS = {
    master: "dpsMeter.eventAlertsEnabled",
    volume: "dpsMeter.eventAlertsVolume",
    toast: "dpsMeter.eventAlertsToast",
    banner: "dpsMeter.eventAlertsBanner",
    quiet: "dpsMeter.eventAlertsQuiet",
    events: "dpsMeter.eventAlertsEvents",
    fired: "dpsMeter.eventAlertsFired",
    cache: "dpsMeter.eventAlertsCache",
  };

  // Lead-time choices (minutes). 0 means "at the moment it opens".
  const LEAD_CHOICES = [0, 1, 2, 5, 10, 15, 30];
  const SOUNDS = ["chime", "bell", "ping", "horn"];
  const FIRE_WINDOW_S = 90; // an alert is deliverable this long after its time
  const LATE_OPEN_S = 120; // quiet-held alerts still fire this long into the event
  const SNOOZE_S = 300;
  const CATEGORIES = ["denne", "abyss", "field-bossy", "reset"];

  const readJson = (key, fallback) => {
    try {
      const raw = getSetting(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch {
      return fallback;
    }
  };

  const flag = (key, dflt) => {
    const v = getSetting(key);
    return v === null || v === undefined || v === "" ? dflt : v === "true";
  };

  const core = {
    KEYS,
    LEAD_CHOICES,
    SOUNDS,
    CATEGORIES,
    SNOOZE_S,

    masterEnabled: () => flag(KEYS.master, true),
    toastEnabled: () => flag(KEYS.toast, true),
    bannerEnabled: () => flag(KEYS.banner, true),
    quietEnabled: () => flag(KEYS.quiet, true),

    volume() {
      const v = Number(getSetting(KEYS.volume));
      return Number.isFinite(v) && getSetting(KEYS.volume) !== null && getSetting(KEYS.volume) !== ""
        ? Math.min(100, Math.max(0, Math.round(v)))
        : 70;
    },

    // --- schedule -----------------------------------------------------------

    // Normalize the server payload: events and field bosses become one list.
    // Field bosses have at most one occurrence (the respawn the party typed in).
    parseSchedule(payload) {
      if (!payload || payload.verzia !== 1 || !Array.isArray(payload.eventy)) return null;
      const events = [];
      for (const raw of [...payload.eventy, ...(payload.bossy || [])]) {
        if (!raw || typeof raw.id !== "string" || !raw.id) continue;
        events.push({
          id: raw.id,
          nameSk: String(raw.nazovSk || raw.nazovEn || raw.id),
          nameEn: String(raw.nazovEn || raw.nazovSk || raw.id),
          icon: String(raw.ikona || "•"),
          // Real in-game artwork (boss portraits via the party log web); when
          // the server has no image for an event, the UI draws a grey text
          // badge instead of an emoji placeholder and logs it as missing.
          iconUrl: String(raw.ikonaUrl || ""),
          category: CATEGORIES.includes(raw.kategoria) ? raw.kategoria : "denne",
          place: String(raw.miesto || ""),
          durationMin: Math.max(0, Number(raw.trvanieMin) || 0),
          important: !!raw.dolezite,
          occurrences: (Array.isArray(raw.vyskyty) ? raw.vyskyty : [])
            .map(Number)
            .filter((t) => Number.isFinite(t) && t > 0)
            .sort((a, b) => a - b),
        });
      }
      return {
        generatedAt: Number(payload.generovane) || 0,
        warning: String(payload.varovanie || ""),
        events,
      };
    },

    loadCachedSchedule() {
      const cached = readJson(KEYS.cache, null);
      return cached ? core.parseSchedule(cached.payload) : null;
    },

    saveScheduleCache(payload, fetchedAt = now()) {
      setSetting(KEYS.cache, JSON.stringify({ fetchedAt, payload }));
    },

    cacheFetchedAt() {
      const cached = readJson(KEYS.cache, null);
      return cached ? Number(cached.fetchedAt) || 0 : 0;
    },

    // --- per-event config ---------------------------------------------------

    eventConfig(ev) {
      const all = readJson(KEYS.events, {});
      const c = all[ev.id] || {};
      return {
        // Off by default, except the few the party cares most about
        // (`dolezite` in the server config: the Executors and Abyss Siege).
        on: typeof c.on === "boolean" ? c.on : ev.important,
        lead: LEAD_CHOICES.includes(Number(c.lead)) ? Number(c.lead) : 10,
        sound: SOUNDS.includes(c.sound) ? c.sound : "chime",
        open: typeof c.open === "boolean" ? c.open : false,
      };
    },

    setEventConfig(ev, patch) {
      const all = readJson(KEYS.events, {});
      all[ev.id] = { ...core.eventConfig(ev), ...patch };
      setSetting(KEYS.events, JSON.stringify(all));
    },

    setCategory(schedule, category, on) {
      const all = readJson(KEYS.events, {});
      for (const ev of schedule.events) {
        if (ev.category !== category) continue;
        all[ev.id] = { ...core.eventConfig(ev), on };
      }
      setSetting(KEYS.events, JSON.stringify(all));
    },

    // --- fired/snooze bookkeeping (persisted so restarts do not re-alert) ----

    _loadFired() {
      const f = readJson(KEYS.fired, {});
      return f && typeof f === "object" ? f : {};
    },

    markFired(key, meta = {}) {
      const f = core._loadFired();
      f[key] = { at: now(), ...meta };
      // prune anything older than 2 days — occurrence keys never repeat
      for (const [k, v] of Object.entries(f)) {
        if (!v || now() - (Number(v.at) || 0) > 2 * 86400) delete f[k];
      }
      setSetting(KEYS.fired, JSON.stringify(f));
    },

    snooze(alert) {
      // One-shot: the alert re-arms once, SNOOZE_S from now, but never past
      // the point where the event itself is long open.
      core.markFired(alert.key, { snoozeAt: now() + SNOOZE_S, eventStart: alert.ts });
    },

    // --- what is due right now ----------------------------------------------

    // All alerts deliverable at `t`: regular pre-alerts, at-open alerts and
    // snoozes that came due. Returns [{key, kind, event, ts, leadMin}].
    due(schedule, t = now()) {
      if (!schedule || !core.masterEnabled()) return [];
      const fired = core._loadFired();
      const out = [];
      const push = (key, kind, event, ts, leadMin) => {
        if (!(key in fired)) out.push({ key, kind, event, ts, leadMin });
      };
      for (const ev of schedule.events) {
        const cfg = core.eventConfig(ev);
        if (!cfg.on) continue;
        for (const ts of ev.occurrences) {
          if (cfg.lead > 0) {
            const at = ts - cfg.lead * 60;
            if (t >= at && t < Math.min(ts, at + FIRE_WINDOW_S)) {
              push(`${ev.id}|${ts}|pre`, "pre", ev, ts, cfg.lead);
            }
          }
          if (cfg.lead === 0 || cfg.open) {
            if (t >= ts && t < ts + FIRE_WINDOW_S) {
              push(`${ev.id}|${ts}|open`, "open", ev, ts, 0);
            }
          }
        }
      }
      // snoozes that came due (their original key is already in `fired`)
      for (const [key, v] of Object.entries(fired)) {
        const at = Number(v?.snoozeAt);
        if (!at || t < at || t >= at + FIRE_WINDOW_S) continue;
        if (`${key}|snooze` in fired) continue; // a snooze re-arms only once
        const [id, tsRaw, kind] = key.split("|");
        const ev = schedule.events.find((e) => e.id === id);
        const ts = Number(tsRaw);
        if (!ev || !ts || t >= ts + LATE_OPEN_S) continue;
        out.push({ key: `${key}|snooze`, kind, event: ev, ts, leadMin: 0, snoozed: true });
      }
      return out.sort((a, b) => a.ts - b.ts);
    },

    // Quiet-held alerts worth delivering once combat ends: the event has not
    // started yet, or opened only a moment ago.
    stillRelevant: (alert, t = now()) => t < alert.ts + LATE_OPEN_S,

    // --- texts ----------------------------------------------------------------

    eventName: (ev, lang) => (lang === "sk" ? ev.nameSk : ev.nameEn),

    nextOccurrence(ev, t = now()) {
      const running = ev.occurrences.find(
        (ts) => ts <= t && ev.durationMin > 0 && t < ts + ev.durationMin * 60
      );
      if (running !== undefined) return { ts: running, running: true };
      const ts = ev.occurrences.find((x) => x >= t);
      return ts === undefined ? null : { ts, running: false };
    },

    // "Next at 2:00 PM · in 32 min" / "Najbližšie o 14:00 · o 32 min";
    // all in the USER'S local time zone (toLocaleTimeString does that).
    nextText(ev, lang, t = now()) {
      const next = core.nextOccurrence(ev, t);
      const sk = lang === "sk";
      if (!next) return sk ? "Žiadny známy termín" : "No known time";
      const locale = sk ? "sk-SK" : "en-US";
      // More than a day away: say the weekday too, "14:30" alone misleads.
      const opts = next.ts - t >= 86400 && !next.running
        ? { weekday: "short", hour: "numeric", minute: "2-digit" }
        : { hour: "numeric", minute: "2-digit" };
      const when = new Date(next.ts * 1000).toLocaleString(locale, opts);
      if (next.running) return sk ? `Prebieha (od ${when})` : `Open now (since ${when})`;
      const mins = Math.max(1, Math.round((next.ts - t) / 60));
      const inTxt = mins >= 120
        ? (sk ? `o ${Math.round(mins / 60)} h` : `in ${Math.round(mins / 60)} h`)
        : (sk ? `o ${mins} min` : `in ${mins} min`);
      return sk ? `Najbližšie o ${when} · ${inTxt}` : `Next at ${when} · ${inTxt}`;
    },

    alertTexts(alert, lang) {
      const name = core.eventName(alert.event, lang);
      const when = new Date(alert.ts * 1000).toLocaleTimeString(
        lang === "sk" ? "sk-SK" : "en-US",
        { hour: "numeric", minute: "2-digit" }
      );
      const mins = Math.max(1, Math.round((alert.ts - now()) / 60));
      const body =
        alert.kind === "open" || mins <= 0
          ? lang === "sk" ? `Práve sa otvára (${when})` : `Opening now (${when})`
          : lang === "sk" ? `Začína o ${mins} min (${when})` : `Starts in ${mins} min (${when})`;
      return { title: `${alert.event.icon} ${name}`, body };
    },
  };

  return core;
}

// Expose for the vm-based unit tests (tests/event-alerts.test.mjs).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { createEventAlertsCore };
}

// --------------------------------------------------------------------------
// App wiring. Everything below needs a window; guarded so the vm tests can
// evaluate the file without a DOM.
(() => {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const DEFAULT_API_URL = "https://aion2-dps.tvojtatko.sk/api/eventy";
  const FETCH_EVERY_S = 30 * 60;
  const TICK_MS = 15000;

  const getSetting = (key) => {
    try {
      const v = window.javaBridge?.getSetting?.(key);
      if (v !== undefined && v !== null) return v;
    } catch { /* ignore */ }
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const setSetting = (key, value) => {
    try {
      window.javaBridge?.setSetting?.(key, String(value));
    } catch { /* ignore */ }
    try {
      localStorage.setItem(key, String(value));
    } catch { /* ignore */ }
  };

  const core = createEventAlertsCore({ getSetting, setSetting });
  const lang = () => ((getSetting("dpsMeter.language") || "en") === "sk" ? "sk" : "en");

  // Section strings live here, not in ui/<lang>.json: the cards re-render from
  // JS and the fork only promises SK/EN for them (ui/sk.json covers the rest).
  const STR = {
    en: {
      volume: "Alert volume",
      toast: "Windows notification (toast)",
      banner: "Banner over the meter",
      quiet: "Quiet during a boss fight (deliver after)",
      master: "Event alerts",
      masterTip: "Schedule comes from the party server and is cached for offline use.",
      alertMe: "Alert me",
      atOpen: "when it opens",
      minBefore: (n) => `${n} min before`,
      sound: "Sound",
      alsoOpen: "Also when it opens",
      preview: "Play the selected sound",
      all: "All",
      none: "None",
      snooze: "Snooze 5 min",
      updated: (d) => `Schedule from ${d}`,
      noSchedule: "No schedule yet — it loads from the party server when the meter can reach it.",
      groups: { denne: "Daily", abyss: "Abyss", "field-bossy": "Field bosses", reset: "Reset" },
      sounds: { chime: "Chime", bell: "Bell", ping: "Ping", horn: "Horn" },
    },
    sk: {
      volume: "Hlasitosť upozornení",
      toast: "Windows notifikácia (toast)",
      banner: "Banner nad metrom",
      quiet: "Ticho počas boja s bossom (doručí po boji)",
      master: "Upozornenia na eventy",
      masterTip: "Rozpis ide zo servera partie a drží sa aj offline (posledný známy).",
      alertMe: "Upozorni ma",
      atOpen: "pri otvorení",
      minBefore: (n) => `${n} min vopred`,
      sound: "Zvuk",
      alsoOpen: "Aj keď sa otvorí",
      preview: "Prehrať zvolený zvuk",
      all: "Všetko",
      none: "Nič",
      snooze: "Odlož o 5 min",
      updated: (d) => `Rozpis z ${d}`,
      noSchedule: "Rozpis zatiaľ nie je — načíta sa zo servera partie, keď bude dostupný.",
      groups: { denne: "Denné", abyss: "Abyss", "field-bossy": "Field bossy", reset: "Reset" },
      sounds: { chime: "Zvonkohra", bell: "Zvon", ping: "Pípnutie", horn: "Roh" },
    },
  };
  const S = () => STR[lang()];

  let schedule = core.loadCachedSchedule();

  const invoke = (cmd, args) => window.__TAURI__?.core?.invoke?.(cmd, args);

  const fetchSchedule = async () => {
    try {
      const raw = await invoke("fetch_url", { url: DEFAULT_API_URL });
      const parsed = core.parseSchedule(JSON.parse(raw));
      if (!parsed) return false;
      core.saveScheduleCache(JSON.parse(raw));
      schedule = parsed;
      document.dispatchEvent(new CustomEvent("event-alerts-schedule"));
      return true;
    } catch (e) {
      console.warn("[EventAlerts] schedule fetch failed, keeping cache:", e);
      return false;
    }
  };

  const maybeFetch = () => {
    if (!core.masterEnabled()) return;
    const age = Math.floor(Date.now() / 1000) - core.cacheFetchedAt();
    if (!schedule || age >= FETCH_EVERY_S) fetchSchedule();
  };

  // ---- sounds ---------------------------------------------------------------

  const playSound = (name) => {
    try {
      const audio = new Audio(`/sounds/${core.SOUNDS.includes(name) ? name : "chime"}.wav`);
      audio.volume = core.volume() / 100;
      audio.play().catch(() => {});
    } catch { /* ignore */ }
  };

  // ---- main window: engine + banner ----------------------------------------

  const viewMode = window.__A2_VIEW__ || new URLSearchParams(window.location.search).get("view");

  const startEngine = () => {
    // "measuring an encounter" = battleTime kept moving within the last 7 s
    let lastBattle = { value: -1, movedAt: 0 };
    const inCombat = () => {
      try {
        const raw = window.dpsData?.getDpsData?.();
        if (!raw) return false;
        const bt = Number(JSON.parse(raw).battleTime) || 0;
        const t = Date.now() / 1000;
        if (bt > 0 && bt !== lastBattle.value) lastBattle = { value: bt, movedAt: t };
        return bt > 0 && t - lastBattle.movedAt < 7;
      } catch {
        return false;
      }
    };

    let banner = null;
    let bannerTimer = null;
    const hideBanner = () => {
      if (bannerTimer) clearTimeout(bannerTimer);
      bannerTimer = null;
      banner?.classList.remove("isVisible");
    };
    const showBanner = (alert) => {
      if (!banner) {
        banner = document.createElement("div");
        banner.className = "eventAlertBanner";
        banner.innerHTML =
          '<span class="eventAlertBannerIcon"></span>' +
          '<span class="eventAlertBannerText"></span>' +
          '<button type="button" class="eventAlertBannerSnooze"></button>' +
          '<button type="button" class="eventAlertBannerClose">×</button>';
        banner.querySelector(".eventAlertBannerClose").addEventListener("click", hideBanner);
        document.body.appendChild(banner);
      }
      const { title, body } = core.alertTexts(alert, lang());
      const iconHolder = banner.querySelector(".eventAlertBannerIcon");
      iconHolder.replaceChildren(iconNode(alert.event, "eventAlertBannerImg"));
      banner.querySelector(".eventAlertBannerText").textContent =
        `${core.eventName(alert.event, lang())} — ${body}`;
      const snoozeBtn = banner.querySelector(".eventAlertBannerSnooze");
      snoozeBtn.textContent = S().snooze;
      snoozeBtn.style.display = alert.snoozed ? "none" : "";
      snoozeBtn.onclick = () => {
        core.snooze(alert);
        hideBanner();
      };
      banner.classList.add("isVisible");
      if (bannerTimer) clearTimeout(bannerTimer);
      bannerTimer = setTimeout(hideBanner, 12000);
      void title;
    };

    const deliver = (alert) => {
      core.markFired(alert.key);
      const cfg = core.eventConfig(alert.event);
      playSound(cfg.sound);
      const { title, body } = core.alertTexts(alert, lang());
      if (core.toastEnabled()) invoke("show_event_toast", { title, body })?.catch?.(() => {});
      if (core.bannerEnabled()) showBanner(alert);
    };

    let held = [];
    const tick = () => {
      if (!core.masterEnabled()) return;
      maybeFetch();
      if (!schedule) return;
      const fresh = core.due(schedule);
      for (const alert of fresh) {
        if (core.quietEnabled() && inCombat()) {
          // mark now so a restart mid-fight cannot double-alert, hold delivery
          if (!held.some((h) => h.key === alert.key)) {
            core.markFired(alert.key);
            held.push(alert);
          }
        } else {
          deliver(alert);
        }
      }
      if (held.length && !(core.quietEnabled() && inCombat())) {
        const flush = held.filter((a) => core.stillRelevant(a));
        held = [];
        for (const alert of flush) {
          const cfg = core.eventConfig(alert.event);
          playSound(cfg.sound);
          const { title, body } = core.alertTexts(alert, lang());
          if (core.toastEnabled()) invoke("show_event_toast", { title, body })?.catch?.(() => {});
          if (core.bannerEnabled()) showBanner(alert);
        }
      }
    };

    setTimeout(maybeFetch, 3000);
    setInterval(tick, TICK_MS);
  };

  // ---- settings window: the section ----------------------------------------

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // Real event artwork (server-provided boss portraits); events without one
  // get a grey two-letter badge, never an emoji placeholder, and are logged
  // once so the missing list can be read from the console.
  const missingIconIds = new Set();
  const iconFallback = (ev, cls) => {
    if (!missingIconIds.has(ev.id)) {
      missingIconIds.add(ev.id);
      console.info("[eventAlerts] no icon artwork for:", ev.id);
    }
    const initials = (ev.nameEn || ev.id).split(/\s+/)
      .map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    const badge = el("span", cls + " isFallback", initials);
    badge.title = ev.nameEn;
    return badge;
  };
  const iconNode = (ev, cls) => {
    if (!ev.iconUrl) return iconFallback(ev, cls);
    const img = el("img", cls + " isImg");
    img.src = ev.iconUrl;
    img.alt = ev.nameEn;
    img.loading = "lazy";
    img.addEventListener("error", () => img.replaceWith(iconFallback(ev, cls)));
    return img;
  };

  const renderSection = () => {
    const root = document.querySelector(".eventAlertsGroups");
    if (!root) return;
    const s = S();
    const L = lang();
    root.replaceChildren();

    const meta = document.querySelector(".eventAlertsMeta");
    if (meta) {
      if (schedule) {
        const d = new Date((core.cacheFetchedAt() || schedule.generatedAt) * 1000);
        meta.textContent = s.updated(d.toLocaleString(L === "sk" ? "sk-SK" : "en-US"));
        if (schedule.warning) meta.textContent += ` · ${schedule.warning}`;
      } else {
        meta.textContent = s.noSchedule;
      }
    }
    if (!schedule) return;

    for (const cat of core.CATEGORIES) {
      const events = schedule.events.filter((e) => e.category === cat);
      if (!events.length) continue;

      const head = el("div", "eventAlertsGroupHead");
      head.appendChild(el("h3", "eventAlertsGroupTitle", s.groups[cat]));
      const bulk = el("div", "eventAlertsGroupBulk");
      for (const [label, on] of [[s.all, true], [s.none, false]]) {
        const b = el("button", "eventAlertsBulkBtn", label);
        b.type = "button";
        b.addEventListener("click", () => {
          core.setCategory(schedule, cat, on);
          renderSection();
        });
        bulk.appendChild(b);
      }
      head.appendChild(bulk);
      root.appendChild(head);

      for (const ev of events) {
        const cfg = core.eventConfig(ev);
        const card = el("div", "eventAlertsCard" + (cfg.on ? " isOn" : ""));

        const row = el("div", "eventAlertsCardRow");
        row.appendChild(iconNode(ev, "eventAlertsCardIcon"));
        const names = el("div", "eventAlertsCardNames");
        names.appendChild(el("div", "eventAlertsCardName", core.eventName(ev, L)));
        const next = el("div", "eventAlertsCardNext", core.nextText(ev, L));
        next.dataset.eventId = ev.id;
        names.appendChild(next);
        if (ev.place) names.appendChild(el("div", "eventAlertsCardPlace", ev.place));
        row.appendChild(names);

        const toggle = el("label", "settingsToggle eventAlertsCardToggle");
        const toggleCtl = el("span", "settingsToggleControl");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = cfg.on;
        cb.addEventListener("change", () => {
          core.setEventConfig(ev, { on: cb.checked });
          card.classList.toggle("isOn", cb.checked);
        });
        toggleCtl.appendChild(cb);
        const track = el("span", "settingsToggleTrack");
        track.setAttribute("aria-hidden", "true");
        toggleCtl.appendChild(track);
        toggle.appendChild(toggleCtl);
        row.appendChild(toggle);
        card.appendChild(row);

        const opts = el("div", "eventAlertsCardOpts");

        const leadWrap = el("label", "eventAlertsOpt");
        leadWrap.appendChild(el("span", "eventAlertsOptLabel", s.alertMe));
        const lead = document.createElement("select");
        lead.className = "eventAlertsSelect";
        for (const m of core.LEAD_CHOICES) {
          const o = document.createElement("option");
          o.value = String(m);
          o.textContent = m === 0 ? s.atOpen : s.minBefore(m);
          if (m === cfg.lead) o.selected = true;
          lead.appendChild(o);
        }
        lead.addEventListener("change", () => {
          core.setEventConfig(ev, { lead: Number(lead.value) });
        });
        leadWrap.appendChild(lead);
        opts.appendChild(leadWrap);

        const soundWrap = el("label", "eventAlertsOpt");
        soundWrap.appendChild(el("span", "eventAlertsOptLabel", s.sound));
        const sound = document.createElement("select");
        sound.className = "eventAlertsSelect";
        for (const name of core.SOUNDS) {
          const o = document.createElement("option");
          o.value = name;
          o.textContent = s.sounds[name];
          if (name === cfg.sound) o.selected = true;
          sound.appendChild(o);
        }
        sound.addEventListener("change", () => {
          core.setEventConfig(ev, { sound: sound.value });
        });
        soundWrap.appendChild(sound);
        const play = el("button", "eventAlertsPlayBtn", "▶");
        play.type = "button";
        play.title = s.preview;
        play.setAttribute("aria-label", s.preview);
        play.addEventListener("click", () => playSound(sound.value));
        soundWrap.appendChild(play);
        opts.appendChild(soundWrap);

        const openWrap = el("label", "eventAlertsOpt eventAlertsOptCheck");
        const openCb = document.createElement("input");
        openCb.type = "checkbox";
        openCb.checked = cfg.open;
        openCb.addEventListener("change", () => {
          core.setEventConfig(ev, { open: openCb.checked });
        });
        openWrap.appendChild(openCb);
        openWrap.appendChild(el("span", "eventAlertsOptLabel", s.alsoOpen));
        opts.appendChild(openWrap);

        card.appendChild(opts);
        root.appendChild(card);
      }
    }
  };

  const refreshCountdowns = () => {
    if (!schedule) return;
    const L = lang();
    document.querySelectorAll(".eventAlertsCardNext").forEach((n) => {
      const ev = schedule.events.find((e) => e.id === n.dataset.eventId);
      if (ev) n.textContent = core.nextText(ev, L);
    });
  };

  const wireSettings = () => {
    const master = document.querySelector(".eventAlertsMasterCheckbox");
    if (master) {
      master.checked = core.masterEnabled();
      master.addEventListener("change", () => setSetting(core.KEYS.master, String(master.checked)));
    }
    const volume = document.querySelector(".eventAlertsVolume");
    const volumeOut = document.querySelector(".eventAlertsVolumeValue");
    if (volume) {
      volume.value = String(core.volume());
      if (volumeOut) volumeOut.textContent = `${core.volume()}%`;
      volume.addEventListener("input", () => {
        setSetting(core.KEYS.volume, String(volume.value));
        if (volumeOut) volumeOut.textContent = `${volume.value}%`;
      });
      volume.addEventListener("change", () => playSound("chime"));
    }
    for (const [sel, key] of [
      [".eventAlertsToastCheckbox", core.KEYS.toast],
      [".eventAlertsBannerCheckbox", core.KEYS.banner],
      [".eventAlertsQuietCheckbox", core.KEYS.quiet],
    ]) {
      const cb = document.querySelector(sel);
      if (!cb) continue;
      const dflt = key === core.KEYS.toast ? core.toastEnabled()
        : key === core.KEYS.banner ? core.bannerEnabled() : core.quietEnabled();
      cb.checked = dflt;
      cb.addEventListener("change", () => setSetting(key, String(cb.checked)));
    }

    // Localize the static bits of the section (they also carry data-i18n for
    // the ui/<lang>.json path; this keeps them right even before i18n loads).
    const s = S();
    const put = (sel, text) => {
      const n = document.querySelector(sel);
      if (n) n.textContent = text;
    };
    put(".eventAlertsMasterLabel", s.master);
    put(".eventAlertsVolumeLabel", s.volume);
    put(".eventAlertsToastLabel", s.toast);
    put(".eventAlertsBannerLabel", s.banner);
    put(".eventAlertsQuietLabel", s.quiet);

    renderSection();
    setTimeout(maybeFetch, 500);
    setInterval(refreshCountdowns, 30000);
    document.addEventListener("event-alerts-schedule", renderSection);

    // Language switches and remote setting changes re-render the cards.
    window.__TAURI__?.event?.listen?.("setting-changed", (event) => {
      const key = event?.payload?.key;
      if (key === "dpsMeter.language" || String(key || "").startsWith("dpsMeter.eventAlerts")) {
        wireStaticsOnly();
        renderSection();
      }
    });
    const wireStaticsOnly = () => {
      const t = S();
      put(".eventAlertsMasterLabel", t.master);
      put(".eventAlertsVolumeLabel", t.volume);
      put(".eventAlertsToastLabel", t.toast);
      put(".eventAlertsBannerLabel", t.banner);
      put(".eventAlertsQuietLabel", t.quiet);
    };
  };

  // ---- in-app changelog: shown once per fork release, in the main window ---

  const PARTY_CHANGELOG_VERSION = "2.1.0";
  const PARTY_CHANGELOG = {
    en: [
      "Event Alerts: Settings → Event Alerts — sound, Windows toast and a banner before world events (Rifts, Executors, Abyss Siege, field bosses…).",
      "The schedule comes from the party server (same source as the Discord timer) and works offline with the last known copy.",
      "Groups with bulk on/off, per-event lead time and sound, quiet mode during a boss fight, snooze.",
      "Updates now come from the party fork's releases.",
    ],
    sk: [
      "Upozornenia na eventy: Nastavenia → Upozornenia na eventy — zvuk, Windows toast a banner pred world eventami (Rifty, Executori, Abyss Siege, field bossy…).",
      "Rozpis ide zo servera partie (ten istý zdroj ako Discord časovač) a funguje aj offline s posledným známym.",
      "Skupiny s hromadným zap/vyp, čas a zvuk per event, tichý režim počas boja s bossom, snooze.",
      "Aktualizácie odteraz chodia z releasov nášho forku.",
    ],
  };

  const maybeShowChangelog = () => {
    const KEY = "dpsMeter.partyChangelogSeen";
    if (getSetting(KEY) === PARTY_CHANGELOG_VERSION) return;
    const sk = lang() === "sk";
    const box = document.createElement("div");
    box.className = "partyChangelog";
    const head = document.createElement("div");
    head.className = "partyChangelogHead";
    head.textContent = sk
      ? `Čo je nové vo verzii ${PARTY_CHANGELOG_VERSION}`
      : `What's new in ${PARTY_CHANGELOG_VERSION}`;
    box.appendChild(head);
    const list = document.createElement("ul");
    for (const line of PARTY_CHANGELOG[sk ? "sk" : "en"]) {
      const li = document.createElement("li");
      li.textContent = line;
      list.appendChild(li);
    }
    box.appendChild(list);
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "partyChangelogOk";
    ok.textContent = "OK";
    ok.addEventListener("click", () => {
      setSetting(KEY, PARTY_CHANGELOG_VERSION);
      box.remove();
    });
    box.appendChild(ok);
    document.body.appendChild(box);
  };

  document.addEventListener("DOMContentLoaded", () => {
    // tauriBridge has resolved window.A2_VIEW by now (it loads first). The
    // engine runs ONLY in the main window; details/history windows do nothing.
    const view = window.A2_VIEW || viewMode || "main";
    if (view === "settings") {
      wireSettings();
    } else if (view === "main") {
      startEngine();
      setTimeout(maybeShowChangelog, 1500);
    }
  });
})();
