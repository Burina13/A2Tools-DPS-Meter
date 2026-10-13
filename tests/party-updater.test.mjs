// Fork guard: updates must come from the party fork's own release manifest,
// never from upstream's. party-v2.0.62-1 still checked a2tools.app's manifest,
// which is how an upstream MSI replaced the fork on a player's machine on
// 13.10.2026 — these tests keep that from coming back.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const checkRelease = readFileSync(
  new URL("../public/src/js/checkRelease.js", import.meta.url),
  "utf8"
);
const tauriConf = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url))
);
const manifest = JSON.parse(
  readFileSync(new URL("../latest-party.json", import.meta.url))
);

const PARTY_MANIFEST =
  "https://raw.githubusercontent.com/Burina13/A2Tools-DPS-Meter/main/latest-party.json";

test("checkRelease.js knows only the party manifest, not upstream's", () => {
  assert.ok(checkRelease.includes(PARTY_MANIFEST));
  // No upstream endpoint anywhere in the updater: not the manifest host,
  // not the CDN the packages came from.
  assert.ok(!checkRelease.includes("a2tools.app"));
  assert.ok(!checkRelease.includes("latest-v2.json"));
});

test("the update check fetches the party manifest and nothing else", async () => {
  const fetched = [];
  const updateWindows = [];
  const context = {
    console: { log() {}, error() {} },
    setTimeout: (fn) => { fn(); return 0; },
    Promise,
    JSON,
    String,
    Number,
    Boolean,
    window: undefined,
  };
  const window = {
    dpsData: { getVersion: () => "2.64.1" },
    javaBridge: { openBrowser() {} },
    __TAURI__: {
      core: {
        invoke: async (command, args) => {
          if (command === "fetch_url") {
            fetched.push(args.url);
            return JSON.stringify({
              version: "99.0.0",
              msiUrl: "https://github.com/Burina13/A2Tools-DPS-Meter/releases/download/party-v99.0.0/x.msi",
              msiSha256: "0".repeat(64),
            });
          }
          if (command === "show_update_window") {
            updateWindows.push(args);
            return true;
          }
          throw new Error(`unexpected command ${command}`);
        },
      },
    },
  };
  context.window = window;
  vm.runInNewContext(checkRelease, context);
  await window.ReleaseChecker.start();
  // Let the async chain inside start() settle.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fetched, [PARTY_MANIFEST]);
  assert.equal(updateWindows.length, 1);
  assert.equal(updateWindows[0].latest, "v99.0.0");
  assert.ok(updateWindows[0].msiUrl.includes("Burina13/A2Tools-DPS-Meter"));
});

test("the bundle is its own product, not upstream's", () => {
  assert.equal(tauriConf.productName, "Tvoj Tatko DPS Meter");
  assert.equal(tauriConf.identifier, "sk.tvojtatko.dps-meter");
  // The pinned WiX upgrade code: with upstream's (derived from its product
  // name) an upstream MSI would replace this install. Any change here means
  // existing installs stop upgrading — do it knowingly or not at all.
  assert.equal(
    tauriConf.bundle.windows.wix.upgradeCode,
    "746f8303-0e92-5346-b0c9-cee765cb281a"
  );
  // 2.<upstream patch>.<party build> sorts above upstream's 2.0.x line and
  // above the old party line (2.1.0, 2.2.0), so every install sees updates.
  const [major, minor] = tauriConf.version.split(".").map(Number);
  assert.equal(major, 2);
  assert.ok(minor >= 64, `version ${tauriConf.version} must stay ahead of upstream 2.0.x`);
});

test("latest-party.json points at the party fork's releases", () => {
  assert.ok(
    manifest.msiUrl.startsWith(
      "https://github.com/Burina13/A2Tools-DPS-Meter/releases/download/"
    )
  );
  assert.match(manifest.msiSha256, /^[0-9a-f]{64}$/);
});
