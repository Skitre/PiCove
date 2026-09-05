use crate::browser_surface::{BrowserSurfaceBounds, BrowserSurfaceSnapshot};
use crate::desktop_settings::{DesktopSettings, DesktopSettingsSnapshot};
use crate::draft_store::{DraftApplyResult, DraftMutation, DraftWorkspaceSnapshot};
use crate::extension_float::{FloatWindowRect, FloatWindowSnapshot};
use crate::shell_terminal::{
    shell_profile_catalog, ShellProfileCatalog, ShellTerminalCreateResult, ShellTerminalEvent,
};
use crate::AppState;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{ipc::Channel, AppHandle, Emitter, State};

const MAIN_WINDOW_LABEL: &str = "main";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Applies a complete native window rectangle in one AppKit operation.
///
/// Calling Tauri's position and size setters independently can expose an
/// intermediate frame for one compositor tick. Fullscreen restore animation
/// uses this command so all four edges move together.
#[tauri::command]
pub fn desktop_window_set_bounds(
    webview: tauri::Webview,
    bounds: DesktopWindowBounds,
) -> Result<(), String> {
    require_main_webview(&webview)?;

    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWindow;
        use objc2_foundation::{NSPoint, NSRect, NSSize};

        let window = webview.window();
        let position = window.outer_position().map_err(|error| error.to_string())?;
        let size = window.outer_size().map_err(|error| error.to_string())?;
        let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
        let ns_window = window.ns_window().map_err(|error| error.to_string())?;
        let ns_window: &NSWindow = unsafe { &*ns_window.cast() };
        let frame = NSWindow::frame(ns_window);

        let dx = (bounds.x - position.x) as f64 / scale_factor;
        let dy = (bounds.y - position.y) as f64 / scale_factor;
        let delta_height = (bounds.height as f64 - size.height as f64) / scale_factor;
        let new_frame = NSRect::new(
            NSPoint::new(frame.origin.x + dx, frame.origin.y - dy - delta_height),
            NSSize::new(
                bounds.width as f64 / scale_factor,
                bounds.height as f64 / scale_factor,
            ),
        );

        NSWindow::setFrame_display(ns_window, new_frame, false);
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = bounds;
        Err("desktop_window_set_bounds is only supported on macOS".to_string())
    }
}

#[tauri::command]
pub async fn desktop_settings_get(
    webview: tauri::Webview,
    state: State<'_, AppState>,
) -> Result<DesktopSettingsSnapshot, String> {
    require_main_webview(&webview)?;
    let store = state.settings.lock().await;
    Ok(store.snapshot())
}

#[tauri::command]
pub async fn desktop_settings_patch(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    patch: Value,
) -> Result<DesktopSettings, String> {
    require_main_webview(&webview)?;
    let mut store = state.settings.lock().await;
    let next = store.patch(patch)?;
    // Propagate agentDir / autoRestart to host manager
    let mut host = state.host.lock().await;
    host.set_agent_dir(store.resolved_agent_dir());
    host.set_auto_restart_once(store.settings.auto_restart_host_once);
    host.set_initial_workspace(&store);
    Ok(next)
}

#[tauri::command]
pub async fn desktop_drafts_get(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    canonical_cwd: String,
) -> Result<DraftWorkspaceSnapshot, String> {
    require_main_webview(&webview)?;
    let mut store = state.drafts.lock().await;
    store.workspace_snapshot(&canonical_cwd)
}

#[tauri::command]
pub async fn desktop_drafts_apply(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    mutations: Vec<DraftMutation>,
) -> Result<DraftApplyResult, String> {
    require_main_webview(&webview)?;
    let mut store = state.drafts.lock().await;
    store.apply(mutations)
}

#[tauri::command]
pub async fn desktop_open_path(webview: tauri::Webview, path: String) -> Result<(), String> {
    require_main_webview(&webview)?;
    let target = validate_open_path(&path)?;
    open_in_file_manager(target)
}

const MAX_SMALL_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_SMALL_TEXT_BYTES: u64 = 256 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSmallFile {
    kind: &'static str,
    name: String,
    size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    media_type: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

#[tauri::command]
pub fn desktop_read_small_file(
    webview: tauri::Webview,
    path: String,
) -> Result<DesktopSmallFile, String> {
    require_main_webview(&webview)?;
    read_small_file(&path)
}

fn read_small_file(raw: &str) -> Result<DesktopSmallFile, String> {
    let path = validate_local_file(raw)?;
    let metadata = std::fs::metadata(&path).map_err(|e| format!("file is not accessible: {e}"))?;
    let size_bytes = metadata.len();
    if size_bytes > MAX_SMALL_IMAGE_BYTES {
        return Err(format!(
            "file exceeds the {} MiB local-read limit",
            MAX_SMALL_IMAGE_BYTES / 1024 / 1024
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("could not read file: {e}"))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "file name is not valid UTF-8".to_string())?
        .to_string();

    if let Some(media_type) = sniff_image_media_type(&bytes) {
        return Ok(DesktopSmallFile {
            kind: "image",
            name,
            size_bytes,
            media_type: Some(media_type),
            data: Some(BASE64_STANDARD.encode(bytes)),
            text: None,
        });
    }

    if size_bytes > MAX_SMALL_TEXT_BYTES {
        return Err(format!(
            "text file exceeds the {} KiB local-read limit",
            MAX_SMALL_TEXT_BYTES / 1024
        ));
    }
    let text = String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8 text".to_string())?;
    if looks_binary_text(&text) {
        return Err("binary file type is not supported".to_string());
    }
    Ok(DesktopSmallFile {
        kind: "text",
        name,
        size_bytes,
        media_type: None,
        data: None,
        text: Some(text),
    })
}

fn validate_local_file(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("path is empty".into());
    }
    if trimmed.starts_with("\\\\") || trimmed.starts_with("//") {
        return Err("network (UNC) paths are not allowed".into());
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err("path must be absolute".into());
    }
    let resolved = path
        .canonicalize()
        .map_err(|e| format!("path does not exist: {e}"))?;
    let resolved = crate::pi_host::strip_verbatim_prefix(resolved);
    if resolved.to_string_lossy().starts_with(r"\\") {
        return Err("network (UNC) paths are not allowed".into());
    }
    let metadata =
        std::fs::metadata(&resolved).map_err(|e| format!("file is not accessible: {e}"))?;
    if !metadata.is_file() {
        return Err("path is not a regular file".into());
    }
    Ok(resolved)
}

fn sniff_image_media_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn looks_binary_text(text: &str) -> bool {
    text.contains('\0')
}

/// A detached Extension Float window is a thin client: it renders one
/// presentation slot and must never reach the Host transport or the settings
/// store. Capabilities already withhold the core permissions from those
/// webviews; this is the matching guard for application-defined commands, which
/// capabilities do not gate.
fn require_main_webview_label(label: &str) -> Result<(), String> {
    if label != MAIN_WINDOW_LABEL {
        return Err("this command is only available to the main window".to_string());
    }
    Ok(())
}

fn require_main_webview(webview: &tauri::Webview) -> Result<(), String> {
    require_main_webview_label(webview.window().label())
}

#[tauri::command]
pub async fn pi_host_send(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    line: String,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let mut host = state.host.lock().await;
    host.send_line(line).await
}

#[tauri::command]
pub async fn pi_host_restart(
    webview: tauri::Webview,
    state: State<'_, AppState>,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    // Holds the host mutex only for spawn/commit, not across the ready-wait.
    crate::pi_host::start_unlocked(&state.host, crate::pi_host::StartKind::ManualRestart).await
}

#[tauri::command]
pub async fn pi_host_status(
    webview: tauri::Webview,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    require_main_webview(&webview)?;
    let mut host = state.host.lock().await;
    Ok(host.is_running())
}

#[tauri::command]
pub async fn shell_terminal_create(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    cwd: String,
    cols: u16,
    rows: u16,
    profile_id: String,
    on_event: Channel<ShellTerminalEvent>,
) -> Result<ShellTerminalCreateResult, String> {
    require_main_webview(&webview)?;
    let mut terminals = state.terminals.lock().await;
    terminals.create(&cwd, cols, rows, &profile_id, on_event)
}

#[tauri::command]
pub async fn shell_terminal_profiles(
    webview: tauri::Webview,
) -> Result<ShellProfileCatalog, String> {
    require_main_webview(&webview)?;
    shell_profile_catalog()
}

#[tauri::command]
pub async fn shell_terminal_write(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    // A completion may wait on PTY capacity; only enqueue while holding the manager lock.
    let completion = {
        let terminals = state.terminals.lock().await;
        terminals.enqueue_write(&terminal_id, data)?
    };
    completion
        .await
        .map_err(|_| "terminal writer stopped before completing input".to_string())?
}

#[tauri::command]
pub async fn shell_terminal_resize(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let terminals = state.terminals.lock().await;
    terminals.resize(&terminal_id, cols, rows)
}

#[tauri::command]
pub async fn shell_terminal_close(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<bool, String> {
    require_main_webview(&webview)?;
    let mut terminals = state.terminals.lock().await;
    Ok(terminals.close(&terminal_id))
}

#[tauri::command]
pub async fn browser_surface_create(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    surface_id: String,
    url: String,
    bounds: BrowserSurfaceBounds,
    visible: bool,
) -> Result<BrowserSurfaceSnapshot, String> {
    require_main_webview(&webview)?;
    let mut browsers = state.browsers.lock().await;
    browsers.create(&app, &surface_id, &url, bounds, visible)
}

#[tauri::command]
pub async fn browser_surface_navigate(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    surface_id: String,
    url: String,
) -> Result<String, String> {
    require_main_webview(&webview)?;
    let browsers = state.browsers.lock().await;
    browsers.navigate(&surface_id, &url)
}

#[tauri::command]
pub async fn browser_surface_control(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    surface_id: String,
    action: String,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let browsers = state.browsers.lock().await;
    browsers.control(&surface_id, &action)
}

#[tauri::command]
pub async fn browser_surface_set_bounds(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    surface_id: String,
    bounds: BrowserSurfaceBounds,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let mut browsers = state.browsers.lock().await;
    browsers.set_bounds(&surface_id, bounds)
}

#[tauri::command]
pub async fn browser_surface_set_visible(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    surface_id: String,
    visible: bool,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let mut browsers = state.browsers.lock().await;
    browsers.set_visible(&surface_id, visible)
}

#[tauri::command]
pub async fn browser_surface_focus(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    surface_id: String,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let browsers = state.browsers.lock().await;
    browsers.focus(&surface_id)
}

#[tauri::command]
pub async fn browser_surface_close(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    surface_id: String,
) -> Result<bool, String> {
    require_main_webview(&webview)?;
    let mut browsers = state.browsers.lock().await;
    browsers.close(&surface_id)
}

// --- Detached Extension Float windows -------------------------------------
//
// Only the main window may manage Float windows: the main window owns the
// presentation profile and is the only settings writer, so a Float window that
// could open or move another Float would fork that ownership.

/// Synchronous on purpose. Tauri runs `async` commands on the async runtime,
/// but monitor enumeration must happen on the main thread — macOS returns an
/// empty screen list off it, which would silently reattach every detached Float
/// as "monitor missing". A sync command runs on the main thread.
#[tauri::command]
pub fn extension_float_monitors(
    webview: tauri::Webview,
    app: AppHandle,
) -> Result<Vec<crate::extension_ui_settings::MonitorDescriptor>, String> {
    require_main_webview(&webview)?;
    crate::extension_float::available_monitors(&app)
}

#[tauri::command]
pub async fn extension_float_open(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    slot_id: String,
    rect: FloatWindowRect,
    title: String,
    always_on_top: bool,
) -> Result<FloatWindowSnapshot, String> {
    require_main_webview(&webview)?;
    let mut floats = state.floats.lock().await;
    floats.open(&app, &slot_id, &rect, &title, always_on_top)
}

#[tauri::command]
pub async fn extension_float_close(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    slot_id: String,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let mut floats = state.floats.lock().await;
    floats.close(&app, &slot_id)
}

#[tauri::command]
pub async fn extension_float_set_bounds(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    slot_id: String,
    rect: FloatWindowRect,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let floats = state.floats.lock().await;
    floats.set_bounds(&app, &slot_id, &rect)
}

#[tauri::command]
pub async fn extension_float_set_always_on_top(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    slot_id: String,
    always_on_top: bool,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let floats = state.floats.lock().await;
    floats.set_always_on_top(&app, &slot_id, always_on_top)
}

#[tauri::command]
pub async fn extension_float_focus(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    slot_id: String,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let floats = state.floats.lock().await;
    floats.focus(&app, &slot_id)
}

#[tauri::command]
pub async fn extension_float_close_all(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let mut floats = state.floats.lock().await;
    floats.destroy_all(&app);
    Ok(())
}

/// Float → main intent relay. The caller cannot choose its slot identity:
/// Rust derives it from the registered native window label and overwrites any
/// payload value before addressing the event only to the main webview.
#[tauri::command]
pub async fn extension_float_intent(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    mut intent: Value,
) -> Result<(), String> {
    let slot_id = {
        let floats = state.floats.lock().await;
        floats
            .slot_for_window_label(&app, webview.window().label())
            .ok_or_else(|| "extension float window is not registered".to_string())?
    };
    let object = intent
        .as_object_mut()
        .ok_or_else(|| "extension float intent must be an object".to_string())?;
    object.insert("slotId".to_string(), Value::String(slot_id));
    app.emit_to(MAIN_WINDOW_LABEL, "pideck:float-intent", intent)
        .map_err(|error| error.to_string())
}

/// What the file manager should do with a validated local path.
#[derive(Debug, PartialEq, Eq)]
pub enum OpenTarget {
    /// Reveal (select) the directory in the platform file manager.
    Directory(PathBuf),
    /// Reveal (select) the file in its parent directory.
    Reveal(PathBuf),
}

/// The webview may only point the file manager at an existing local
/// directory or file. Anything else — relative paths, UNC/network paths,
/// non-existent paths — is rejected before the path is passed as an argument
/// to the platform file manager.
pub fn validate_open_path(raw: &str) -> Result<OpenTarget, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("path is empty".into());
    }
    if trimmed.starts_with("\\\\") || trimmed.starts_with("//") {
        return Err("network (UNC) paths are not allowed".into());
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err("path must be absolute".into());
    }
    // Resolve symlinks/relative components; fails for non-existent paths.
    let resolved = path
        .canonicalize()
        .map_err(|e| format!("path does not exist: {e}"))?;
    let resolved = crate::pi_host::strip_verbatim_prefix(resolved);
    // Re-check after canonicalize: a symlink may resolve to a network path
    // (\\?\UNC\... is rendered back as \\server\share by strip_verbatim_prefix).
    if resolved.to_string_lossy().starts_with(r"\\") {
        return Err("network (UNC) paths are not allowed".into());
    }
    let meta = std::fs::metadata(&resolved).map_err(|e| format!("path is not accessible: {e}"))?;
    if meta.is_dir() {
        Ok(OpenTarget::Directory(resolved))
    } else if meta.is_file() {
        Ok(OpenTarget::Reveal(resolved))
    } else {
        Err("path is neither a regular file nor a directory".into())
    }
}

#[cfg(any(target_os = "macos", test))]
fn macos_open_args(target: &OpenTarget) -> Vec<std::ffi::OsString> {
    let path = match target {
        OpenTarget::Directory(dir) => dir,
        OpenTarget::Reveal(file) => file,
    };
    vec![
        std::ffi::OsString::from("-R"),
        path.as_os_str().to_os_string(),
    ]
}

fn open_in_file_manager(target: OpenTarget) -> Result<(), String> {
    use std::process::Command;

    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("explorer.exe");
        match &target {
            OpenTarget::Directory(dir) => {
                cmd.arg(dir);
            }
            OpenTarget::Reveal(file) => {
                // `/select,` shows the file in its folder without opening/executing it.
                cmd.arg(format!("/select,{}", file.display()));
            }
        }
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("open");
        cmd.args(macos_open_args(&target));
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let dir = match &target {
            OpenTarget::Directory(dir) => dir.clone(),
            OpenTarget::Reveal(file) => file
                .parent()
                .map(|p| p.to_path_buf())
                .ok_or_else(|| "file has no parent directory".to_string())?,
        };
        Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_file(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pideck-small-file-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn rejects_empty_and_relative_paths() {
        assert!(validate_open_path("").is_err());
        assert!(validate_open_path("   ").is_err());
        assert!(validate_open_path("relative/dir").is_err());
        assert!(validate_open_path("./here").is_err());
    }

    #[test]
    fn application_commands_accept_only_the_exact_main_window_label() {
        assert!(require_main_webview_label("main").is_ok());
        assert!(require_main_webview_label("pideck-float-deadbeef").is_err());
        assert!(require_main_webview_label("browser-surface-1").is_err());
        assert!(require_main_webview_label("main-preview").is_err());
    }

    #[test]
    fn rejects_unc_paths() {
        assert!(validate_open_path("\\\\attacker\\share\\evil.exe").is_err());
        assert!(validate_open_path("//attacker/share/evil.exe").is_err());
    }

    #[test]
    fn rejects_nonexistent_paths() {
        assert!(validate_open_path("C:\\definitely\\not\\a\\real\\path\\x9z").is_err());
    }

    #[test]
    fn accepts_existing_directory() {
        let dir = std::env::temp_dir();
        let target = validate_open_path(dir.to_str().unwrap()).unwrap();
        assert!(matches!(target, OpenTarget::Directory(_)));
    }

    #[test]
    fn files_are_revealed_not_opened() {
        let dir = std::env::temp_dir().join("pideck-open-path-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.exe");
        std::fs::write(&file, b"not really an exe").unwrap();
        let target = validate_open_path(file.to_str().unwrap()).unwrap();
        match target {
            OpenTarget::Reveal(p) => assert!(p.ends_with("sample.exe")),
            other => panic!("expected Reveal, got {other:?}"),
        }
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn macos_reveals_directories_and_files() {
        let app = PathBuf::from("/Applications/Example.app");
        assert_eq!(
            macos_open_args(&OpenTarget::Directory(app.clone())),
            vec![std::ffi::OsString::from("-R"), app.into_os_string()],
        );

        let file = PathBuf::from("/tmp/example.txt");
        assert_eq!(
            macos_open_args(&OpenTarget::Reveal(file.clone())),
            vec![std::ffi::OsString::from("-R"), file.into_os_string()],
        );
    }

    #[test]
    fn reads_small_utf8_text() {
        let path = temp_test_file("notes.txt", "hello 世界".as_bytes());
        let file = read_small_file(path.to_str().unwrap()).unwrap();
        assert_eq!(file.kind, "text");
        assert_eq!(file.name, "notes.txt");
        assert_eq!(file.text.as_deref(), Some("hello 世界"));
        assert!(file.data.is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn sniffs_images_instead_of_trusting_extension() {
        let path = temp_test_file("not-an-image.txt", b"\x89PNG\r\n\x1a\nrest");
        let file = read_small_file(path.to_str().unwrap()).unwrap();
        assert_eq!(file.kind, "image");
        assert_eq!(file.media_type, Some("image/png"));
        assert!(file.data.as_deref().is_some_and(|value| !value.is_empty()));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn rejects_binary_and_oversized_text() {
        let binary = temp_test_file("binary.dat", b"abc\0def");
        assert!(read_small_file(binary.to_str().unwrap()).is_err());
        let oversized = temp_test_file("large.txt", &vec![b'a'; MAX_SMALL_TEXT_BYTES as usize + 1]);
        assert!(read_small_file(oversized.to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(binary.parent().unwrap());
        let _ = std::fs::remove_dir_all(oversized.parent().unwrap());
    }
}
