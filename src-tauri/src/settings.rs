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
    /// 서 있다가 두리번·기지개·걸터앉기 같은 동작을 섞는다
    pub variety: bool,
    /// 창 위쪽 테두리에 올라서고 앉는다
    pub ledges: bool,
    /// 입력이 없으면 이 시간(분) 뒤에 앉아서 존다. 0이면 졸지 않는다.
    pub sleep_minutes: u32,
    /// 가까이 온 커서를 눈과 고개로 따라본다
    pub gaze: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { model_id: None, height_px: 260.0, variety: true, ledges: true, sleep_minutes: 10, gaze: true }
    }
}

/// 설정 창에서 바꾸는 항목 (보낸 것만 바꾼다)
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    pub height_px: Option<f64>,
    pub variety: Option<bool>,
    pub ledges: Option<bool>,
    pub sleep_minutes: Option<u32>,
    pub gaze: Option<bool>,
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
pub fn update_settings(app: AppHandle, patch: SettingsPatch) -> Result<Settings, String> {
    let settings = update(&app, |settings| {
        if let Some(height) = patch.height_px {
            settings.height_px = height.clamp(140.0, 480.0);
        }
        if let Some(variety) = patch.variety {
            settings.variety = variety;
        }
        if let Some(ledges) = patch.ledges {
            settings.ledges = ledges;
        }
        if let Some(minutes) = patch.sleep_minutes {
            settings.sleep_minutes = minutes.min(240);
        }
        if let Some(gaze) = patch.gaze {
            settings.gaze = gaze;
        }
    })?;
    crate::tray::refresh(&app);
    Ok(settings)
}

#[tauri::command]
pub fn select_model(app: AppHandle, id: String) -> Result<Settings, String> {
    let settings = update(&app, |settings| settings.model_id = Some(id))?;
    crate::tray::refresh(&app);
    Ok(settings)
}
