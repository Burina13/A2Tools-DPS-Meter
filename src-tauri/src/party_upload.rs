//! Party upload — automatic upload of finished boss fights to the party's own
//! server (a fork feature; upstream uploads go to a2tools.app and stay
//! untouched and off by default).
//!
//! Why this exists: every client only sees the packets the game server sent
//! *it*, so each party member's meter shows different numbers. The party
//! server merges the captures of everyone who uploaded and posts one canonical
//! result per boss to Discord. What is sent is the saved `FightRecord` (the
//! per-skill breakdown History already holds), the actor-id → name map, and
//! the damage anchors the server uses to recognise two captures of the same
//! fight — not the raw packets.
//!
//! The queue is deliberately file-per-fight under `party_upload/` in the app
//! data dir, mirroring `share`'s slice meta: a fight whose upload failed (or
//! never ran because the meter was closed) is retried by the 30-second
//! maintenance loop and — the part retries alone cannot cover — re-queued on
//! the next launch by `requeue_on_launch`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::entity::fight_record::FightRecord;

/// The settings that turn party uploads on. All three must be set: an enabled
/// toggle without a URL or key is a misconfiguration, not a consent.
pub const ENABLED_KEY: &str = "dpsMeter.partyUpload";
pub const URL_KEY: &str = "dpsMeter.partyUploadUrl";
pub const KEY_KEY: &str = "dpsMeter.partyUploadKey";

/// The same "fight is over" rule the a2tools auto-upload uses: a boss still
/// being fought is re-saved every 30 seconds, and uploading those partial
/// records would post a fight that has not happened yet.
const ENDED_AFTER_MS: i64 = 10_000;

/// Retry backoff in minutes; after the last one the fight waits for the next
/// launch (`requeue_on_launch`) instead of retrying forever.
const RETRY_MINUTES: [i64; 6] = [1, 2, 5, 15, 30, 60];

pub fn config(settings: &crate::config::settings::Settings) -> Option<(String, String)> {
    if settings.get(ENABLED_KEY).as_deref() != Some("true") {
        return None;
    }
    let url = settings.get(URL_KEY).unwrap_or_default().trim().trim_end_matches('/').to_string();
    let key = settings.get(KEY_KEY).unwrap_or_default().trim().to_string();
    if url.is_empty() || key.is_empty() { None } else { Some((url, key)) }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct QueueMeta {
    /// Upload attempts so far this cycle. 0 = never tried (or re-queued).
    attempts: u32,
    /// When to try again (ms since the epoch); 0 = due now.
    retry_at_ms: i64,
    /// Accepted by the server — never sent again.
    sent: bool,
    /// Refused for good (bad key, bad request) or out of retries; waits for
    /// the next launch rather than looping.
    parked: bool,
}

fn queue_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("party_upload")
}

fn meta_path(app_data_dir: &Path, id: &str) -> PathBuf {
    queue_dir(app_data_dir).join(format!("{id}.json"))
}

fn read_meta(app_data_dir: &Path, id: &str) -> Option<QueueMeta> {
    let bytes = std::fs::read(meta_path(app_data_dir, id)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_meta(app_data_dir: &Path, id: &str, meta: &QueueMeta) {
    if !crate::history::fight_history::is_plain_name(id) {
        return;
    }
    let _ = std::fs::create_dir_all(queue_dir(app_data_dir));
    if let Ok(bytes) = serde_json::to_vec(meta) {
        let _ = crate::atomic_file::write(&meta_path(app_data_dir, id), &bytes);
    }
}

/// Should the save path upload this fight now? Only a finished fight, once;
/// a fight that already tried and failed belongs to the retry schedule.
pub fn wants_upload(app_data_dir: &Path, record: &FightRecord, now_ms: i64) -> bool {
    if record.is_train || now_ms - (record.start_time_ms + record.duration_ms) < ENDED_AFTER_MS {
        return false;
    }
    match read_meta(app_data_dir, &record.id) {
        None => true,
        Some(meta) => !meta.sent && !meta.parked && meta.attempts == 0,
    }
}

/// An upload failed; schedule the retry, or park the fight until next launch.
pub fn note_failure(app_data_dir: &Path, id: &str, retryable: bool, now_ms: i64) {
    let mut meta = read_meta(app_data_dir, id).unwrap_or_default();
    meta.attempts += 1;
    match RETRY_MINUTES.get(meta.attempts as usize - 1) {
        Some(minutes) if retryable => meta.retry_at_ms = now_ms + minutes * 60_000,
        _ => meta.parked = true,
    }
    write_meta(app_data_dir, id, &meta);
}

pub fn mark_sent(app_data_dir: &Path, id: &str) {
    write_meta(app_data_dir, id, &QueueMeta { sent: true, ..Default::default() });
}

/// Fights whose upload failed and is due another try.
pub fn retries_due(app_data_dir: &Path, now_ms: i64) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(queue_dir(app_data_dir)) else { return Vec::new() };
    rd.filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".json").map(str::to_string))
        .filter(|id| {
            read_meta(app_data_dir, id).is_some_and(|m| {
                !m.sent && !m.parked && m.attempts > 0 && m.retry_at_ms <= now_ms
            })
        })
        .collect()
}

/// On launch, give every unsent fight a fresh set of retries. This is the
/// "offline queue" promise: a fight recorded without a connection is sent the
/// next time the meter starts.
pub fn requeue_on_launch(app_data_dir: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(queue_dir(app_data_dir)) else { return Vec::new() };
    let mut out = Vec::new();
    for id in rd
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".json").map(str::to_string))
    {
        if let Some(meta) = read_meta(app_data_dir, &id) {
            if !meta.sent {
                write_meta(app_data_dir, &id, &QueueMeta::default());
                out.push(id);
            }
        }
    }
    out
}

/// Drop queue entries whose fight History no longer holds (pruned or deleted).
pub fn prune(app_data_dir: &Path) {
    let Ok(rd) = std::fs::read_dir(queue_dir(app_data_dir)) else { return };
    for entry in rd.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".json") else { continue };
        if !app_data_dir.join("history").join(format!("{id}.json")).exists() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(feature = "online")]
/// Why an upload failed, and whether the same upload later could work.
pub struct UploadFailure {
    pub message: String,
    pub retryable: bool,
}

/// The upload body: the full record, the id → name map (the names the record
/// already holds — everyone but the local player masked, exactly what History
/// shows), the uploader's actor id, the damage anchors and — when the fight
/// was saved by a client this new — the `ext` per-event sidecar
/// (`party_ext::FightExt`). `ext` is `null` otherwise; the server treats it
/// as optional, so old clients and old saves keep uploading unchanged.
fn build_body(
    record: &FightRecord,
    uploader_actor_id: Option<i32>,
    anchors: &[String],
    ext: Option<crate::party_ext::FightExt>,
    now_ms: i64,
) -> serde_json::Value {
    let names: HashMap<String, String> = record
        .actors
        .iter()
        .map(|a| (a.actor_id.to_string(), a.nickname.clone()))
        .collect();
    serde_json::json!({
        "record": record,
        "names": names,
        "uploaderActorId": uploader_actor_id,
        "anchors": anchors,
        "ext": ext,
        "appVersion": crate::entity::fight_record::APP_VERSION,
        "clientTimeMs": now_ms,
    })
}

#[cfg(feature = "online")]
/// Send one saved fight to the party server. The server answers 200 with
/// `{ok, encounterId, captur}`.
pub async fn upload(
    client: &reqwest::Client,
    app_data_dir: &Path,
    record: &FightRecord,
    base_url: &str,
    key: &str,
) -> Result<(), UploadFailure> {
    let envelope = crate::share::build_envelope(record, &[]);
    let body = build_body(
        record,
        crate::share::uploader_actor_id(app_data_dir, &record.id),
        &envelope.anchors,
        crate::party_ext::load(app_data_dir, &record.id),
        crate::clock::now_ms(),
    );
    let compressed = crate::share::gzip(body.to_string().as_bytes())
        .map_err(|e| UploadFailure { message: e, retryable: false })?;

    let response = client
        .post(format!("{base_url}/api/upload"))
        .timeout(std::time::Duration::from_secs(60))
        .header("authorization", format!("Bearer {key}"))
        .header("content-type", "application/json")
        .header("content-encoding", "gzip")
        .body(compressed)
        .send()
        .await
        .map_err(|e| UploadFailure {
            message: format!("Could not reach the party server: {e}"),
            retryable: true,
        })?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let text = response.text().await.unwrap_or_default();
    let reply: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    let message = reply
        .get("chyba")
        .and_then(|m| m.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Party upload failed ({status})."));
    // A server that is down, busy or rate limiting may take it later; one
    // that refused the key or the fight will refuse it again.
    let retryable = status.as_u16() == 408 || status.as_u16() == 429 || status.is_server_error();
    Err(UploadFailure { message, retryable })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("a2t-party-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn record(id: &str, start: i64, dur: i64, train: bool) -> FightRecord {
        serde_json::from_value(serde_json::json!({
            "id": id, "bossName": "b", "targetId": 1, "startTimeMs": start,
            "durationMs": dur, "totalDamage": 1, "jobs": [], "isTrain": train,
            "details": {"targetId": 1, "totalTargetDamage": 1, "battleTime": dur,
                         "skills": []},
            "actors": [],
        }))
        .unwrap()
    }

    #[test]
    fn a_finished_fight_is_wanted_once_and_follows_the_retry_schedule() {
        let d = dir("retry");
        let r = record("f1", 0, 1_000, false);
        assert!(!wants_upload(&d, &r, 5_000), "not over yet");
        assert!(wants_upload(&d, &r, 20_000), "over and never tried");
        assert!(!wants_upload(&d, &record("t", 0, 1_000, true), 20_000), "training dummy");

        note_failure(&d, "f1", true, 20_000);
        assert!(!wants_upload(&d, &r, 30_000), "failed fights belong to the retry schedule");
        assert!(retries_due(&d, 20_000 + 59_000).is_empty(), "first retry after a minute");
        assert_eq!(retries_due(&d, 20_000 + 60_000), vec!["f1".to_string()]);

        for _ in 0..RETRY_MINUTES.len() {
            note_failure(&d, "f1", true, 20_000);
        }
        assert!(retries_due(&d, i64::MAX).is_empty(), "out of retries: parked");

        let requeued = requeue_on_launch(&d);
        assert_eq!(requeued, vec!["f1".to_string()], "next launch re-queues it");
        assert!(wants_upload(&d, &r, 30_000));

        mark_sent(&d, "f1");
        assert!(!wants_upload(&d, &r, 30_000), "sent is sent");
        assert!(requeue_on_launch(&d).is_empty(), "sent fights never re-queue");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_fatal_failure_parks_without_retries() {
        let d = dir("fatal");
        note_failure(&d, "f2", false, 1_000);
        assert!(retries_due(&d, i64::MAX).is_empty());
        assert_eq!(requeue_on_launch(&d), vec!["f2".to_string()]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_body_carries_ext_when_there_is_one_and_null_when_not() {
        let r = record("f3", 0, 1_000, false);
        let holy = build_body(&r, Some(7), &["a".into()], None, 123);
        assert!(holy["ext"].is_null(), "no sidecar: ext is null, not absent");
        assert_eq!(holy["uploaderActorId"], serde_json::json!(7));
        assert_eq!(holy["anchors"], serde_json::json!(["a"]));

        let ext = crate::party_ext::FightExt {
            v: 1,
            smrti: vec![(7, 500)],
            boss_killed: Some(true),
            ..Default::default()
        };
        let with = build_body(&r, None, &[], Some(ext), 123);
        assert_eq!(with["ext"]["smrti"], serde_json::json!([[7, 500]]));
        assert_eq!(with["ext"]["bossKilled"], serde_json::json!(true));
        assert!(with["uploaderActorId"].is_null());
    }

    #[test]
    fn the_ext_sidecar_saves_and_loads_next_to_history() {
        let d = dir("ext");
        let ext = crate::party_ext::FightExt {
            v: 1,
            dmg: vec![(1, 10, 11020000, 300, 1)],
            ..Default::default()
        };
        crate::party_ext::save(&d, "f4", &ext);
        let back = crate::party_ext::load(&d, "f4").expect("saved sidecar loads");
        assert_eq!(back.dmg, ext.dmg);
        assert!(crate::party_ext::load(&d, "missing").is_none());
        assert!(crate::party_ext::load(&d, "../escape").is_none(), "no path escape");
        crate::party_ext::save(&d, "empty", &Default::default());
        assert!(crate::party_ext::load(&d, "empty").is_none(), "an empty ext is not written");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn prune_follows_history() {
        let d = dir("prune");
        std::fs::create_dir_all(d.join("history")).unwrap();
        std::fs::write(d.join("history/kept.json"), b"{}").unwrap();
        mark_sent(&d, "kept");
        mark_sent(&d, "gone");
        prune(&d);
        assert!(meta_path(&d, "kept").exists());
        assert!(!meta_path(&d, "gone").exists());
        let _ = std::fs::remove_dir_all(&d);
    }
}
