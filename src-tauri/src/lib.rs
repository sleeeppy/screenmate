mod models;
mod overlay;
mod settings;
mod tray;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("mate", models::handle_protocol)
        .invoke_handler(tauri::generate_handler![
            overlay::set_interest_rect,
            overlay::set_click_through,
            overlay::stage_info,
            models::list_models,
            models::save_model_cache,
            models::save_profile,
            models::clear_model_cache,
            settings::get_settings,
            settings::select_model,
            tray::register_motions,
            launch_options,
            diag,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(settings::SettingsState(Mutex::new(settings::load(&handle))));
            app.manage(tray::MotionMenu::default());

            // `screenmate --import <폴더> [<폴더> ...]`: 시작할 때 폴더를 가져온다.
            for folder in import_arguments() {
                match models::import_folder(&handle, &folder) {
                    Ok(imported) => println!("imported {} model(s) from {}", imported.len(), folder.display()),
                    Err(message) => eprintln!("import failed for {}: {message}", folder.display()),
                }
            }
            ensure_selection(&handle);

            let window = app.get_webview_window("main").expect("main window is missing");
            overlay::install(&handle, &window)?;
            tray::install(&handle)?;
            window.show()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 웹뷰 진단 로그를 표준 출력으로 (개발 중 성능 측정용)
#[tauri::command]
fn diag(message: String) {
    println!("diag {message}");
}

#[derive(serde::Serialize)]
struct LaunchOptions {
    /// `--motion <이름>`: 시작할 때 재생할 모션 (미리보기·검증용)
    motion: Option<String>,
    /// `--bench-idle`: 커서를 무시하고 대기 fps로 고정 (성능 측정용)
    #[serde(rename = "benchIdle")]
    bench_idle: bool,
}

#[tauri::command]
fn launch_options() -> LaunchOptions {
    let arguments: Vec<String> = std::env::args().collect();
    let motion = arguments
        .iter()
        .position(|argument| argument == "--motion")
        .and_then(|index| arguments.get(index + 1).cloned());
    let bench_idle = arguments.iter().any(|argument| argument == "--bench-idle");
    LaunchOptions { motion, bench_idle }
}

fn import_arguments() -> Vec<PathBuf> {
    let mut folders = Vec::new();
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        if argument == "--import" {
            folders.extend(arguments.by_ref().take_while(|next| !next.starts_with("--")).map(PathBuf::from));
        }
    }
    folders
}

/// 선택된 모델이 없거나 지워졌으면 첫 모델을 고른다.
fn ensure_selection(app: &tauri::AppHandle) {
    let registry = models::load_registry(app);
    let current = app.state::<settings::SettingsState>().0.lock().unwrap().model_id.clone();
    let valid = current.as_ref().is_some_and(|id| registry.iter().any(|entry| &entry.id == id));
    if !valid {
        let first = registry.first().map(|entry| entry.id.clone());
        let _ = settings::update(app, |settings| settings.model_id = first);
    }
}
