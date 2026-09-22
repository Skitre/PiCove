#[cfg(target_os = "macos")]
use tauri::Manager;

pub fn should_hide_on_close(label: &str) -> bool {
    hides_main_window(label, cfg!(any(target_os = "windows", target_os = "macos")))
}

fn hides_main_window(label: &str, keep_running: bool) -> bool {
    keep_running && label == "main"
}

#[cfg(target_os = "macos")]
pub fn reopen(app: &tauri::AppHandle) -> tauri::Result<()> {
    let window = app
        .get_webview_window("main")
        .ok_or(tauri::Error::WindowNotFound)?;
    window.show()?;
    window.unminimize()?;
    window.set_focus()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_main_window_stays_alive_on_supported_platforms() {
        assert!(hides_main_window("main", true));
        assert!(!hides_main_window("extension-float-test", true));
        assert!(!hides_main_window("main", false));
    }
}
