use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_EXTENSION_UI_IDENTITIES: usize = 256;
pub const MAX_EXTENSION_UI_EXTENSION_ID_LENGTH: usize = 256;
pub const MAX_EXTENSION_UI_DISPLAY_NAME_LENGTH: usize = 120;
pub const MAX_EXTENSION_UI_SETTINGS_BYTES: usize = 262_144;
#[allow(dead_code)]
pub const MAX_EXTENSION_UI_FLOATS: usize = 8;
pub const MAX_EXTENSION_UI_DOCK_ORDER: u32 = 255;
pub const MIN_EXTENSION_UI_DOCK_SIZE: f64 = 0.2;
pub const MAX_EXTENSION_UI_DOCK_SIZE: f64 = 0.8;

// Detached Float placement bounds. Mirrors packages/protocol/src/limits.ts —
// both layers must reject the same values or a settings round trip can drop a
// preference the other layer accepted.
pub const MAX_EXTENSION_UI_SCREEN_COORDINATE: f64 = 262_144.0;
pub const MIN_EXTENSION_UI_DETACHED_SIZE: f64 = 120.0;
pub const MAX_EXTENSION_UI_DETACHED_SIZE: f64 = 65_536.0;
pub const MIN_EXTENSION_UI_SCALE_FACTOR: f64 = 0.1;
pub const MAX_EXTENSION_UI_SCALE_FACTOR: f64 = 16.0;
pub const MAX_EXTENSION_UI_MONITOR_NAME_LENGTH: usize = 256;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedFloatRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Logical-pixel rectangle in the platform's global desktop coordinate space.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSize {
    pub width: f64,
    pub height: f64,
}

/// Enough monitor identity to decide on a later launch whether a stored
/// detached placement still refers to a display that is present.
///
/// `position`/`size` are the display's full bounds and carry identity — they do
/// not move when a Dock or taskbar is hidden. `work_area` is the region a window
/// may actually occupy and is what placement clamps against.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorDescriptor {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub position: MonitorPosition,
    pub size: MonitorSize,
    pub scale_factor: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_area: Option<ScreenRect>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedFloatPlacement {
    pub monitor: MonitorDescriptor,
    pub rect: ScreenRect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PresentationHome {
    FollowExtension,
    FollowHost,
    Anchor {
        slot: String,
    },
    Dock {
        group: String,
        order: u32,
    },
    Float {
        rect: NormalizedFloatRect,
        #[serde(skip_serializing_if = "Option::is_none")]
        pinned: Option<bool>,
        /// Present only while the Float lives in its own window.
        #[serde(skip_serializing_if = "Option::is_none")]
        detached: Option<DetachedFloatPlacement>,
    },
    Inline,
    Modal,
    Hidden,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PresentationPreference {
    pub home: PresentationHome,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionPresentationProfile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub widget: Option<PresentationPreference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<PresentationPreference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom: Option<PresentationPreference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocking_dialog: Option<PresentationPreference>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionDockSettings {
    pub direction: String,
    pub secondary_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sizes: Option<[f64; 2]>,
}

impl Default for ExtensionDockSettings {
    fn default() -> Self {
        Self {
            direction: "row".into(),
            secondary_enabled: false,
            sizes: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedCapability {
    pub families: Vec<String>,
    pub last_seen_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionUiSettings {
    pub version: u32,
    pub presentations: BTreeMap<String, ExtensionPresentationProfile>,
    pub dock: ExtensionDockSettings,
    pub observed_capabilities: BTreeMap<String, ObservedCapability>,
}

impl Default for ExtensionUiSettings {
    fn default() -> Self {
        Self {
            version: 1,
            presentations: BTreeMap::new(),
            dock: ExtensionDockSettings::default(),
            observed_capabilities: BTreeMap::new(),
        }
    }
}

pub fn deserialize_extension_ui_settings<'de, D>(
    deserializer: D,
) -> Result<ExtensionUiSettings, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(sanitize_extension_ui_settings(value))
}

fn is_extension_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_EXTENSION_UI_EXTENSION_ID_LENGTH
}

fn is_family(value: &str) -> bool {
    matches!(value, "widget" | "status" | "custom" | "blockingDialog")
}

fn is_finite_number(value: &serde_json::Value) -> Option<f64> {
    value.as_f64().filter(|number| number.is_finite())
}

fn is_safe_u64(value: &serde_json::Value) -> Option<u64> {
    match value {
        serde_json::Value::Number(number) => number.as_u64().or_else(|| {
            number.as_i64().and_then(|signed| {
                if signed >= 0 {
                    Some(signed as u64)
                } else {
                    None
                }
            })
        }),
        _ => None,
    }
}

fn has_exact_keys(
    object: &serde_json::Map<String, serde_json::Value>,
    required: &[&str],
    optional: &[&str],
) -> bool {
    required.iter().all(|key| object.contains_key(*key))
        && object
            .keys()
            .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
}

fn screen_coordinate(value: &serde_json::Value) -> Option<f64> {
    is_finite_number(value).filter(|number| number.abs() <= MAX_EXTENSION_UI_SCREEN_COORDINATE)
}

fn detached_extent(value: &serde_json::Value) -> Option<f64> {
    is_finite_number(value).filter(|number| {
        (MIN_EXTENSION_UI_DETACHED_SIZE..=MAX_EXTENSION_UI_DETACHED_SIZE).contains(number)
    })
}

fn sanitize_screen_rect(value: &serde_json::Value) -> Option<ScreenRect> {
    let object = value.as_object()?;
    if !has_exact_keys(object, &["x", "y", "width", "height"], &[]) {
        return None;
    }
    Some(ScreenRect {
        x: screen_coordinate(object.get("x")?)?,
        y: screen_coordinate(object.get("y")?)?,
        width: detached_extent(object.get("width")?)?,
        height: detached_extent(object.get("height")?)?,
    })
}

fn sanitize_monitor_descriptor(value: &serde_json::Value) -> Option<MonitorDescriptor> {
    let object = value.as_object()?;
    if !has_exact_keys(
        object,
        &["position", "size", "scaleFactor"],
        &["name", "workArea"],
    ) {
        return None;
    }
    let name = match object.get("name") {
        None => None,
        Some(value) => {
            let name = value.as_str()?;
            if name.is_empty() || name.len() > MAX_EXTENSION_UI_MONITOR_NAME_LENGTH {
                return None;
            }
            Some(name.to_string())
        }
    };
    let position = object.get("position")?.as_object()?;
    if !has_exact_keys(position, &["x", "y"], &[]) {
        return None;
    }
    let size = object.get("size")?.as_object()?;
    if !has_exact_keys(size, &["width", "height"], &[]) {
        return None;
    }
    let scale_factor = is_finite_number(object.get("scaleFactor")?).filter(|number| {
        (MIN_EXTENSION_UI_SCALE_FACTOR..=MAX_EXTENSION_UI_SCALE_FACTOR).contains(number)
    })?;
    let work_area = match object.get("workArea") {
        None => None,
        Some(value) => Some(sanitize_screen_rect(value)?),
    };
    Some(MonitorDescriptor {
        name,
        position: MonitorPosition {
            x: screen_coordinate(position.get("x")?)?,
            y: screen_coordinate(position.get("y")?)?,
        },
        size: MonitorSize {
            width: detached_extent(size.get("width")?)?,
            height: detached_extent(size.get("height")?)?,
        },
        scale_factor,
        work_area,
    })
}

fn sanitize_detached_placement(value: &serde_json::Value) -> Option<DetachedFloatPlacement> {
    let object = value.as_object()?;
    if !has_exact_keys(object, &["monitor", "rect"], &[]) {
        return None;
    }
    Some(DetachedFloatPlacement {
        monitor: sanitize_monitor_descriptor(object.get("monitor")?)?,
        rect: sanitize_screen_rect(object.get("rect")?)?,
    })
}

fn legal_home(family: &str, home: &serde_json::Value) -> Option<PresentationHome> {
    let object = home.as_object()?;
    let kind = object.get("kind")?.as_str()?;
    match (family, kind) {
        ("widget" | "custom", "followExtension") if has_exact_keys(object, &["kind"], &[]) => {
            Some(PresentationHome::FollowExtension)
        }
        ("blockingDialog", "followHost") if has_exact_keys(object, &["kind"], &[]) => {
            Some(PresentationHome::FollowHost)
        }
        ("widget" | "status", "anchor") => {
            if !has_exact_keys(object, &["kind", "slot"], &[]) {
                return None;
            }
            let slot = home.get("slot")?.as_str()?;
            if family == "status" && slot != "aboveComposer" {
                return None;
            }
            if slot != "aboveComposer" && slot != "belowComposer" {
                return None;
            }
            Some(PresentationHome::Anchor {
                slot: slot.to_string(),
            })
        }
        ("widget" | "status" | "custom", "dock") => {
            if !has_exact_keys(object, &["kind", "group", "order"], &[]) {
                return None;
            }
            let group = home.get("group")?.as_str()?;
            if group != "primary" && group != "secondary" {
                return None;
            }
            let order = is_safe_u64(home.get("order")?)?;
            if order > u64::from(MAX_EXTENSION_UI_DOCK_ORDER) {
                return None;
            }
            Some(PresentationHome::Dock {
                group: group.to_string(),
                order: order as u32,
            })
        }
        ("widget" | "custom", "float") => {
            if !has_exact_keys(object, &["kind", "rect"], &["pinned", "detached"]) {
                return None;
            }
            let rect = home.get("rect")?;
            let rect_keys: Vec<&str> = rect.as_object()?.keys().map(String::as_str).collect();
            if rect_keys.len() != 4
                || !["x", "y", "width", "height"]
                    .iter()
                    .all(|key| rect_keys.contains(key))
            {
                return None;
            }
            let x = is_finite_number(rect.get("x")?)?;
            let y = is_finite_number(rect.get("y")?)?;
            let width = is_finite_number(rect.get("width")?)?;
            let height = is_finite_number(rect.get("height")?)?;
            if !(0.0..=1.0).contains(&x)
                || !(0.0..=1.0).contains(&y)
                || width <= 0.0
                || height <= 0.0
            {
                return None;
            }
            let pinned = match home.get("pinned") {
                None => None,
                Some(value) => Some(value.as_bool()?),
            };
            let detached = match home.get("detached") {
                None => None,
                Some(value) => Some(sanitize_detached_placement(value)?),
            };
            Some(PresentationHome::Float {
                rect: NormalizedFloatRect {
                    x,
                    y,
                    width,
                    height,
                },
                pinned,
                detached,
            })
        }
        ("widget" | "status", "hidden") if has_exact_keys(object, &["kind"], &[]) => {
            Some(PresentationHome::Hidden)
        }
        ("blockingDialog", "inline") if has_exact_keys(object, &["kind"], &[]) => {
            Some(PresentationHome::Inline)
        }
        ("blockingDialog", "modal") if has_exact_keys(object, &["kind"], &[]) => {
            Some(PresentationHome::Modal)
        }
        _ => None,
    }
}

fn sanitize_profile(value: &serde_json::Value) -> Option<ExtensionPresentationProfile> {
    let object = value.as_object()?;
    let mut profile = ExtensionPresentationProfile::default();
    for family in ["widget", "status", "custom", "blockingDialog"] {
        let Some(entry) = object.get(family) else {
            continue;
        };
        let Some(home) = entry.get("home").and_then(|home| legal_home(family, home)) else {
            continue;
        };
        let preference = Some(PresentationPreference { home });
        match family {
            "widget" => profile.widget = preference,
            "status" => profile.status = preference,
            "custom" => profile.custom = preference,
            "blockingDialog" => profile.blocking_dialog = preference,
            _ => {}
        }
    }
    if profile.widget.is_none()
        && profile.status.is_none()
        && profile.custom.is_none()
        && profile.blocking_dialog.is_none()
    {
        None
    } else {
        Some(profile)
    }
}

fn sanitize_observed(value: &serde_json::Value) -> Option<ObservedCapability> {
    let families = value
        .get("families")?
        .as_array()?
        .iter()
        .filter_map(|family| family.as_str().map(str::to_string))
        .filter(|family| is_family(family))
        .fold(Vec::new(), |mut unique, family| {
            if !unique.contains(&family) {
                unique.push(family);
            }
            unique
        });
    let last_seen_at = is_safe_u64(value.get("lastSeenAt")?)?;
    if families.is_empty() {
        return None;
    }
    let display_name = value.get("displayName").and_then(|name| {
        let trimmed = name.as_str()?.trim();
        if trimmed.is_empty() || trimmed.chars().count() > MAX_EXTENSION_UI_DISPLAY_NAME_LENGTH {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    Some(ObservedCapability {
        families,
        last_seen_at,
        display_name,
    })
}

fn sanitize_dock(value: Option<&serde_json::Value>) -> ExtensionDockSettings {
    let Some(object) = value.and_then(|value| value.as_object()) else {
        return ExtensionDockSettings::default();
    };
    let direction = match object.get("direction").and_then(|value| value.as_str()) {
        Some("column") => "column",
        _ => "row",
    }
    .to_string();
    let secondary_enabled = object
        .get("secondaryEnabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let sizes = object.get("sizes").and_then(|value| {
        let pair = value.as_array()?;
        if pair.len() != 2 {
            return None;
        }
        let first = is_finite_number(pair.first()?)?;
        let second = is_finite_number(pair.get(1)?)?;
        if (MIN_EXTENSION_UI_DOCK_SIZE..=MAX_EXTENSION_UI_DOCK_SIZE).contains(&first)
            && (MIN_EXTENSION_UI_DOCK_SIZE..=MAX_EXTENSION_UI_DOCK_SIZE).contains(&second)
            && (first + second - 1.0).abs() < 1e-9
        {
            return Some([first, second]);
        }
        let total = first + second;
        if total <= 0.0 {
            return None;
        }
        let mut normalized = first / total;
        normalized = normalized.clamp(MIN_EXTENSION_UI_DOCK_SIZE, MAX_EXTENSION_UI_DOCK_SIZE);
        let complement = 1.0 - normalized;
        if !(MIN_EXTENSION_UI_DOCK_SIZE..=MAX_EXTENSION_UI_DOCK_SIZE).contains(&complement) {
            return None;
        }
        Some([normalized, complement])
    });
    ExtensionDockSettings {
        direction,
        secondary_enabled,
        sizes,
    }
}

pub fn sanitize_extension_ui_settings(value: serde_json::Value) -> ExtensionUiSettings {
    let Some(object) = value.as_object() else {
        return ExtensionUiSettings::default();
    };
    if object.get("version").and_then(|value| value.as_u64()) != Some(1) {
        return ExtensionUiSettings::default();
    }

    let mut presentations = BTreeMap::new();
    if let Some(map) = object
        .get("presentations")
        .and_then(|value| value.as_object())
    {
        for (id, profile) in map {
            if !is_extension_id(id) {
                continue;
            }
            if let Some(sanitized) = sanitize_profile(profile) {
                presentations.insert(id.clone(), sanitized);
            }
        }
    }

    let mut observed_capabilities = BTreeMap::new();
    if let Some(map) = object
        .get("observedCapabilities")
        .and_then(|value| value.as_object())
    {
        for (id, entry) in map {
            if !is_extension_id(id) {
                continue;
            }
            if let Some(sanitized) = sanitize_observed(entry) {
                observed_capabilities.insert(id.clone(), sanitized);
            }
        }
    }

    let mut identities: Vec<String> = presentations
        .keys()
        .chain(observed_capabilities.keys())
        .cloned()
        .collect();
    identities.sort();
    identities.dedup();
    identities.sort_by(|left, right| {
        let left_seen = observed_capabilities
            .get(left)
            .map(|entry| entry.last_seen_at)
            .unwrap_or(0);
        let right_seen = observed_capabilities
            .get(right)
            .map(|entry| entry.last_seen_at)
            .unwrap_or(0);
        right_seen.cmp(&left_seen).then_with(|| left.cmp(right))
    });
    identities.truncate(MAX_EXTENSION_UI_IDENTITIES);
    presentations.retain(|id, _| identities.contains(id));
    observed_capabilities.retain(|id, _| identities.contains(id));

    let settings = ExtensionUiSettings {
        version: 1,
        presentations,
        dock: sanitize_dock(object.get("dock")),
        observed_capabilities,
    };
    match serde_json::to_vec(&settings) {
        Ok(bytes) if bytes.len() <= MAX_EXTENSION_UI_SETTINGS_BYTES => settings,
        _ => ExtensionUiSettings {
            version: 1,
            presentations: BTreeMap::new(),
            dock: settings.dock,
            observed_capabilities: BTreeMap::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_version_resets_only_nested_defaults() {
        let repaired = sanitize_extension_ui_settings(serde_json::json!({
            "version": 2,
            "presentations": { "ext_a": { "widget": { "home": { "kind": "hidden" } } } }
        }));
        assert_eq!(repaired, ExtensionUiSettings::default());
    }

    #[test]
    fn drops_illegal_family_entries_and_unknown_capabilities() {
        let repaired = sanitize_extension_ui_settings(serde_json::json!({
            "version": 1,
            "presentations": {
                "ext_a": {
                    "widget": { "home": { "kind": "float", "rect": { "x": 0.2, "y": 0.1, "width": 320.0, "height": 180.0 } } },
                    "status": { "home": { "kind": "float", "rect": { "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0 } } }
                },
                "": { "widget": { "home": { "kind": "hidden" } } }
            },
            "dock": { "direction": "column", "secondaryEnabled": true, "sizes": [0.7, 0.3] },
            "observedCapabilities": {
                "ext_a": { "families": ["widget", "widget", "status"], "lastSeenAt": 10, "displayName": "  Review  " },
                "ext_unknown": { "families": ["notify"], "lastSeenAt": 1 }
            }
        }));
        assert!(repaired.presentations["ext_a"].widget.is_some());
        assert!(repaired.presentations["ext_a"].status.is_none());
        assert!(!repaired.presentations.contains_key(""));
        assert_eq!(
            repaired.observed_capabilities["ext_a"].families,
            vec!["widget", "status"]
        );
        assert_eq!(
            repaired.observed_capabilities["ext_a"]
                .display_name
                .as_deref(),
            Some("Review")
        );
        assert!(!repaired.observed_capabilities.contains_key("ext_unknown"));
        assert_eq!(repaired.dock.direction, "column");
        assert_eq!(repaired.dock.sizes, Some([0.7, 0.3]));
    }

    fn monitor_json() -> serde_json::Value {
        serde_json::json!({
            "name": "DELL U2419H",
            "position": { "x": 1512.0, "y": 0.0 },
            "size": { "width": 1920.0, "height": 1080.0 },
            "scaleFactor": 1.0
        })
    }

    fn float_home_with(detached: Option<serde_json::Value>) -> serde_json::Value {
        let mut home = serde_json::json!({
            "kind": "float",
            "rect": { "x": 0.2, "y": 0.1, "width": 320.0, "height": 180.0 }
        });
        if let Some(detached) = detached {
            home["detached"] = detached;
        }
        home
    }

    fn sanitize_widget_home(home: serde_json::Value) -> Option<PresentationHome> {
        sanitize_extension_ui_settings(serde_json::json!({
            "version": 1,
            "presentations": { "ext_a": { "widget": { "home": home } } },
            "dock": { "direction": "row", "secondaryEnabled": false },
            "observedCapabilities": {}
        }))
        .presentations
        .get("ext_a")
        .and_then(|profile| profile.widget.as_ref())
        .map(|preference| preference.home.clone())
    }

    #[test]
    fn a_v1_float_without_detached_placement_still_loads() {
        let home = sanitize_widget_home(float_home_with(None)).expect("float home survives");
        assert!(matches!(
            home,
            PresentationHome::Float {
                detached: None,
                pinned: None,
                ..
            }
        ));
    }

    #[test]
    fn round_trips_a_well_formed_detached_placement() {
        let detached = serde_json::json!({
            "monitor": monitor_json(),
            "rect": { "x": 1600.0, "y": 120.0, "width": 400.0, "height": 300.0 }
        });
        let home =
            sanitize_widget_home(float_home_with(Some(detached))).expect("placement survives");
        let PresentationHome::Float { detached, .. } = home else {
            panic!("expected a float home");
        };
        let placement = detached.expect("placement retained");
        assert_eq!(placement.monitor.name.as_deref(), Some("DELL U2419H"));
        assert_eq!(placement.monitor.scale_factor, 1.0);
        assert_eq!(placement.rect.x, 1600.0);
        assert_eq!(placement.rect.width, 400.0);
    }

    #[test]
    fn accepts_a_monitor_that_reports_no_name() {
        let mut monitor = monitor_json();
        monitor.as_object_mut().unwrap().remove("name");
        let detached = serde_json::json!({
            "monitor": monitor,
            "rect": { "x": 1600.0, "y": 120.0, "width": 400.0, "height": 300.0 }
        });
        let home =
            sanitize_widget_home(float_home_with(Some(detached))).expect("placement survives");
        let PresentationHome::Float { detached, .. } = home else {
            panic!("expected a float home");
        };
        assert!(detached.expect("placement retained").monitor.name.is_none());
    }

    #[test]
    fn rejects_corrupt_detached_placements_without_touching_other_families() {
        let good_rect =
            serde_json::json!({ "x": 1600.0, "y": 120.0, "width": 400.0, "height": 300.0 });
        let cases = vec![
            serde_json::json!({ "rect": good_rect }),
            serde_json::json!({ "monitor": monitor_json() }),
            serde_json::json!({ "monitor": monitor_json(), "rect": good_rect, "zIndex": 3 }),
            serde_json::json!({ "monitor": monitor_json(), "rect": { "x": 1e9, "y": 0.0, "width": 400.0, "height": 300.0 } }),
            serde_json::json!({ "monitor": monitor_json(), "rect": { "x": 0.0, "y": 0.0, "width": 4.0, "height": 300.0 } }),
            serde_json::json!({ "monitor": { "position": { "x": 0.0, "y": 0.0 }, "size": { "width": 1920.0, "height": 1080.0 }, "scaleFactor": 0.0 }, "rect": good_rect }),
            serde_json::json!({ "monitor": { "name": "", "position": { "x": 0.0, "y": 0.0 }, "size": { "width": 1920.0, "height": 1080.0 }, "scaleFactor": 1.0 }, "rect": good_rect }),
        ];
        for detached in cases {
            let repaired = sanitize_extension_ui_settings(serde_json::json!({
                "version": 1,
                "presentations": {
                    "ext_a": {
                        "widget": { "home": float_home_with(Some(detached.clone())) },
                        "status": { "home": { "kind": "dock", "group": "primary", "order": 1 } }
                    }
                },
                "dock": { "direction": "row", "secondaryEnabled": false },
                "observedCapabilities": {}
            }));
            let profile = &repaired.presentations["ext_a"];
            assert!(
                profile.widget.is_none(),
                "expected the corrupt placement to be dropped: {detached}"
            );
            assert!(
                profile.status.is_some(),
                "an unrelated family must survive: {detached}"
            );
        }
    }

    #[test]
    fn a_detached_placement_cannot_reach_a_family_that_cannot_float() {
        let detached = serde_json::json!({
            "monitor": monitor_json(),
            "rect": { "x": 1600.0, "y": 120.0, "width": 400.0, "height": 300.0 }
        });
        let repaired = sanitize_extension_ui_settings(serde_json::json!({
            "version": 1,
            "presentations": {
                "ext_a": { "status": { "home": float_home_with(Some(detached)) } }
            },
            "dock": { "direction": "row", "secondaryEnabled": false },
            "observedCapabilities": {}
        }));
        assert!(!repaired.presentations.contains_key("ext_a"));
    }
}
