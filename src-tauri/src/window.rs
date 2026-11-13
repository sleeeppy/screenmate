//! 설정 창: 트레이 메뉴 대신 쓰는 GUI (settings.html).

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "settings";

/// 설정 창을 연다. 이미 열려 있으면 앞으로 가져온다.
pub fn open_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("settings.html".into()))
        .title("ScreenMate")
        .inner_size(1120.0, 740.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        .focused(true);
    // macOS: 제목 표시줄을 내용 위에 겹쳐 신호등 버튼이 헤더 안에 들어가게 (WallpaperMachine처럼).
    // 버튼이 헤더(settings.css --header 54px) 세로 가운데에 오게 한다. y는 버튼 위 끝이 아니라
    // 제목 표시줄 높이를 늘리는 값이라, 실제 화면에서 맞춰 본 값이다.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(20.0, 29.0));
    if let Ok(window) = builder.build() {
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub fn open_settings_window(app: AppHandle) {
    open_settings(&app);
}

/// 모델 폴더 가져오기 (폴더 고르기 창)
#[tauri::command]
pub fn import_models(app: AppHandle) {
    crate::tray::pick_and_import(&app);
}

#[tauri::command]
pub fn open_models_folder(app: AppHandle) {
    crate::tray::open_folder(&app, "models");
}

#[tauri::command]
pub fn open_data_folder(app: AppHandle) {
    crate::tray::open_folder(&app, "");
}

#[tauri::command]
pub fn reload_character(app: AppHandle) {
    let _ = app.emit("reload", ());
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}
