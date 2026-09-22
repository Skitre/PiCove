use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    Manager,
};

const CLOSE_WINDOW_ID: &str = "close-window";

pub fn install(app: &tauri::App) -> tauri::Result<()> {
    // NSWindow's performClose: is disabled for our borderless windows. Route
    // the native accelerator through Tauri close() so CloseRequested still runs.
    let close = MenuItemBuilder::with_id(CLOSE_WINDOW_ID, "Close Window")
        .accelerator("Cmd+W")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "PiCove")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .separator()
        .quit()
        .build()?;
    let file = SubmenuBuilder::new(app, "File").item(&close).build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View").fullscreen().build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&close)
        .build()?;
    let help = SubmenuBuilder::new(app, "Help").build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &window, &help])
        .build()?;
    window.set_as_windows_menu_for_nsapp()?;
    help.set_as_help_menu_for_nsapp()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == CLOSE_WINDOW_ID {
            if let Err(error) = close_focused_window(app) {
                eprintln!("[pideck] could not close focused window: {error}");
            }
        }
    });
    Ok(())
}

fn close_focused_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    for window in app.webview_windows().values() {
        if window.is_focused()? {
            return window.close();
        }
    }
    Ok(())
}
