//! 투명 오버레이 창: 창 스타일, 클릭 통과, 커서 폴링.
//!
//! 성능 메모
//! - 창 위치·크기·배율은 창 이벤트가 올 때만 갱신해서 캐시한다. 폴링 스레드에서
//!   `outer_position()` 등을 부르면 매번 메인 스레드와 동기 왕복이 생긴다.
//! - 커서 이벤트는 웹뷰가 알려준 관심 영역(캐릭터 주변) 안에서, 위치가 바뀔 때만 보낸다.
//!   관심 영역을 드나들 때는 한 번씩 보내서 웹뷰가 "가까움/멂"을 알 수 있게 한다.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

const POLL_INTERVAL: Duration = Duration::from_millis(8);

#[derive(Clone, Copy, Default)]
struct Geometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}

/// 웹뷰 좌표(CSS px, 창 왼쪽 위 기준) 사각형
#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
pub struct CssRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl CssRect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
}

#[derive(Default)]
pub struct OverlayState {
    geometry: Mutex<Geometry>,
    interest: Mutex<Option<CssRect>>,
    /// 오버레이를 띄운 모니터 전체 (작업 영역 아님). 물리 px 왼쪽 위·크기와 배율
    monitor: Mutex<Option<(i32, i32, u32, u32, f64)>>,
}

impl OverlayState {
    /// 오버레이 창 왼쪽 위(물리 px)와 배율
    pub fn origin(&self) -> (i32, i32, f64) {
        let geometry = *self.geometry.lock().unwrap();
        (geometry.x, geometry.y, geometry.scale)
    }

    /// 오버레이를 띄운 모니터 전체 (물리 px 왼쪽 위·크기, 배율)
    pub fn monitor(&self) -> Option<(i32, i32, u32, u32, f64)> {
        *self.monitor.lock().unwrap()
    }
}

#[derive(Clone, serde::Serialize)]
struct CursorPayload {
    x: f64,
    y: f64,
    near: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageInfo {
    width: f64,
    height: f64,
    scale: f64,
    work_area: CssRect,
}

pub fn install(app: &AppHandle, window: &WebviewWindow) -> tauri::Result<()> {
    let state = Arc::new(OverlayState::default());
    app.manage(state.clone());

    *state.monitor.lock().unwrap() = fit_primary_monitor(window)?;
    window.set_ignore_cursor_events(true)?;
    reapply_window_chrome(window);
    refresh_geometry(window, &state);

    let event_window = window.clone();
    let event_state = state.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
        ) {
            refresh_geometry(&event_window, &event_state);
        }
    });

    let poll_app = app.clone();
    thread::Builder::new()
        .name("cursor-poll".into())
        .spawn(move || poll_cursor(poll_app, state))
        .expect("cursor poll thread");

    Ok(())
}

fn refresh_geometry(window: &WebviewWindow, state: &OverlayState) {
    let (Ok(position), Ok(size), Ok(scale)) =
        (window.outer_position(), window.outer_size(), window.scale_factor())
    else {
        return;
    };
    *state.geometry.lock().unwrap() = Geometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        scale,
    };
}

/// 주 모니터를 덮게 놓고, 그 모니터 사각형(물리 px)과 배율을 돌려준다.
fn fit_primary_monitor(window: &WebviewWindow) -> tauri::Result<Option<(i32, i32, u32, u32, f64)>> {
    let Some(monitor) = window.primary_monitor()? else {
        return Ok(None);
    };
    let position = monitor.position();
    let size = monitor.size();
    window.set_position(PhysicalPosition::new(position.x, position.y))?;
    window.set_size(PhysicalSize::new(size.width, size.height))?;
    Ok(Some((position.x, position.y, size.width, size.height, monitor.scale_factor())))
}

/// Alt+Tab·작업표시줄에서 숨기고, 클릭해도 포커스를 뺏지 않으며, DWM 테두리를 없앤다.
#[cfg(windows)]
fn hide_window_chrome(window: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = HWND(hwnd.0);
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let extra = (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0 | WS_EX_LAYERED.0) as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | extra);

        let color = DWMWA_COLOR_NONE;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            &color as *const u32 as *const _,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

/// macOS 등: 모든 데스크톱(Space)에 보이게 한다. 나머지는 tauri.conf.json 창 설정으로 충분하다.
#[cfg(not(windows))]
fn hide_window_chrome(window: &WebviewWindow) {
    let _ = window.set_visible_on_all_workspaces(true);
}

/// 화면 물리 px 커서 위치
#[cfg(windows)]
fn cursor_point(_app: &AppHandle) -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point) }.ok()?;
    Some((point.x, point.y))
}

#[cfg(not(windows))]
fn cursor_point(app: &AppHandle) -> Option<(i32, i32)> {
    let position = app.cursor_position().ok()?;
    Some((position.x.round() as i32, position.y.round() as i32))
}

fn poll_cursor(app: AppHandle, state: Arc<OverlayState>) {
    let mut last_point: Option<(i32, i32)> = None;
    let mut was_near = false;
    loop {
        thread::sleep(POLL_INTERVAL);

        let Some((point_x, point_y)) = cursor_point(&app) else {
            continue;
        };
        let geometry = *state.geometry.lock().unwrap();
        if geometry.scale <= 0.0 {
            continue;
        }
        let x = (point_x - geometry.x) as f64 / geometry.scale;
        let y = (point_y - geometry.y) as f64 / geometry.scale;
        let inside_window = point_x >= geometry.x
            && point_y >= geometry.y
            && point_x < geometry.x + geometry.width as i32
            && point_y < geometry.y + geometry.height as i32;
        let near = inside_window
            && state
                .interest
                .lock()
                .unwrap()
                .is_some_and(|rect| rect.contains(x, y));

        let moved = last_point != Some((point_x, point_y));
        if (near && moved) || near != was_near {
            if app.emit_to("main", "cursor", CursorPayload { x, y, near }).is_err() {
                break;
            }
        }
        last_point = Some((point_x, point_y));
        was_near = near;
    }
}

/// 클릭 통과 켜기/끄기.
///
/// tao는 이 전환 때마다 확장 스타일을 처음부터 다시 계산해서 우리가 붙인 스타일
/// (Alt+Tab 숨김, 테두리 없음)을 지운다. 그래서 전환 직후 같은 메인 스레드 큐에서 다시 붙인다.
/// 포커스를 뺏지 않는 WS_EX_NOACTIVATE는 tauri.conf.json의 `focusable: false`로 tao가 유지한다.
#[tauri::command]
pub fn set_click_through(window: WebviewWindow, ignore: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(ignore).map_err(|error| error.to_string())?;
    reapply_window_chrome(&window);
    Ok(())
}

/// 메인 스레드에서 창 스타일을 다시 붙인다 (tao의 스타일 갱신 뒤에 실행되도록 같은 큐에 넣음).
fn reapply_window_chrome(window: &WebviewWindow) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || hide_window_chrome(&target));
}

/// 캐릭터 주변 관심 영역. 이 영역 안에서만 커서 위치를 받는다.
#[tauri::command]
pub fn set_interest_rect(state: tauri::State<'_, Arc<OverlayState>>, rect: Option<CssRect>) {
    *state.interest.lock().unwrap() = rect;
}

/// 창 크기와 작업 영역(작업표시줄 제외)을 CSS px로 돌려준다.
#[tauri::command]
pub fn stage_info(window: WebviewWindow) -> Result<StageInfo, String> {
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("no monitor")?;
    let area = monitor.work_area();
    Ok(StageInfo {
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
        scale,
        work_area: CssRect {
            x: (area.position.x - position.x) as f64 / scale,
            y: (area.position.y - position.y) as f64 / scale,
            width: area.size.width as f64 / scale,
            height: area.size.height as f64 / scale,
        },
    })
}
