//! Global hotkeys on Linux, through the desktop's GlobalShortcuts portal
//! (`org.freedesktop.portal.GlobalShortcuts`).
//!
//! Wayland lets no app grab keys for itself: the desktop owns them, and an app
//! asks the portal for named shortcuts. KDE Plasma 6 (Bazzite's desktop) shows
//! the meter's shortcuts with the keys it suggests and lets the user keep or
//! change them; GNOME 48 and later do the same. Hyprland's portal ignores the
//! suggested keys: the user binds each shortcut in their config with the
//! `global` dispatcher, by the id `hyprctl globalshortcuts` lists
//! (`com.a2tools.dps-meter:reset`), as docs/linux.md shows. With no portal, or
//! one without GlobalShortcuts, there are no hotkeys, as before.
//!
//! The keys are only suggestions here, so the meter's own Keybinds settings
//! decide what is suggested; the desktop decides what is bound.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tracing::{info, warn};
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{ObjectPath, OwnedValue, Value};

const PORTAL: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const SHORTCUTS: &str = "org.freedesktop.portal.GlobalShortcuts";
/// The app id the shortcuts are filed under: Tauri's identifier. The .deb and
/// .rpm name their desktop file after the product ("A2Tools DPS Meter"),
/// which is no valid app id, so the identifier is registered instead.
const APP_ID: &str = "com.a2tools.dps-meter";

/// The shortcut ids, stable: Hyprland users bind them by name.
const RELOAD: &str = "reset";
const TOGGLE: &str = "toggle";
const LOCK: &str = "lock";

pub struct HotkeyManager {
    running: Arc<AtomicBool>,
    /// The portal connection while shortcuts are bound; closing it ends the
    /// session and the listener.
    connection: Arc<Mutex<Option<Connection>>>,
}

impl HotkeyManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            connection: Arc::new(Mutex::new(None)),
        }
    }

    /// Bind the three shortcuts and listen for them. The numbers are the
    /// Win32 modifier flags and virtual-key codes settings store
    /// (`parse_hotkey_label`); a key of 0 leaves that shortcut out.
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        reload_mods: u32,
        reload_vk: u32,
        toggle_mods: u32,
        toggle_vk: u32,
        lock_mods: u32,
        lock_vk: u32,
        on_reload: impl Fn() + Send + 'static,
        on_toggle: impl Fn() + Send + 'static,
        on_lock: impl Fn() + Send + 'static,
    ) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let wanted: Vec<(&'static str, &'static str, Option<String>)> = [
            (RELOAD, "Reset the meter", reload_mods, reload_vk),
            (TOGGLE, "Show or hide the meter", toggle_mods, toggle_vk),
            (LOCK, "Turn the click-through lock on or off", lock_mods, lock_vk),
        ]
        .into_iter()
        .filter(|&(_, _, _, vk)| vk != 0)
        .map(|(id, description, mods, vk)| (id, description, trigger(mods, vk)))
        .collect();

        let running = self.running.clone();
        let slot = self.connection.clone();
        std::thread::spawn(move || {
            let result = listen(&wanted, &slot, |id| match id {
                RELOAD => on_reload(),
                TOGGLE => on_toggle(),
                LOCK => on_lock(),
                _ => {}
            });
            if let Err(e) = result {
                warn!("Global hotkeys unavailable (no GlobalShortcuts portal?): {e}");
            }
            *slot.lock().unwrap_or_else(|p| p.into_inner()) = None;
            running.store(false, Ordering::SeqCst);
        });
    }

    pub fn stop(&self) {
        // Closing the connection ends the portal session, and with it the
        // listener's signal stream.
        let connection = self.connection.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(connection) = connection {
            let _ = connection.close();
        }
        self.running.store(false, Ordering::SeqCst);
    }
}

/// The portal's trigger for a Win32 modifier set and key (`CTRL+ALT+r`), in
/// the shortcuts spec's form: modifiers by name, the key by its XKB name.
/// `None` for a key it has no name for; the shortcut is still bound, without
/// a suggestion.
fn trigger(mods: u32, vk: u32) -> Option<String> {
    let key = match vk {
        0x30..=0x39 => ((vk as u8) as char).to_string(),
        0x41..=0x5A => ((vk as u8).to_ascii_lowercase() as char).to_string(),
        0x70..=0x7B => format!("F{}", vk - 0x6F),
        0x08 => "BackSpace".into(),
        0x09 => "Tab".into(),
        0x0D => "Return".into(),
        0x1B => "Escape".into(),
        0x20 => "space".into(),
        0x21 => "Page_Up".into(),
        0x22 => "Page_Down".into(),
        0x23 => "End".into(),
        0x24 => "Home".into(),
        0x25 => "Left".into(),
        0x26 => "Up".into(),
        0x27 => "Right".into(),
        0x28 => "Down".into(),
        0x2D => "Insert".into(),
        0x2E => "Delete".into(),
        _ => return None,
    };
    let mut parts: Vec<&str> = Vec::new();
    if mods & 0x0002 != 0 {
        parts.push("CTRL");
    }
    if mods & 0x0001 != 0 {
        parts.push("ALT");
    }
    if mods & 0x0004 != 0 {
        parts.push("SHIFT");
    }
    if mods & 0x0008 != 0 {
        parts.push("LOGO");
    }
    let mut out = parts.join("+");
    if !out.is_empty() {
        out.push('+');
    }
    out.push_str(&key);
    Some(out)
}

/// Register, open a session, bind the shortcuts and call `fire` with each
/// activated shortcut's id until the connection closes.
fn listen(
    wanted: &[(&'static str, &'static str, Option<String>)],
    slot: &Mutex<Option<Connection>>,
    fire: impl Fn(&str),
) -> zbus::Result<()> {
    let connection = Connection::session()?;

    // The portal reads /proc/<pid>/root to tell a sandboxed app from a host
    // one, and a process with file capabilities (the packages give the meter
    // cap_net_raw, for capture) is not dumpable, so its /proc entries belong
    // to root and the portal refused every call: "Portal operation not
    // allowed: Unable to open /proc/<pid>/root" (#42). So the meter is made
    // dumpable for the calls only, and not again once the last is sent:
    // under a second, never while a desktop's confirmation dialog waits.
    let mut inspectable = Inspectable::open();

    // A host (unsandboxed) app says who it is before any other portal call,
    // so the desktop files its shortcuts under the meter rather than an
    // unnamed app. Portals before 1.19 have no registry: carry on without.
    let registry = proxy(&connection, PORTAL_PATH, "org.freedesktop.host.portal.Registry")?;
    let no_options: HashMap<&str, Value> = HashMap::new();
    if let Err(e) = registry.call::<_, _, ()>("Register", &(APP_ID, no_options)) {
        info!("Portal registry unavailable ({e}); binding shortcuts unregistered");
    }

    let portal = proxy(&connection, PORTAL_PATH, SHORTCUTS)?;
    // Listen before binding, so no activation is missed.
    let activations = portal.receive_signal("Activated")?;

    let mut options: HashMap<&str, Value> = HashMap::new();
    options.insert("handle_token", Value::from("a2t_session_req"));
    options.insert("session_handle_token", Value::from("a2t_session"));
    let (code, results) =
        request(&connection, &portal, "a2t_session_req", "CreateSession", &(options,), || {})?;
    if code != 0 {
        return Err(zbus::Error::Failure(format!("CreateSession refused ({code})")));
    }
    let session: String = results
        .get("session_handle")
        .and_then(|v| v.downcast_ref::<&str>().ok().map(str::to_string))
        .ok_or_else(|| zbus::Error::Failure("CreateSession gave no session".into()))?;
    let session_path = ObjectPath::try_from(session.as_str())?;

    let shortcuts: Vec<(&str, HashMap<&str, Value>)> = wanted
        .iter()
        .map(|(id, description, trigger)| {
            let mut props: HashMap<&str, Value> = HashMap::new();
            props.insert("description", Value::from(*description));
            if let Some(t) = trigger {
                props.insert("preferred_trigger", Value::from(t.as_str()));
            }
            (*id, props)
        })
        .collect();
    let mut bind_options: HashMap<&str, Value> = HashMap::new();
    bind_options.insert("handle_token", Value::from("a2t_bind_req"));
    let (code, _) = request(
        &connection,
        &portal,
        "a2t_bind_req",
        "BindShortcuts",
        &(&session_path, shortcuts, "", bind_options),
        || drop(inspectable.take()),
    )?;
    if code != 0 {
        // 1: the user dismissed the desktop's dialog. Nothing is bound.
        return Err(zbus::Error::Failure(format!("BindShortcuts refused ({code})")));
    }
    info!(
        "Global hotkeys bound through the portal: {}",
        wanted
            .iter()
            .map(|(id, _, t)| format!("{APP_ID}:{id}={}", t.as_deref().unwrap_or("-")))
            .collect::<Vec<_>>()
            .join(", ")
    );

    if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() {
        hyprland_bind(wanted);
    }

    *slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(connection.clone());
    for message in activations {
        let body = message.body();
        let Ok((from, id, _time, _options)) =
            body.deserialize::<(ObjectPath<'_>, &str, u64, HashMap<&str, OwnedValue>)>()
        else {
            continue;
        };
        if from.as_str() == session_path.as_str() {
            fire(id);
        }
    }
    Ok(())
}

/// Hyprland binds nothing on its own: its portal takes no suggested keys, and
/// the user would have to add a `global` bind for each shortcut. So on
/// Hyprland the meter adds them itself, at run time through `hyprctl`, for
/// this session only (a config reload drops them; the next start adds them
/// again). A key combination that is already bound, by the user or by an
/// earlier start, is left alone, so nothing of theirs is shadowed and nothing
/// fires twice.
fn hyprland_bind(wanted: &[(&'static str, &'static str, Option<String>)]) {
    use std::process::Command;
    let run = |args: &[&str]| -> Option<String> {
        let out = Command::new("hyprctl").args(args).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    };
    // The ids as Hyprland filed them (`appid:shortcut`): the app id part is
    // the portal's to choose, so read it rather than assume it.
    let Some(listed) = run(&["globalshortcuts", "-j"]) else {
        warn!("Hyprland: hyprctl globalshortcuts failed; bind the meter's shortcuts by hand");
        return;
    };
    let listed: Vec<serde_json::Value> = serde_json::from_str(&listed).unwrap_or_default();
    let existing: Vec<(u64, String)> = run(&["binds", "-j"])
        .and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(&s).ok())
        .unwrap_or_default()
        .iter()
        .map(|b| {
            (
                b.get("modmask").and_then(|m| m.as_u64()).unwrap_or(0),
                b.get("key").and_then(|k| k.as_str()).unwrap_or("").to_lowercase(),
            )
        })
        .collect();

    for (id, description, trigger) in wanted {
        let Some(trigger) = trigger else { continue };
        let Some(name) = listed.iter().find_map(|s| {
            let name = s.get("name").and_then(|n| n.as_str())?;
            let ours = name.ends_with(&format!(":{id}"))
                && s.get("description").and_then(|d| d.as_str()) == Some(*description);
            ours.then(|| name.to_string())
        }) else {
            continue;
        };
        let Some((mods, key)) = hyprland_keys(trigger) else { continue };
        if existing.iter().any(|(m, k)| *m == mods.mask && *k == key.to_lowercase()) {
            info!("Hyprland: {} is already bound; left for {name}", trigger);
            continue;
        }
        // Lua config (current Hyprland) first, then the hyprlang `keyword`.
        let lua = format!(
            "hl.bind(\"{}\", hl.dsp.global(\"{}\"))",
            mods.plus_joined(&key),
            name
        );
        let ok = run(&["eval", &lua]).is_some_and(|s| s.trim() == "ok")
            || run(&["keyword", "bind", &format!("{}, {}, global, {}", mods.space_joined(), key, name)])
                .is_some_and(|s| s.trim() == "ok");
        if ok {
            info!("Hyprland: bound {trigger} to {name}");
        } else {
            warn!("Hyprland: could not bind {trigger} to {name}; bind it by hand");
        }
    }
}

/// A trigger's modifiers, as Hyprland names and masks them.
struct HyprMods {
    names: Vec<&'static str>,
    mask: u64,
}

impl HyprMods {
    fn plus_joined(&self, key: &str) -> String {
        let mut parts: Vec<&str> = self.names.clone();
        parts.push(key);
        parts.join(" + ")
    }
    fn space_joined(&self) -> String {
        self.names.join(" ")
    }
}

/// `CTRL+ALT+r` as Hyprland binds it: its modifier names and mask (SHIFT 1,
/// CTRL 4, ALT 8, SUPER 64) and the key.
fn hyprland_keys(trigger: &str) -> Option<(HyprMods, String)> {
    let mut mods = HyprMods { names: Vec::new(), mask: 0 };
    let mut key = None;
    for part in trigger.split('+') {
        match part {
            "CTRL" => {
                mods.names.push("CTRL");
                mods.mask |= 4;
            }
            "ALT" => {
                mods.names.push("ALT");
                mods.mask |= 8;
            }
            "SHIFT" => {
                mods.names.push("SHIFT");
                mods.mask |= 1;
            }
            "LOGO" => {
                mods.names.push("SUPER");
                mods.mask |= 64;
            }
            k => key = Some(k.to_string()),
        }
    }
    Some((mods, key?))
}

/// A proxy on the portal that never reads properties: none are used, and a
/// Request object does not exist until the call that makes it.
fn proxy<'a>(connection: &Connection, path: &'a str, interface: &'a str) -> zbus::Result<Proxy<'a>> {
    zbus::blocking::proxy::Builder::new(connection)
        .destination(PORTAL)?
        .path(path)?
        .interface(interface)?
        .cache_properties(zbus::proxy::CacheProperties::No)
        .build()
}

/// The process made dumpable while it lives, and made non-dumpable again when
/// dropped. `None` when it already was dumpable (no file capabilities, as
/// when built from source and run as yourself): nothing to undo then.
struct Inspectable;

impl Inspectable {
    fn open() -> Option<Self> {
        // SAFETY: prctl with these options only reads or sets this
        // process's dumpable flag.
        unsafe {
            if libc::prctl(libc::PR_GET_DUMPABLE, 0, 0, 0, 0) != 0 {
                return None;
            }
            (libc::prctl(libc::PR_SET_DUMPABLE, 1, 0, 0, 0) == 0).then_some(Inspectable)
        }
    }
}

impl Drop for Inspectable {
    fn drop(&mut self) {
        // SAFETY: as above.
        unsafe {
            libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0);
        }
    }
}

/// Call a portal method that answers through a Request object, and wait for
/// its Response. The Request's path is known before the call (the sender's
/// unique name and the token), so its signal is subscribed first and cannot
/// be missed.
fn request<B>(
    connection: &Connection,
    portal: &Proxy<'_>,
    token: &str,
    method: &str,
    body: &B,
    sent: impl FnOnce(),
) -> zbus::Result<(u32, HashMap<String, OwnedValue>)>
where
    B: serde::Serialize + zbus::zvariant::DynamicType,
{
    let sender = connection
        .unique_name()
        .map(|n| n.as_str().trim_start_matches(':').replace('.', "_"))
        .ok_or_else(|| zbus::Error::Failure("no unique bus name".into()))?;
    let path = format!("{PORTAL_PATH}/request/{sender}/{token}");
    let request = proxy(connection, &path, "org.freedesktop.portal.Request")?;
    let mut responses = request.receive_signal("Response")?;
    let _handle: zbus::zvariant::OwnedObjectPath = portal.call(method, body)?;
    // The portal has checked the caller by now; only the answer is awaited.
    sent();
    let message = responses
        .next()
        .ok_or_else(|| zbus::Error::Failure(format!("{method}: no response")))?;
    message.body().deserialize::<(u32, HashMap<String, OwnedValue>)>()
}

#[cfg(test)]
mod tests {
    use super::{hyprland_keys, trigger};

    #[test]
    fn hyprland_reads_a_trigger_as_its_modifiers_and_key() {
        let (mods, key) = hyprland_keys("CTRL+ALT+r").unwrap();
        assert_eq!((mods.mask, key.as_str()), (12, "r"));
        assert_eq!(mods.plus_joined(&key), "CTRL + ALT + r");
        assert_eq!(mods.space_joined(), "CTRL ALT");
        let (mods, key) = hyprland_keys("LOGO+SHIFT+F5").unwrap();
        assert_eq!((mods.mask, key.as_str()), (65, "F5"));
        assert!(hyprland_keys("CTRL+ALT").is_none());
    }

    #[test]
    fn triggers_read_as_the_shortcuts_spec_writes_them() {
        assert_eq!(trigger(0x0002 | 0x0001, 0x52).as_deref(), Some("CTRL+ALT+r"));
        assert_eq!(trigger(0x0002 | 0x0001, 0x26).as_deref(), Some("CTRL+ALT+Up"));
        assert_eq!(trigger(0x0002 | 0x0004, 0x74).as_deref(), Some("CTRL+SHIFT+F5"));
        assert_eq!(trigger(0x0008, 0x31).as_deref(), Some("LOGO+1"));
        assert_eq!(trigger(0x0002, 0xBA), None);
    }
}
