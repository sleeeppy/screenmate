//! 모델 저장소: 가져오기(파일명 복원 포함), 레지스트리, 캐시·프로필 저장, mate:// 프로토콜.
//!
//! 디스크 구조 (%APPDATA%\dev.sleeeppy.screenmate)
//! ├─ models\<package>\...      가져온 폴더 사본 (readme 포함, 이름 복원됨)
//! ├─ models\registry.json      모델 목록
//! ├─ cache\<id>.bpmx           babylon-mmd 최적화 포맷 캐시
//! └─ profiles\<id>.json        자동 보정값 + 사용자 덮어쓰기

use std::borrow::Cow;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use encoding_rs::{EUC_KR, SHIFT_JIS};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub name: String,
    /// 같은 폴더에 있는 변형끼리 묶는 이름 (트레이 하위 메뉴)
    pub group: String,
    /// models\ 기준 상대 경로, '/' 구분
    pub file: String,
    pub format: String,
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Registry {
    models: Vec<ModelEntry>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelListing {
    #[serde(flatten)]
    entry: ModelEntry,
    has_cache: bool,
    profile: Option<serde_json::Value>,
}

pub fn data_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

fn models_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(data_root(app)?.join("models"))
}

pub fn load_registry<R: Runtime>(app: &AppHandle<R>) -> Vec<ModelEntry> {
    let Ok(root) = models_root(app) else {
        return Vec::new();
    };
    fs::read(root.join("registry.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Registry>(&bytes).ok())
        .map(|registry| registry.models)
        .unwrap_or_default()
}

fn save_registry<R: Runtime>(app: &AppHandle<R>, models: &[ModelEntry]) -> Result<(), String> {
    let root = models_root(app)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let registry = Registry { models: models.to_vec() };
    let json = serde_json::to_vec_pretty(&registry).map_err(|error| error.to_string())?;
    fs::write(root.join("registry.json"), json).map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// 가져오기
// ---------------------------------------------------------------------------

/// 폴더를 통째로 복사하고 그 안의 .pmx/.pmd를 모두 등록한다. 이미 있는 패키지는 덮어쓴다.
pub fn import_folder<R: Runtime>(app: &AppHandle<R>, source: &Path) -> Result<Vec<ModelEntry>, String> {
    if !source.is_dir() {
        return Err(format!("폴더가 아닙니다: {}", source.display()));
    }
    let root = models_root(app)?;
    let folder_name = source
        .file_name()
        .map(|name| restore_name(&name.to_string_lossy()))
        .ok_or("폴더 이름이 없습니다")?;
    let package = sanitize(&folder_name);
    let target = root.join(&package);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|error| error.to_string())?;
    }
    copy_restoring_names(source, &target).map_err(|error| error.to_string())?;

    let mut files = Vec::new();
    collect_models(&target, &mut files).map_err(|error| error.to_string())?;
    files.sort();
    if files.is_empty() {
        let _ = fs::remove_dir_all(&target);
        return Err("폴더 안에 .pmx / .pmd 파일이 없습니다".into());
    }

    let mut imported = Vec::new();
    for file in &files {
        let relative = file
            .strip_prefix(&root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let directory = file.parent().unwrap_or(&target);
        let siblings = files.iter().filter(|other| other.parent() == Some(directory)).count();
        let stem = file
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        let directory_name = directory
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| folder_name.clone());
        let name = display_name(&directory_name, &stem, siblings);
        let format = file
            .extension()
            .map(|extension| extension.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        imported.push(ModelEntry {
            id: sanitize(&relative.trim_end_matches(&format!(".{format}")).replace('/', "--")),
            name,
            group: directory_name,
            file: relative,
            format,
        });
    }

    let mut models = load_registry(app);
    models.retain(|entry| !entry.file.starts_with(&format!("{package}/")));
    models.extend(imported.iter().cloned());
    save_registry(app, &models)?;
    let _ = app.emit("models-changed", ());
    Ok(imported)
}

/// 폴더에 모델이 하나면 폴더 이름, 여러 개면 파일 이름을 쓴다.
/// 파일 이름이 "Black" 같은 짧은 영문이면 폴더 이름을 앞에 붙인다.
fn display_name(directory: &str, stem: &str, siblings: usize) -> String {
    if siblings <= 1 {
        return directory.to_string();
    }
    let descriptive = !stem.is_ascii() || stem.chars().count() > 8;
    if descriptive {
        stem.replace('_', " ")
    } else {
        format!("{directory} {stem}")
    }
}

fn collect_models(directory: &Path, out: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            collect_models(&path, out)?;
        } else if matches!(
            path.extension().map(|extension| extension.to_string_lossy().to_ascii_lowercase()).as_deref(),
            Some("pmx" | "pmd")
        ) {
            out.push(path);
        }
    }
    Ok(())
}

fn copy_restoring_names(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let name = restore_name(&entry.file_name().to_string_lossy());
        let destination = target.join(name);
        if entry.file_type()?.is_dir() {
            copy_restoring_names(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

/// Shift-JIS zip을 CP949로 풀어서 깨진 이름을 되돌린다.
/// 예: "떮돶깏깛_DIVA븮릣뭶.pmd" → "鏡音リン_DIVA風水着.pmd"
///
/// 깨진 이름은 CP949로 다시 인코딩하면 원래 Shift-JIS 바이트가 나온다.
/// 진짜 한국어 이름을 잘못 바꾸지 않도록, 결과가 오류 없이 디코딩되고
/// 일본어 문자를 포함하며 반각 가타카나가 없을 때만 받아들인다.
pub fn restore_name(name: &str) -> String {
    if !name.chars().any(is_hangul) {
        return name.to_string();
    }
    let (bytes, _, had_errors) = EUC_KR.encode(name);
    if had_errors {
        return name.to_string();
    }
    let Some(decoded) = SHIFT_JIS.decode_without_bom_handling_and_without_replacement(&bytes) else {
        return name.to_string();
    };
    let plausible = decoded.chars().any(is_japanese)
        && !decoded.chars().any(|c| ('\u{FF61}'..='\u{FF9F}').contains(&c))
        && !decoded.chars().any(is_hangul);
    if plausible {
        decoded.into_owned()
    } else {
        name.to_string()
    }
}

fn is_hangul(c: char) -> bool {
    ('\u{AC00}'..='\u{D7A3}').contains(&c)
}

fn is_japanese(c: char) -> bool {
    ('\u{3040}'..='\u{30FF}').contains(&c) || ('\u{4E00}'..='\u{9FFF}').contains(&c)
}

/// 경로·URL에 안전한 id. 비ASCII 문자는 그대로 두고 구분자와 위험 문자만 바꾼다.
fn sanitize(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '#' | '%' | '&' | ' ' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c| c == '.' || c == '_');
    if trimmed.is_empty() { "model".into() } else { trimmed.into() }
}

// ---------------------------------------------------------------------------
// 커맨드
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_models(app: AppHandle) -> Result<Vec<ModelListing>, String> {
    let root = data_root(&app)?;
    Ok(load_registry(&app)
        .into_iter()
        .map(|entry| {
            let has_cache = root.join("cache").join(format!("{}.bpmx", entry.id)).is_file();
            let profile = fs::read(root.join("profiles").join(format!("{}.json", entry.id)))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok());
            ModelListing { entry, has_cache, profile }
        })
        .collect())
}

/// BPMX 캐시 저장. 본문은 바이너리, 모델 id는 `x-model-id` 헤더(percent-encoded).
#[tauri::command]
pub fn save_model_cache(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("binary body expected".into());
    };
    let id = request
        .headers()
        .get("x-model-id")
        .and_then(|value| value.to_str().ok())
        .map(|value| percent_encoding::percent_decode_str(value).decode_utf8_lossy().into_owned())
        .ok_or("x-model-id header missing")?;
    ensure_known(&app, &id)?;
    let directory = data_root(&app)?.join("cache");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    fs::write(directory.join(format!("{id}.bpmx")), bytes).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_profile(app: AppHandle, id: String, profile: serde_json::Value) -> Result<(), String> {
    ensure_known(&app, &id)?;
    let directory = data_root(&app)?.join("profiles");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let json = serde_json::to_vec_pretty(&profile).map_err(|error| error.to_string())?;
    fs::write(directory.join(format!("{id}.json")), json).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn clear_model_cache(app: AppHandle, id: String) -> Result<(), String> {
    ensure_known(&app, &id)?;
    let path = data_root(&app)?.join("cache").join(format!("{id}.bpmx"));
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.to_string()),
        _ => Ok(()),
    }
}

fn ensure_known(app: &AppHandle, id: &str) -> Result<(), String> {
    if load_registry(app).iter().any(|entry| entry.id == id) {
        Ok(())
    } else {
        Err(format!("unknown model id {id}"))
    }
}

// ---------------------------------------------------------------------------
// mate:// 프로토콜 (Windows에서는 http://mate.localhost/...)
// ---------------------------------------------------------------------------

const SERVED_DIRECTORIES: &[&str] = &["models", "cache"];

pub fn handle_protocol<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = context.app_handle().clone();
    let path = request.uri().path().to_string();
    // 파일 읽기는 메인 스레드를 막지 않도록 별도 스레드에서 한다.
    std::thread::spawn(move || {
        responder.respond(serve(&app, &path));
    });
}

fn serve<R: Runtime>(app: &AppHandle<R>, raw_path: &str) -> Response<Vec<u8>> {
    let decoded: Cow<str> = percent_encoding::percent_decode_str(raw_path).decode_utf8_lossy();
    let relative = decoded.trim_start_matches('/').replace('\\', "/");
    let result = data_root(app).and_then(|root| resolve(&root, &relative));
    match result.and_then(|path| fs::read(&path).map(|bytes| (path, bytes)).map_err(|error| error.to_string())) {
        Ok((path, bytes)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime(&path))
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CACHE_CONTROL, "no-store")
            .body(bytes)
            .unwrap(),
        Err(message) => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(message.into_bytes())
            .unwrap(),
    }
}

/// `models/...` 또는 `cache/...` 아래 파일만 허용한다. `..`와 절대 경로는 거부한다.
/// 대소문자가 다른 텍스처 참조(Windows MMD 모델에 흔함)는 파일 시스템이 처리한다.
fn resolve(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    let mut components = path.components();
    let first = match components.next() {
        Some(Component::Normal(first)) => first.to_string_lossy().into_owned(),
        _ => return Err(format!("bad path {relative}")),
    };
    if !SERVED_DIRECTORIES.contains(&first.as_str()) {
        return Err(format!("not served: {relative}"));
    }
    if path.components().any(|component| !matches!(component, Component::Normal(_))) {
        return Err(format!("bad path {relative}"));
    }
    let full = root.join(path);
    if full.is_file() {
        return Ok(full);
    }
    // 원본 모델이 깨진 이름 그대로 참조하는 경우를 위해, 이름 복원한 경로도 시도한다.
    let restored: PathBuf = path
        .components()
        .map(|component| restore_name(&component.as_os_str().to_string_lossy()))
        .collect();
    let full = root.join(restored);
    if full.is_file() { Ok(full) } else { Err(format!("not found: {relative}")) }
}

fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("bmp" | "spa" | "sph") => "image/bmp",
        Some("tga") => "image/x-tga",
        Some("dds") => "image/vnd-ms.dds",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_shift_jis_mojibake() {
        assert_eq!(restore_name("떮돶깏깛_DIVA븮릣뭶.pmd"), "鏡音リン_DIVA風水着.pmd");
        assert_eq!(restore_name("KAITO_DIVA븮릣뭶.pmd"), "KAITO_DIVA風水着.pmd");
        assert_eq!(restore_name("먣뼻.txt"), "説明.txt");
        assert_eq!(restore_name("YYB렜떮돶깒깛ver1.00"), "YYB式鏡音レンver1.00");
    }

    #[test]
    fn keeps_real_korean_and_ascii_names() {
        assert_eq!(restore_name("다운로드"), "다운로드");
        assert_eq!(restore_name("모델 폴더"), "모델 폴더");
        assert_eq!(restore_name("Black.pmx"), "Black.pmx");
        assert_eq!(restore_name("鏡音リン.pmx"), "鏡音リン.pmx");
    }

    #[test]
    fn rejects_traversal() {
        let root = Path::new(r"C:\root");
        assert!(resolve(root, "models/../secret").is_err());
        assert!(resolve(root, "other/file").is_err());
        assert!(resolve(root, "").is_err());
    }

    #[test]
    fn names_models() {
        assert_eq!(display_name("Sour式鏡音リンVer.2.01", "Black", 2), "Sour式鏡音リンVer.2.01 Black");
        assert_eq!(display_name("DIVA風水着セット", "鏡音リン_DIVA風水着", 4), "鏡音リン DIVA風水着");
        assert_eq!(display_name("Lat Kagamine Len v1.3", "Lat Kagamine Len v1.3", 1), "Lat Kagamine Len v1.3");
    }
}
