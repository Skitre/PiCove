//! Detached Extension Float windows (extension-deck.md, "Detached float windows").
//!
//! A detached Float is a **thin client**: its window renders one presentation
//! slot and nothing else. The main window remains the only Host client and the
//! only writer of DesktopSettings, so everything here is window management —
//! create, move, raise, destroy — and never content or preferences.
//!
//! Float windows are bounded by the main window's lifetime. They are destroyed
//! on app exit, and any window left behind by a crash is destroyed at startup
//! before a placement is restored, so no orphan ever outlives the application.

use crate::extension_ui_settings::{
    MonitorDescriptor, MonitorPosition, MonitorSize, ScreenRect, MAX_EXTENSION_UI_FLOATS,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

/// Every detached Float window label starts with this, so orphans left by a
/// crash are identifiable at startup without consulting any stored state.
pub const FLOAT_WINDOW_LABEL_PREFIX: &str = "pideck-float-";

/// Slot ids come from `ExtensionId × family` and may hold characters a window
/// label rejects, so the label carries a hash rather than the id itself. FNV-1a
/// keeps it dependency-free and stable across launches, which is what orphan
/// cleanup and reattachment need.
pub fn float_window_label(slot_id: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in slot_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{FLOAT_WINDOW_LABEL_PREFIX}{hash:016x}")
}

pub fn is_float_window_label(label: &str) -> bool {
    label.starts_with(FLOAT_WINDOW_LABEL_PREFIX)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatWindowRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatWindowSnapshot {
    pub slot_id: String,
    pub label: String,
}

/// Reject a slot id that could not have come from the presentation layer before
/// it reaches window creation.
fn validate_slot_id(slot_id: &str) -> Result<(), String> {
    if slot_id.is_empty() || slot_id.len() > 512 {
        return Err("invalid extension float slot id".to_string());
    }
    if slot_id.chars().any(|c| c.is_control()) {
        return Err("invalid extension float slot id".to_string());
    }
    Ok(())
}

fn logical(value: i32, scale: f64) -> f64 {
    if scale > 0.0 {
        f64::from(value) / scale
    } else {
        f64::from(value)
    }
}

fn logical_u32(value: u32, scale: f64) -> f64 {
    if scale > 0.0 {
        f64::from(value) / scale
    } else {
        f64::from(value)
    }
}

/// Describe every attached display in the logical space the placement model
/// uses. Physical-to-logical conversion happens here, once, so no other layer
/// has to track which pixel space it holds.
pub fn available_monitors(app: &AppHandle) -> Result<Vec<MonitorDescriptor>, String> {
    let monitors = app
        .available_monitors()
        .map_err(|error| error.to_string())?;
    Ok(monitors
        .into_iter()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let work = monitor.work_area();
            MonitorDescriptor {
                name: monitor.name().cloned(),
                position: MonitorPosition {
                    x: logical(monitor.position().x, scale),
                    y: logical(monitor.position().y, scale),
                },
                size: MonitorSize {
                    width: logical_u32(monitor.size().width, scale),
                    height: logical_u32(monitor.size().height, scale),
                },
                scale_factor: scale,
                work_area: Some(ScreenRect {
                    x: logical(work.position.x, scale),
                    y: logical(work.position.y, scale),
                    width: logical_u32(work.size.width, scale),
                    height: logical_u32(work.size.height, scale),
                }),
            }
        })
        .collect())
}

#[derive(Default)]
pub struct ExtensionFloatManager {
    /// slot id → window label, for the windows this process created.
    windows: BTreeMap<String, String>,
}

impl ExtensionFloatManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Destroy every Float window this process can see, including orphans from a
    /// previous run that this manager never registered.
    pub fn destroy_all(&mut self, app: &AppHandle) {
        for (_, window) in app.webview_windows() {
            if is_float_window_label(window.label()) {
                let _ = window.destroy();
            }
        }
        self.windows.clear();
    }

    pub fn open(
        &mut self,
        app: &AppHandle,
        slot_id: &str,
        rect: &FloatWindowRect,
        title: &str,
        always_on_top: bool,
    ) -> Result<FloatWindowSnapshot, String> {
        validate_slot_id(slot_id)?;
        let label = float_window_label(slot_id);
        if let Some(existing) = app.get_webview_window(&label) {
            // Reopening a live slot repositions it rather than stacking a second
            // window on the same presentation slot.
            let _ = existing.set_position(LogicalPosition::new(rect.x, rect.y));
            let _ = existing.set_size(LogicalSize::new(rect.width, rect.height));
            let _ = existing.set_always_on_top(always_on_top);
            let _ = existing.show();
            self.windows.insert(slot_id.to_string(), label.clone());
            return Ok(FloatWindowSnapshot {
                slot_id: slot_id.to_string(),
                label,
            });
        }
        if self.windows.len() >= MAX_EXTENSION_UI_FLOATS {
            return Err(format!(
                "At most {MAX_EXTENSION_UI_FLOATS} detached extension floats are allowed"
            ));
        }

        // The float root reads the slot from the query string. It mounts one
        // slot and never boots the application shell.
        let url = format!(
            "index.html?surface=float&slot={}",
            urlencoding_component(slot_id)
        );
        let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
            .title(title)
            .inner_size(rect.width, rect.height)
            .position(rect.x, rect.y)
            .decorations(false)
            .resizable(true)
            .always_on_top(always_on_top)
            .skip_taskbar(false)
            .visible(true)
            .build()
            .map_err(|error| error.to_string())?;
        let _ = window.set_focus();
        self.windows.insert(slot_id.to_string(), label.clone());
        Ok(FloatWindowSnapshot {
            slot_id: slot_id.to_string(),
            label,
        })
    }

    pub fn close(&mut self, app: &AppHandle, slot_id: &str) -> Result<(), String> {
        validate_slot_id(slot_id)?;
        let label = float_window_label(slot_id);
        self.windows.remove(slot_id);
        if let Some(window) = app.get_webview_window(&label) {
            window.destroy().map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn set_bounds(
        &self,
        app: &AppHandle,
        slot_id: &str,
        rect: &FloatWindowRect,
    ) -> Result<(), String> {
        let window = self.window(app, slot_id)?;
        window
            .set_position(LogicalPosition::new(rect.x, rect.y))
            .map_err(|error| error.to_string())?;
        window
            .set_size(LogicalSize::new(rect.width, rect.height))
            .map_err(|error| error.to_string())
    }

    pub fn set_always_on_top(
        &self,
        app: &AppHandle,
        slot_id: &str,
        always_on_top: bool,
    ) -> Result<(), String> {
        self.window(app, slot_id)?
            .set_always_on_top(always_on_top)
            .map_err(|error| error.to_string())
    }

    pub fn focus(&self, app: &AppHandle, slot_id: &str) -> Result<(), String> {
        self.window(app, slot_id)?
            .set_focus()
            .map_err(|error| error.to_string())
    }

    fn window(&self, app: &AppHandle, slot_id: &str) -> Result<tauri::WebviewWindow, String> {
        validate_slot_id(slot_id)?;
        app.get_webview_window(&float_window_label(slot_id))
            .ok_or_else(|| "extension float window does not exist".to_string())
    }
}

/// Percent-encode the few characters that would break a query string. Slot ids
/// are `extensionId:family`, so this stays small rather than pulling in a crate.
fn urlencoding_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_stable_and_distinct_per_slot() {
        let widget = float_window_label("pi-subagents:widget");
        assert_eq!(widget, float_window_label("pi-subagents:widget"));
        assert_ne!(widget, float_window_label("pi-subagents:custom"));
        assert!(is_float_window_label(&widget));
    }

    #[test]
    fn labels_stay_within_the_characters_a_window_label_accepts() {
        for slot in [
            "pi-subagents:widget",
            "@scope/pkg with spaces:custom",
            "unicode-\u{4f60}\u{597d}:widget",
            "unknown:widget:fallback-key",
        ] {
            let label = float_window_label(slot);
            assert!(
                label
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
                "unexpected characters in {label}"
            );
        }
    }

    #[test]
    fn a_main_window_label_is_not_mistaken_for_a_float() {
        assert!(!is_float_window_label("main"));
        assert!(!is_float_window_label("browser-surface-1"));
    }

    #[test]
    fn rejects_slot_ids_that_could_not_come_from_the_presentation_layer() {
        assert!(validate_slot_id("pi-subagents:widget").is_ok());
        assert!(validate_slot_id("").is_err());
        assert!(validate_slot_id("with\nnewline").is_err());
        assert!(validate_slot_id(&"x".repeat(513)).is_err());
    }

    #[test]
    fn encodes_a_slot_id_so_the_query_string_survives_it() {
        assert_eq!(
            urlencoding_component("pi-subagents:widget"),
            "pi-subagents%3Awidget"
        );
        assert_eq!(urlencoding_component("a b&c=d"), "a%20b%26c%3Dd");
        assert_eq!(urlencoding_component("plain-id_1.0~x"), "plain-id_1.0~x");
    }

    #[test]
    fn converts_physical_monitor_bounds_into_the_logical_placement_space() {
        assert_eq!(logical(3024, 2.0), 1512.0);
        assert_eq!(logical_u32(1964, 2.0), 982.0);
        // A nonsensical scale factor must not divide by zero.
        assert_eq!(logical(100, 0.0), 100.0);
        assert_eq!(logical_u32(100, 0.0), 100.0);
    }
}
