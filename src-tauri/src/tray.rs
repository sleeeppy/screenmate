//! 트레이 메뉴: 모델 전환, 가져오기, 크기, 종료.

use std::collections::BTreeMap;

use tauri::menu::{
    CheckMenuItemBuilder, Menu, MenuBuilder, MenuEvent, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::models::{self, ModelEntry};
use crate::settings::{self, SettingsState};

const TRAY_ID: &str = "main";
const SIZES: &[(&str, f64)] = &[("작게", 200.0), ("보통", 260.0), ("크게", 340.0)];

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("ScreenMate")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(on_menu_event);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// 모델 목록이나 선택이 바뀌었을 때 메뉴를 다시 만든다.
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if let Ok(menu) = build_menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let settings = app.state::<SettingsState>().0.lock().unwrap().clone();
    let models = models::load_registry(app);

    let mut menu = MenuBuilder::new(app);
    if models.is_empty() {
        menu = menu.item(&MenuItemBuilder::with_id("none", "가져온 모델 없음").enabled(false).build(app)?);
    }

    let mut groups: BTreeMap<String, Vec<&ModelEntry>> = BTreeMap::new();
    for entry in &models {
        groups.entry(entry.group.clone()).or_default().push(entry);
    }
    for (group, entries) in &groups {
        let check = |entry: &ModelEntry| {
            CheckMenuItemBuilder::with_id(format!("model:{}", entry.id), &entry.name)
                .checked(settings.model_id.as_deref() == Some(entry.id.as_str()))
                .build(app)
        };
        if entries.len() == 1 {
            menu = menu.item(&check(entries[0])?);
        } else {
            let mut submenu = SubmenuBuilder::new(app, group);
            for entry in entries {
                submenu = submenu.item(&check(entry)?);
            }
            menu = menu.item(&submenu.build()?);
        }
    }

    let mut size = SubmenuBuilder::new(app, "크기");
    for (label, height) in SIZES {
        size = size.item(
            &CheckMenuItemBuilder::with_id(format!("size:{height}"), *label)
                .checked((settings.height_px - height).abs() < 0.5)
                .build(app)?,
        );
    }

    menu.item(&PredefinedMenuItem::separator(app)?)
        .item(&MenuItemBuilder::with_id("import", "모델 가져오기…").build(app)?)
        .item(&MenuItemBuilder::with_id("open-folder", "모델 폴더 열기").build(app)?)
        .item(&size.build()?)
        .item(&MenuItemBuilder::with_id("reload", "다시 불러오기").build(app)?)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&MenuItemBuilder::with_id("quit", "종료").build(app)?)
        .build()
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    if let Some(model_id) = id.strip_prefix("model:") {
        let _ = settings::select_model(app.clone(), model_id.to_string());
    } else if let Some(height) = id.strip_prefix("size:").and_then(|value| value.parse::<f64>().ok()) {
        let _ = settings::update(app, |settings| settings.height_px = height);
        refresh(app);
    } else {
        match id {
            "import" => pick_and_import(app),
            "open-folder" => {
                if let Ok(root) = models::data_root(app) {
                    let folder = root.join("models");
                    let _ = std::fs::create_dir_all(&folder);
                    let opener = if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
                    let _ = std::process::Command::new(opener).arg(folder).spawn();
                }
            }
            "reload" => {
                let _ = app.emit("reload", ());
            }
            "quit" => app.exit(0),
            _ => {}
        }
    }
}

fn pick_and_import(app: &AppHandle) {
    let handle = app.clone();
    app.dialog()
        .file()
        .set_title("MMD 모델 폴더 선택 (.pmx / .pmd가 들어 있는 폴더)")
        .pick_folder(move |folder| {
            let Some(path) = folder.and_then(|folder| folder.into_path().ok()) else {
                return;
            };
            match models::import_folder(&handle, &path) {
                Ok(imported) => {
                    if let Some(first) = imported.first() {
                        let _ = settings::select_model(handle.clone(), first.id.clone());
                    }
                    refresh(&handle);
                }
                Err(message) => {
                    handle
                        .dialog()
                        .message(message)
                        .title("모델 가져오기 실패")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                }
            }
        });
}
