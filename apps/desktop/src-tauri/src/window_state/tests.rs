use super::*;

fn monitor(name: &str, x: i32, y: i32, width: u32, height: u32, scale: f64) -> MonitorInfo {
    MonitorInfo {
        name: Some(name.into()),
        work_area: Bounds {
            x,
            y,
            width,
            height,
        },
        scale_factor: scale,
    }
}

fn state() -> SavedWindowState {
    SavedWindowState {
        schema_version: SCHEMA_VERSION,
        normal_bounds: Bounds {
            x: 120,
            y: 90,
            width: 1280,
            height: 800,
        },
        monitor: monitor("main", 0, 0, 1920, 1040, 1.0),
        maximized: false,
    }
}

fn constraints() -> Constraints {
    Constraints {
        minimum: LogicalSize::new(960.0, 600.0),
        frame: LogicalSize::new(0.0, 0.0),
    }
}

fn store() -> Store {
    Store {
        path: None,
        current: Some(state()),
        persisted: None,
        constraints: constraints(),
        revision: 0,
        save_pending: false,
    }
}

#[test]
fn restores_normal_geometry_exactly_on_the_same_monitor() {
    let saved = state();
    assert_eq!(saved.fit_to(&saved.monitor, constraints()), saved);
}

#[test]
fn retains_normal_bounds_and_maximization_through_minimize_or_fullscreen() {
    let mut store = store();
    let normal = state();
    store.observe(Observation::Maximized(normal.monitor.clone()));
    store.observe(Observation::Transient);
    let current = store.current.as_ref().unwrap();
    assert!(current.maximized);
    assert_eq!(current.normal_bounds, normal.normal_bounds);
    store.observe(Observation::Normal(normal.clone()));
    assert_eq!(store.current, Some(normal));
}

#[test]
fn normal_moves_are_recorded_and_zero_sized_observations_are_ignored() {
    let mut store = store();
    let mut moved = state();
    moved.normal_bounds.x = 250;
    moved.normal_bounds.width = 1100;
    assert!(store.observe(Observation::Normal(moved.clone())));
    let mut invalid = moved.clone();
    invalid.normal_bounds.height = 0;
    assert!(!store.observe(Observation::Normal(invalid)));
    assert_eq!(store.current, Some(moved));
}

#[test]
fn rebases_physical_coordinates_when_monitor_dpi_and_origin_change() {
    let mut saved = state();
    saved.monitor = monitor("external", -1920, 0, 1920, 1040, 1.0);
    saved.normal_bounds.x = -1800;
    let destination = monitor("external", 1920, -120, 2880, 1560, 1.5);
    let restored = saved.fit_to(&destination, constraints());
    assert_eq!(
        restored.normal_bounds,
        Bounds {
            x: 2100,
            y: 15,
            width: 1920,
            height: 1200
        }
    );
}

#[test]
fn clamps_offscreen_bounds_to_work_area_even_below_the_configured_minimum() {
    let mut saved = state();
    saved.normal_bounds.x = i32::MAX;
    saved.normal_bounds.y = i32::MIN;
    saved.normal_bounds.width = u32::MAX;
    let small = monitor("small", -800, 35, 800, 565, 2.0);
    let restored = saved.fit_to(&small, constraints());
    assert_eq!(
        restored.normal_bounds,
        Bounds {
            x: -800,
            y: 35,
            width: 800,
            height: 565
        }
    );
}

#[test]
fn leaves_room_for_the_native_frame_and_taskbar() {
    let mut saved = state();
    saved.normal_bounds = Bounds {
        x: 1700,
        y: 1000,
        width: 1280,
        height: 800,
    };
    let constraints = Constraints {
        frame: LogicalSize::new(2.0, 2.0),
        ..constraints()
    };
    let restored = saved.fit_to(&saved.monitor, constraints);
    assert_eq!(
        restored.normal_bounds,
        Bounds {
            x: 638,
            y: 238,
            width: 1280,
            height: 800
        }
    );
}

#[test]
fn prefers_matching_display_then_intersection_then_primary() {
    let saved = state();
    let displays = vec![
        monitor("primary", -1920, 0, 1920, 1040, 1.0),
        monitor("main", 1920, 0, 1920, 1040, 1.0),
    ];
    assert_eq!(
        saved.target_monitor(&displays, Some(&displays[0])),
        Some(&displays[1])
    );
    let mut disconnected = saved;
    disconnected.monitor.name = Some("unplugged".into());
    assert_eq!(
        disconnected.target_monitor(&displays, Some(&displays[0])),
        Some(&displays[0])
    );
    disconnected.normal_bounds.x = 2000;
    assert_eq!(
        disconnected.target_monitor(&displays, Some(&displays[0])),
        Some(&displays[1])
    );
    assert!(disconnected.target_monitor(&[], None).is_none());
}

#[test]
fn moving_a_maximized_window_to_another_display_keeps_a_normal_restore_size() {
    let mut store = store();
    let destination = monitor("external", -2880, 0, 2880, 1560, 1.5);
    store.observe(Observation::Maximized(destination.clone()));
    let current = store.current.unwrap();
    assert!(current.maximized);
    assert_eq!(current.monitor, destination);
    assert_eq!(
        current.normal_bounds,
        Bounds {
            x: -2700,
            y: 135,
            width: 1920,
            height: 1200
        }
    );
}

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("pideck-window-state-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn persists_and_replaces_state_in_the_selected_profile() {
    let directory = TempDir::new();
    let path = directory.0.join(FILE_NAME);
    assert_eq!(read_state(&path).unwrap(), None);
    let mut expected = state();
    write_state(&path, &expected).unwrap();
    assert_eq!(read_state(&path).unwrap(), Some(expected.clone()));
    expected.maximized = true;
    write_state(&path, &expected).unwrap();
    assert_eq!(read_state(&path).unwrap(), Some(expected));
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
}

#[test]
fn rejects_corrupt_zero_sized_and_unknown_version_files() {
    let directory = TempDir::new();
    let path = directory.0.join(FILE_NAME);
    fs::write(&path, b"{truncated").unwrap();
    assert!(read_state(&path).is_err());
    let mut invalid = state();
    invalid.normal_bounds.width = 0;
    write_state(&path, &invalid).unwrap();
    assert!(read_state(&path).is_err());
    invalid = state();
    invalid.schema_version = SCHEMA_VERSION + 1;
    write_state(&path, &invalid).unwrap();
    assert!(read_state(&path).is_err());
    invalid = state();
    invalid.monitor.scale_factor = 0.0;
    write_state(&path, &invalid).unwrap();
    assert!(read_state(&path).is_err());
}
