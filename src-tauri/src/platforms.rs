//! 창 발판: 보이는 최상위 창의 사각형을 앞 → 뒤 순서로 모아 웹뷰에 보낸다.
//! 같은 창 목록으로 전체화면(게임·영상)도 판정해서 바뀔 때 `fullscreen`을 보낸다.
//!
//! 가려짐 계산(실제로 보이는 위쪽 테두리 구간)과 착지·따라가기는 웹뷰의
//! `behavior/platforms.ts`가 한다 (Node에서 테스트할 수 있게). 여기서는 창 목록만.
//!
//! 이벤트 훅 대신 폴링한다. 창 목록 수집은 수십 개 창 기준 1ms 안팎이고,
//! 바뀌었을 때만 보낸다. 캐릭터가 창 위에 있을 때만 빠르게(8ms) 돌아서 창을 따라간다.
//! (33ms면 60fps 렌더에서 창 위치가 두 프레임에 한 번만 바뀌어 캐릭터가 계단식으로 끊겨 따라갔다.)

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::overlay::OverlayState;

const SLOW_INTERVAL: Duration = Duration::from_millis(150);
const FAST_INTERVAL: Duration = Duration::from_millis(8);
/// 이보다 작은 창(CSS px)은 발판으로 쓰지 않는다 (툴팁, 작은 팝업)
const MIN_SIZE: f64 = 80.0;
/// 전체화면 판정이 이만큼 연속으로 같아야 바꾼다 (창 전환 중 잠깐 덮는 순간에 깜빡이지 않게)
const FULLSCREEN_SETTLE_POLLS: u32 = 2;
/// 모니터를 덮었다고 볼 여유 (CSS px)
const COVER_SLACK: f64 = 2.0;

/// 웹뷰 좌표(CSS px, 오버레이 창 왼쪽 위 기준) 창 사각형
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct WindowRect {
    id: u64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// 플랫폼 API가 돌려주는 화면 좌표 사각형.
/// Windows는 물리 px, macOS는 포인트(논리 px, 주 화면 왼쪽 위 기준)다.
#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
struct NativeWindow {
    id: u64,
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
    /// 항상 위 창 (Windows). 전체화면 판정에서 이런 창이 앞에 떠 있어도 건너뛴다 (PIP·스티커 메모 등)
    topmost: bool,
}

/// 한 번 훑은 결과
struct Scan {
    /// 앞 → 뒤
    windows: Vec<NativeWindow>,
    /// 운영체제가 직접 알려 주는 전체화면 (Windows: D3D 독점 전체화면·프레젠테이션 모드)
    system_fullscreen: bool,
    /// 오버레이 창이 지금 화면에 없다 (macOS: 다른 앱의 전체화면 Space로 넘어가면 오버레이는 그 Space에 안 뜬다)
    overlay_off_screen: bool,
}

#[derive(Default)]
pub struct PlatformState {
    fast: AtomicBool,
    fullscreen: AtomicBool,
}

pub fn install(app: &AppHandle) {
    let state = Arc::new(PlatformState::default());
    app.manage(state.clone());
    let poll_app = app.clone();
    thread::Builder::new()
        .name("platform-poll".into())
        .spawn(move || poll(poll_app, state))
        .expect("platform poll thread");
}

fn poll(app: AppHandle, state: Arc<PlatformState>) {
    let mut last: Option<Vec<WindowRect>> = None;
    // 판정이 바뀐 뒤 같은 값이 연속으로 나온 횟수
    let mut settle = 0u32;
    loop {
        let fast = state.fast.load(Ordering::Relaxed);
        thread::sleep(if fast { FAST_INTERVAL } else { SLOW_INTERVAL });

        let overlay = app.state::<Arc<OverlayState>>();
        let (origin_x, origin_y, scale) = overlay.origin();
        if scale <= 0.0 {
            continue;
        }
        let screen = overlay.monitor().map(|monitor| monitor_css(monitor, origin_x, origin_y, scale));
        let scan = native::scan();

        let mut covered = false;
        let mut decided = false;
        let mut windows: Vec<WindowRect> = Vec::new();
        for window in scan.windows {
            let topmost = window.topmost;
            let rect = to_css(window, origin_x, origin_y, scale);
            if rect.width < MIN_SIZE || rect.height < MIN_SIZE {
                continue;
            }
            // 맨 앞 창(항상 위 창은 건너뜀)이 모니터를 통째로 덮으면 전체화면
            if !decided {
                if screen.as_ref().is_some_and(|screen| covers(&rect, screen)) {
                    covered = true;
                    decided = true;
                } else if !topmost {
                    decided = true;
                }
            }
            windows.push(rect);
        }
        if last.as_ref() != Some(&windows) {
            if app.emit_to("main", "windows", &windows).is_err() {
                break;
            }
            last = Some(windows);
        }

        let fullscreen = covered || scan.system_fullscreen || scan.overlay_off_screen;
        if fullscreen == state.fullscreen.load(Ordering::Relaxed) {
            settle = 0;
            continue;
        }
        settle += 1;
        if settle >= FULLSCREEN_SETTLE_POLLS {
            settle = 0;
            state.fullscreen.store(fullscreen, Ordering::Relaxed);
            if app.emit_to("main", "fullscreen", fullscreen).is_err() {
                break;
            }
        }
    }
}

/// 모니터 전체(물리 px) → 오버레이 기준 CSS px
fn monitor_css(monitor: (i32, i32, u32, u32, f64), origin_x: i32, origin_y: i32, scale: f64) -> WindowRect {
    let (x, y, width, height, monitor_scale) = monitor;
    // macOS 창 목록은 포인트 단위라 같은 단위로 맞춘다
    let native = if cfg!(target_os = "macos") {
        let points = monitor_scale.max(0.1);
        NativeWindow {
            id: 0,
            left: x as f64 / points,
            top: y as f64 / points,
            right: (x as f64 + width as f64) / points,
            bottom: (y as f64 + height as f64) / points,
            topmost: false,
        }
    } else {
        NativeWindow {
            id: 0,
            left: x as f64,
            top: y as f64,
            right: x as f64 + width as f64,
            bottom: y as f64 + height as f64,
            topmost: false,
        }
    };
    to_css(native, origin_x, origin_y, scale)
}

fn covers(window: &WindowRect, screen: &WindowRect) -> bool {
    window.x <= screen.x + COVER_SLACK
        && window.y <= screen.y + COVER_SLACK
        && window.x + window.width >= screen.x + screen.width - COVER_SLACK
        && window.y + window.height >= screen.y + screen.height - COVER_SLACK
}

/// 화면 좌표 → 오버레이 기준 CSS px. 오버레이 원점(`origin`)은 tauri의 물리 px다.
fn to_css(window: NativeWindow, origin_x: i32, origin_y: i32, scale: f64) -> WindowRect {
    let (x, y, width, height) = if cfg!(target_os = "macos") {
        let left = window.left - origin_x as f64 / scale;
        let top = window.top - origin_y as f64 / scale;
        (left, top, window.right - window.left, window.bottom - window.top)
    } else {
        let left = (window.left - origin_x as f64) / scale;
        let top = (window.top - origin_y as f64) / scale;
        (left, top, (window.right - window.left) / scale, (window.bottom - window.top) / scale)
    };
    WindowRect { id: window.id, x, y, width, height }
}

/// 캐릭터가 창 위에 있으면 빠르게 폴링해서 창을 따라간다.
#[tauri::command]
pub fn set_platform_rate(state: tauri::State<'_, Arc<PlatformState>>, fast: bool) {
    state.fast.store(fast, Ordering::Relaxed);
}

/// 지금 전체화면인지 (웹뷰가 새로 시작할 때 한 번 묻는다. 그 뒤로는 `fullscreen` 이벤트)
#[tauri::command]
pub fn fullscreen_state(state: tauri::State<'_, Arc<PlatformState>>) -> bool {
    state.fullscreen.load(Ordering::Relaxed)
}

#[cfg(windows)]
mod native {
    use super::{NativeWindow, Scan};
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowLongPtrW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        GWL_EXSTYLE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    };

    pub fn scan() -> Scan {
        // QUNS_BUSY(테두리 없는 전체화면 창)는 어느 모니터인지 모르므로 창 사각형으로 따로 판정한다.
        // 여기서는 창 목록으로는 안 잡히는 D3D 독점 전체화면과 프레젠테이션 모드만 본다.
        let state = unsafe { SHQueryUserNotificationState() };
        let system_fullscreen = state.is_ok_and(|state| state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE);
        Scan { windows: list(), system_fullscreen, overlay_off_screen: false }
    }

    /// 바탕화면·작업표시줄은 발판이 아니다 (작업표시줄 위는 작업 영역 바닥으로 따로 처리).
    const SHELL_CLASSES: [&str; 4] = ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

    /// EnumWindows는 Z 순서(앞 → 뒤)로 최상위 창을 나열한다.
    fn list() -> Vec<NativeWindow> {
        let mut windows: Vec<NativeWindow> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(collect), LPARAM(&mut windows as *mut Vec<NativeWindow> as isize));
        }
        windows
    }

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let windows = &mut *(lparam.0 as *mut Vec<NativeWindow>);
        if let Some(window) = inspect(hwnd) {
            windows.push(window);
        }
        BOOL(1)
    }

    unsafe fn inspect(hwnd: HWND) -> Option<NativeWindow> {
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return None;
        }
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if style & WS_EX_TOOLWINDOW.0 != 0 {
            return None;
        }
        let mut process = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut process));
        if process == std::process::id() {
            return None;
        }
        // 다른 가상 데스크톱, 숨겨진 UWP 창
        let mut cloaked = 0u32;
        let size = std::mem::size_of::<u32>() as u32;
        if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, size).is_ok() && cloaked != 0 {
            return None;
        }
        let mut class = [0u16; 64];
        let length = GetClassNameW(hwnd, &mut class) as usize;
        let class = String::from_utf16_lossy(&class[..length]);
        if SHELL_CLASSES.contains(&class.as_str()) {
            return None;
        }
        // 그림자를 뺀 실제 창 영역 (물리 px)
        let mut rect = RECT::default();
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
        .ok()?;
        Some(NativeWindow {
            id: hwnd.0 as usize as u64,
            left: rect.left as f64,
            top: rect.top as f64,
            right: rect.right as f64,
            bottom: rect.bottom as f64,
            topmost: style & WS_EX_TOPMOST.0 != 0,
        })
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::{NativeWindow, Scan};
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::geometry::CGRect;
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
    };

    /// CGWindowList는 앞 → 뒤 순서다. 창 사각형·레이어·PID는 화면 기록 권한 없이 읽힌다.
    ///
    /// 오버레이는 모든 Space에 뜨지만 다른 앱의 전체화면 Space에는 뜨지 않는다 (fullScreenAuxiliary 아님).
    /// 그래서 "화면에 있는 창" 목록에 우리 오버레이(레이어 0이 아닌 우리 창)가 없으면 전체화면으로 본다.
    pub fn scan() -> Scan {
        let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
        let Some(info) = copy_window_info(options, kCGNullWindowID) else {
            return Scan { windows: Vec::new(), system_fullscreen: false, overlay_off_screen: false };
        };
        let own = std::process::id() as i64;
        let mut overlay_seen = false;
        let mut windows = Vec::new();
        for item in info.iter() {
            let dictionary: CFDictionary<CFString, CFType> =
                unsafe { CFDictionary::wrap_under_get_rule(*item as CFDictionaryRef) };
            let owner = number(&dictionary, "kCGWindowOwnerPID").map(|pid| pid as i64);
            let layer = number(&dictionary, "kCGWindowLayer");
            if owner == Some(own) && layer.is_some_and(|layer| layer != 0.0) {
                overlay_seen = true;
            }
            if let Some(window) = inspect(&dictionary, own) {
                windows.push(window);
            }
        }
        Scan { windows, system_fullscreen: false, overlay_off_screen: !overlay_seen }
    }

    fn number(dictionary: &CFDictionary<CFString, CFType>, key: &'static str) -> Option<f64> {
        dictionary
            .find(CFString::from_static_string(key))?
            .downcast::<CFNumber>()?
            .to_f64()
    }

    fn inspect(dictionary: &CFDictionary<CFString, CFType>, own: i64) -> Option<NativeWindow> {
        // 레이어 0 = 일반 앱 창 (메뉴 막대·Dock·알림은 0보다 크다)
        if number(dictionary, "kCGWindowLayer")? != 0.0 {
            return None;
        }
        if number(dictionary, "kCGWindowOwnerPID")? as i64 == own {
            return None;
        }
        if number(dictionary, "kCGWindowAlpha").unwrap_or(1.0) <= 0.01 {
            return None;
        }
        let bounds = dictionary
            .find(CFString::from_static_string("kCGWindowBounds"))?
            .downcast::<CFDictionary>()?;
        let rect = CGRect::from_dict_representation(&bounds)?;
        Some(NativeWindow {
            id: number(dictionary, "kCGWindowNumber")? as u64,
            left: rect.origin.x,
            top: rect.origin.y,
            right: rect.origin.x + rect.size.width,
            bottom: rect.origin.y + rect.size.height,
            topmost: false,
        })
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod native {
    use super::Scan;

    pub fn scan() -> Scan {
        Scan { windows: Vec::new(), system_fullscreen: false, overlay_off_screen: false }
    }
}
