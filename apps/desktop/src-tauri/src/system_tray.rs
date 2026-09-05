const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_ID: &str = "pideck-tray";

#[cfg(any(target_os = "windows", test))]
const OPEN_MENU_ID: &str = "pideck-tray-open";
#[cfg(any(target_os = "windows", test))]
const QUIT_MENU_ID: &str = "pideck-tray-quit";

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, PartialEq, Eq)]
enum TrayMenuAction {
    Open,
    Quit,
    Ignore,
}

#[cfg(any(target_os = "windows", test))]
fn menu_action(id: &str) -> TrayMenuAction {
    match id {
        OPEN_MENU_ID => TrayMenuAction::Open,
        QUIT_MENU_ID => TrayMenuAction::Quit,
        _ => TrayMenuAction::Ignore,
    }
}

#[cfg(any(target_os = "windows", test))]
fn should_restore_from_click(
    button: tauri::tray::MouseButton,
    state: tauri::tray::MouseButtonState,
) -> bool {
    button == tauri::tray::MouseButton::Left && state == tauri::tray::MouseButtonState::Up
}

fn should_hide_for_platform(label: &str, is_windows: bool) -> bool {
    is_windows && label == MAIN_WINDOW_LABEL
}

pub fn should_hide_on_close(label: &str) -> bool {
    should_hide_for_platform(label, cfg!(target_os = "windows"))
}

pub fn remove(app: &tauri::AppHandle) {
    drop(app.remove_tray_by_id(TRAY_ID));
}

#[cfg(target_os = "windows")]
pub fn install(app: &mut tauri::App) -> tauri::Result<()> {
    install_windows(app)
}

#[cfg(not(target_os = "windows"))]
pub fn install(_app: &mut tauri::App) -> tauri::Result<()> {
    Ok(())
}

#[cfg(any(target_os = "windows", test))]
fn install_windows(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::MenuBuilder,
        tray::{TrayIconBuilder, TrayIconEvent},
    };

    let menu = MenuBuilder::new(app)
        .text(OPEN_MENU_ID, "Open PiCove")
        .separator()
        .text(QUIT_MENU_ID, "Quit PiCove")
        .build()?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("PiCove")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match menu_action(event.id().as_ref()) {
            TrayMenuAction::Open => show_main_window(app),
            TrayMenuAction::Quit => app.exit(0),
            TrayMenuAction::Ignore => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = event
            {
                if should_restore_from_click(button, button_state) {
                    show_main_window(tray.app_handle());
                }
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.build(app)?;
    Ok(())
}

#[cfg(any(target_os = "windows", test))]
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;

    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::tray::{MouseButton, MouseButtonState};

    #[test]
    fn maps_only_known_menu_items() {
        assert_eq!(menu_action(OPEN_MENU_ID), TrayMenuAction::Open);
        assert_eq!(menu_action(QUIT_MENU_ID), TrayMenuAction::Quit);
        assert_eq!(menu_action("other-menu"), TrayMenuAction::Ignore);
    }

    #[test]
    fn restores_only_on_left_button_release() {
        assert!(should_restore_from_click(
            MouseButton::Left,
            MouseButtonState::Up
        ));
        assert!(!should_restore_from_click(
            MouseButton::Left,
            MouseButtonState::Down
        ));
        assert!(!should_restore_from_click(
            MouseButton::Right,
            MouseButtonState::Up
        ));
    }

    #[test]
    fn hides_only_the_windows_main_window() {
        assert!(should_hide_for_platform(MAIN_WINDOW_LABEL, true));
        assert!(!should_hide_for_platform("settings", true));
        assert!(!should_hide_for_platform(MAIN_WINDOW_LABEL, false));
    }

    #[test]
    fn windows_tray_builder_is_compiled_in_tests() {
        let _builder: fn(&mut tauri::App) -> tauri::Result<()> = install_windows;
    }
}
