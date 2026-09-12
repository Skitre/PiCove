use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{LogicalSize, Manager, PhysicalPosition, PhysicalSize, Window, WindowEvent};

const FILE_NAME: &str = "window-state.json";
const SCHEMA_VERSION: u32 = 1;
const SAVE_DELAY: Duration = Duration::from_millis(350);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl Bounds {
    fn valid(self) -> bool {
        self.width > 0 && self.height > 0
    }

    fn intersection_area(self, other: Self) -> i64 {
        let width = (i64::from(self.x) + i64::from(self.width))
            .min(i64::from(other.x) + i64::from(other.width))
            - i64::from(self.x.max(other.x));
        let height = (i64::from(self.y) + i64::from(self.height))
            .min(i64::from(other.y) + i64::from(other.height))
            - i64::from(self.y.max(other.y));
        width.max(0).saturating_mul(height.max(0))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MonitorInfo {
    name: Option<String>,
    work_area: Bounds,
    scale_factor: f64,
}

impl MonitorInfo {
    fn valid(&self) -> bool {
        self.work_area.valid() && (0.1..=16.0).contains(&self.scale_factor)
    }
}

impl From<tauri::Monitor> for MonitorInfo {
    fn from(monitor: tauri::Monitor) -> Self {
        let area = monitor.work_area();
        Self {
            name: monitor.name().cloned(),
            work_area: Bounds {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
            },
            scale_factor: monitor.scale_factor(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedWindowState {
    schema_version: u32,
    // Tauri positions include the native frame; sizes refer to the client area.
    normal_bounds: Bounds,
    monitor: MonitorInfo,
    maximized: bool,
}

#[derive(Clone, Copy)]
struct Constraints {
    minimum: LogicalSize<f64>,
    frame: LogicalSize<f64>,
}

impl SavedWindowState {
    fn valid(&self) -> bool {
        self.schema_version == SCHEMA_VERSION && self.normal_bounds.valid() && self.monitor.valid()
    }

    fn target_monitor<'a>(
        &self,
        monitors: &'a [MonitorInfo],
        primary: Option<&MonitorInfo>,
    ) -> Option<&'a MonitorInfo> {
        monitors
            .iter()
            .filter(|monitor| self.monitor.name.is_some() && monitor.name == self.monitor.name)
            .max_by_key(|monitor| self.monitor.work_area.intersection_area(monitor.work_area))
            .or_else(|| {
                monitors
                    .iter()
                    .filter(|monitor| self.normal_bounds.intersection_area(monitor.work_area) > 0)
                    .max_by_key(|monitor| self.normal_bounds.intersection_area(monitor.work_area))
            })
            .or_else(|| monitors.iter().find(|monitor| Some(*monitor) == primary))
            .or_else(|| monitors.first())
    }

    fn fit_to(&self, monitor: &MonitorInfo, constraints: Constraints) -> Self {
        let area = monitor.work_area;
        let ratio = monitor.scale_factor / self.monitor.scale_factor;
        let frame: PhysicalSize<u32> = constraints.frame.to_physical(monitor.scale_factor);
        let available_width = area.width.saturating_sub(frame.width).max(1);
        let available_height = area.height.saturating_sub(frame.height).max(1);
        let minimum: PhysicalSize<u32> = constraints.minimum.to_physical(monitor.scale_factor);
        let width = ((f64::from(self.normal_bounds.width) * ratio).round() as u32)
            .clamp(minimum.width.max(1).min(available_width), available_width);
        let height = ((f64::from(self.normal_bounds.height) * ratio).round() as u32).clamp(
            minimum.height.max(1).min(available_height),
            available_height,
        );
        // Rebase relative to the monitor's work area, not a globally scaled desktop
        // origin: monitors can have different DPI and negative physical positions.
        let x = f64::from(area.x)
            + (f64::from(self.normal_bounds.x) - f64::from(self.monitor.work_area.x)) * ratio;
        let y = f64::from(area.y)
            + (f64::from(self.normal_bounds.y) - f64::from(self.monitor.work_area.y)) * ratio;
        Self {
            normal_bounds: Bounds {
                x: x.round().clamp(
                    f64::from(area.x),
                    f64::from(area.x) + f64::from(available_width - width),
                ) as i32,
                y: y.round().clamp(
                    f64::from(area.y),
                    f64::from(area.y) + f64::from(available_height - height),
                ) as i32,
                width,
                height,
            },
            monitor: monitor.clone(),
            ..self.clone()
        }
    }
}

enum Observation {
    Normal(SavedWindowState),
    Maximized(MonitorInfo),
    Transient,
}

struct Store {
    path: Option<PathBuf>,
    current: Option<SavedWindowState>,
    persisted: Option<SavedWindowState>,
    constraints: Constraints,
    revision: u64,
    save_pending: bool,
}

impl Store {
    fn observe(&mut self, observation: Observation) -> bool {
        let next = match observation {
            Observation::Normal(state) if state.valid() => Some(state),
            Observation::Maximized(monitor) => self.current.as_ref().map(|current| {
                let mut state = if monitor != current.monitor {
                    current.fit_to(&monitor, self.constraints)
                } else {
                    current.clone()
                };
                state.maximized = true;
                state
            }),
            _ => return false,
        };
        if next == self.current {
            return false;
        }
        self.current = next;
        self.revision = self.revision.wrapping_add(1);
        true
    }

    fn save(&mut self) {
        if self.current == self.persisted {
            return;
        }
        if let (Some(path), Some(state)) = (&self.path, &self.current) {
            match write_state(path, state) {
                Ok(()) => self.persisted = self.current.clone(),
                Err(error) => eprintln!("[pideck] could not save window state: {error}"),
            }
        }
    }
}

struct MainWindowState(Arc<Mutex<Store>>);

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = match std::env::var_os("PIDECK_CONFIG_DIR") {
        Some(value) => {
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err("PIDECK_CONFIG_DIR must be an absolute path".into());
            }
            path
        }
        None => app
            .path()
            .app_config_dir()
            .map_err(|error| error.to_string())?,
    };
    Ok(directory.join(FILE_NAME))
}

fn read_state(path: &Path) -> Result<Option<SavedWindowState>, String> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let state: SavedWindowState =
        serde_json::from_slice(&raw).map_err(|error| error.to_string())?;
    if !state.valid() {
        return Err("invalid or unsupported window state".into());
    }
    Ok(Some(state))
}

fn write_state(path: &Path, state: &SavedWindowState) -> Result<(), String> {
    let parent = path.parent().ok_or("window state path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!(".{FILE_NAME}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = File::create(&temp).map_err(|error| error.to_string())?;
        let raw = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
        file.write_all(&raw).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        crate::desktop_settings::replace_file(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn observation(window: &Window) -> tauri::Result<Observation> {
    // Neither minimized desktop coordinates nor fullscreen bounds are a normal
    // restore rectangle. Keep the last normal/maximized state through both.
    if window.is_minimized()? || window.is_fullscreen()? {
        return Ok(Observation::Transient);
    }
    let Some(monitor) = window
        .current_monitor()?
        .map(MonitorInfo::from)
        .filter(MonitorInfo::valid)
    else {
        return Ok(Observation::Transient);
    };
    if is_maximized(window)? {
        return Ok(Observation::Maximized(monitor));
    }
    let position = window.outer_position()?;
    let size = window.inner_size()?;
    Ok(Observation::Normal(SavedWindowState {
        schema_version: SCHEMA_VERSION,
        normal_bounds: Bounds {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
        monitor,
        maximized: false,
    }))
}

#[cfg(windows)]
fn is_maximized(window: &Window) -> tauri::Result<bool> {
    // WM_WINDOWPOSCHANGED precedes WM_SIZE, which updates Tao's cached maximized
    // flag. Read the OS flag so a move event cannot replace the normal bounds
    // with the maximized rectangle during that interval.
    Ok(unsafe { windows_sys::Win32::UI::WindowsAndMessaging::IsZoomed(window.hwnd()?.0) != 0 })
}

#[cfg(not(windows))]
fn is_maximized(window: &Window) -> tauri::Result<bool> {
    window.is_maximized()
}

pub fn restore_and_track(app: &tauri::AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_window("main") else {
        return Ok(());
    };
    let path = state_path(app)
        .map_err(|error| eprintln!("[pideck] could not locate window state: {error}"))
        .ok();
    let saved = path.as_deref().and_then(|path| match read_state(path) {
        Ok(state) => state,
        Err(error) => {
            eprintln!("[pideck] ignoring saved window state: {error}");
            None
        }
    });
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main");
    let scale = window.scale_factor().unwrap_or(1.0);
    let frame = window
        .outer_size()
        .ok()
        .zip(window.inner_size().ok())
        .map_or(LogicalSize::new(0.0, 0.0), |(outer, inner)| {
            PhysicalSize::new(
                outer.width.saturating_sub(inner.width),
                outer.height.saturating_sub(inner.height),
            )
            .to_logical(scale)
        });
    let constraints = Constraints {
        minimum: LogicalSize::new(
            config.and_then(|config| config.min_width).unwrap_or(1.0),
            config.and_then(|config| config.min_height).unwrap_or(1.0),
        ),
        frame,
    };
    let mut store = Store {
        path,
        current: saved.clone(),
        persisted: saved,
        constraints,
        revision: 0,
        save_pending: false,
    };
    if store.current.is_none() {
        if let Ok(initial) = observation(&window) {
            store.observe(initial);
        }
    }
    if let Some(current) = &store.current {
        let monitors: Vec<_> = window
            .available_monitors()
            .unwrap_or_default()
            .into_iter()
            .map(MonitorInfo::from)
            .filter(MonitorInfo::valid)
            .collect();
        let primary = window
            .primary_monitor()
            .ok()
            .flatten()
            .map(MonitorInfo::from);
        if let Some(monitor) = current.target_monitor(&monitors, primary.as_ref()) {
            let restored = current.fit_to(monitor, constraints);
            let bounds = restored.normal_bounds;
            let result = (|| -> tauri::Result<()> {
                // The configured minimum can exceed a small screen after a DPI
                // change. Cap it before setting the restored size.
                window.set_min_size(Some(LogicalSize::new(
                    constraints
                        .minimum
                        .width
                        .min(f64::from(bounds.width) / monitor.scale_factor),
                    constraints
                        .minimum
                        .height
                        .min(f64::from(bounds.height) / monitor.scale_factor),
                )))?;
                window.set_position(PhysicalPosition::new(bounds.x, bounds.y))?;
                window.set_size(PhysicalSize::new(bounds.width, bounds.height))?;
                if restored.maximized {
                    window.maximize()?;
                }
                Ok(())
            })();
            match result {
                Ok(()) => store.current = Some(restored),
                Err(error) => eprintln!("[pideck] could not restore window state: {error}"),
            }
        }
    }
    app.manage(MainWindowState(Arc::new(Mutex::new(store))));
    // All platform configs start hidden. Restoration failures still show the
    // default window; visibility/minimization are deliberately never persisted.
    window.show()?;
    let _ = window.set_focus();
    Ok(())
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    let flush = matches!(
        event,
        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed | WindowEvent::Focused(false)
    );
    if !flush
        && !matches!(
            event,
            WindowEvent::Moved(_)
                | WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
        )
    {
        return;
    }
    let Some(state) = window.try_state::<MainWindowState>() else {
        return;
    };
    // Query the window before locking: native calls can dispatch more events.
    let observed = if matches!(event, WindowEvent::Destroyed) {
        None
    } else {
        observation(window).ok()
    };
    let mut store = state.0.lock().unwrap();
    let changed = observed.is_some_and(|observed| store.observe(observed));
    if flush {
        store.save();
    } else if changed && !store.save_pending {
        store.save_pending = true;
        let shared = state.0.clone();
        let mut revision = store.revision;
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(SAVE_DELAY).await;
                let mut store = shared.lock().unwrap();
                if store.revision != revision {
                    revision = store.revision;
                    continue;
                }
                store.save();
                store.save_pending = false;
                break;
            }
        });
    }
}

pub fn save(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<MainWindowState>() {
        state.0.lock().unwrap().save();
    }
}

#[cfg(test)]
mod tests;
