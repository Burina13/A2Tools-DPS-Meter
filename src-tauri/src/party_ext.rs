//! Party upload extension — the per-event data the party server's timeline
//! needs and the upstream `FightRecord` does not hold (a fork feature; see
//! `party_upload`).
//!
//! `FightRecord` keeps per-hit *times* but not per-hit values, aggregates
//! damage taken into one session-wide number, and keeps no player deaths and
//! no boss-HP history. This module carries exactly those, as a sidecar next
//! to the record: `FightExt` is saved as `history/{id}.ext.json` when the
//! fight is saved and sent as the `ext` field of the party upload body.
//! The upstream type stays untouched, so upstream merges stay clean and a
//! server that never heard of `ext` (or an old client that never sends it)
//! keeps working — the server treats the field as optional.
//!
//! Event timestamps are milliseconds from the fight's `start_time_ms`, the
//! same convention as `DetailSkillEntry.hit_timestamps`.

use serde::{Deserialize, Serialize};

/// Flag bits on damage/heal/taken events. A subset of what the packet knows —
/// enough for the server's death recap and crit/mitigation columns.
pub const FLAG_CRIT: i64 = 1;
pub const FLAG_PARRY: i64 = 2;
pub const FLAG_SHIELD_BLOCK: i64 = 4;
pub const FLAG_PERFECT_BLOCK: i64 = 8;
pub const FLAG_IRON_WALL: i64 = 16;
pub const FLAG_BACK: i64 = 32;
pub const FLAG_FRONTAL: i64 = 64;
pub const FLAG_PERFECT: i64 = 128;
pub const FLAG_DOUBLE: i64 = 256;
pub const FLAG_DOT: i64 = 512;
/// On heal events: a heal-over-time tick rather than a direct heal.
pub const FLAG_HOT: i64 = 512;

/// `[actorId, tsMs, skillCode, value, flags]` — serde turns tuples into JSON
/// arrays, which is the compact shape the server expects.
pub type ExtEvent = (i64, i64, i64, i64, i64);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FightExt {
    /// Format version of this sidecar (1 = first shape).
    pub v: u8,
    /// Player → target hits, per hit, with values (the record has only times).
    pub dmg: Vec<ExtEvent>,
    /// Heal ticks per healer (`FLAG_HOT` marks heal-over-time).
    pub heal: Vec<ExtEvent>,
    /// Target/NPC → player hits with the NPC skill code — the record folds
    /// these into one session-wide number per actor.
    pub taken: Vec<ExtEvent>,
    /// Player deaths: `[actorId, tsMs]`. Slovak field name on purpose — it is
    /// the party server's wire name.
    pub smrti: Vec<(i64, i64)>,
    /// The target's HP over the fight: `[tsMs, hp]`.
    pub boss_hp: Vec<(i64, i64)>,
    /// The target was seen dying (death packet), not inferred from coverage.
    pub boss_killed: Option<bool>,
}

impl FightExt {
    pub fn is_empty(&self) -> bool {
        self.dmg.is_empty()
            && self.heal.is_empty()
            && self.taken.is_empty()
            && self.smrti.is_empty()
            && self.boss_hp.is_empty()
            && self.boss_killed.is_none()
    }
}

/// Where the sidecar of fight `id` lives, next to the history file. `None`
/// when the id would escape the directory (same rule as the history itself).
#[cfg(feature = "desktop")]
pub fn ext_path(app_data_dir: &std::path::Path, id: &str) -> Option<std::path::PathBuf> {
    if !crate::history::fight_history::is_plain_name(id) {
        return None;
    }
    Some(app_data_dir.join("history").join(format!("{id}.ext.json")))
}

#[cfg(feature = "desktop")]
pub fn save(app_data_dir: &std::path::Path, id: &str, ext: &FightExt) {
    if ext.is_empty() {
        return;
    }
    let Some(path) = ext_path(app_data_dir, id) else { return };
    if let Ok(bytes) = serde_json::to_vec(ext) {
        let _ = std::fs::create_dir_all(app_data_dir.join("history"));
        let _ = crate::atomic_file::write(&path, &bytes);
    }
}

#[cfg(feature = "desktop")]
pub fn load(app_data_dir: &std::path::Path, id: &str) -> Option<FightExt> {
    let bytes = std::fs::read(ext_path(app_data_dir, id)?).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wire_shape_matches_the_server() {
        let ext = FightExt {
            v: 1,
            dmg: vec![(1, 10, 11020000, 300, FLAG_CRIT)],
            heal: vec![(1, 500, 11990000, 400, 0)],
            taken: vec![(1, 700, 9000101, 999, FLAG_SHIELD_BLOCK)],
            smrti: vec![(1, 80_000)],
            boss_hp: vec![(0, 1500), (89_000, 0)],
            boss_killed: Some(true),
        };
        let json = serde_json::to_value(&ext).unwrap();
        assert_eq!(json["dmg"][0], serde_json::json!([1, 10, 11020000, 300, 1]));
        assert_eq!(json["smrti"][0], serde_json::json!([1, 80000]));
        assert!(json["bossHp"].is_array(), "camelCase on the wire");
        assert_eq!(json["bossKilled"], serde_json::json!(true));
        let back: FightExt = serde_json::from_value(json).unwrap();
        assert_eq!(back.taken[0].3, 999);
    }

    #[test]
    fn empty_means_empty() {
        assert!(FightExt { v: 1, ..Default::default() }.is_empty());
        assert!(!FightExt { boss_killed: Some(false), ..Default::default() }.is_empty());
    }
}
