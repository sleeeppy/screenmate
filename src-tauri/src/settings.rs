//! 사용자 설정 (%APPDATA%\dev.sleeeppy.screenmate\settings.json)

use std::fs;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::models::data_root;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub model_id: Option<String>,
    /// 캐릭터 키(頭 본 높이) CSS px
    pub height_px: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Self { model_id: None, height_px: 260.0 }
    }
}

pub struct SettingsState(pub Mutex<Settings>);

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Settings {
    data_root(app)
        .ok()
        .and_then(|root| fs::read(root.join("settings.json")).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> Result<(), String> {
    let root = data_root(app)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let json = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(root.join("settings.json"), json).map_err(|error| error.to_string())
}

pub fn update<R: Runtime>(app: &AppHandle<R>, change: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
    let state = app.state::<SettingsState>();
    let mut settings = state.0.lock().unwrap();
    change(&mut settings);
    save(app, &settings)?;
    let snapshot = settings.clone();
    drop(settings);
    let _ = app.emit("settings-changed", &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, SettingsState>) -> Settings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn select_model(app: AppHandle, id: String) -> Result<Settings, String> {
    let settings = update(&app, |settings| settings.model_id = Some(id))?;
    crate::tray::refresh(&app);
    Ok(settings)
}
