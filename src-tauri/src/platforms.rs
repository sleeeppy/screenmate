//! 창 발판: 보이는 최상위 창의 사각형을 앞 → 뒤 순서로 모아 웹뷰에 보낸다.
//!
//! 가려짐 계산(실제로 보이는 위쪽 테두리 구간)과 착지·따라가기는 웹뷰의
//! `behavior/platforms.ts`가 한다 (Node에서 테스트할 수 있게). 여기서는 창 목록만.
//!
//! 이벤트 훅 대신 폴링한다. 창 목록 수집은 수십 개 창 기준 1ms 안팎이고,
//! 바뀌었을 때만 보낸다. 캐릭터가 창 위에 있을 때만 빠르게(30Hz) 돌아서 창을 따라간다.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::overlay::OverlayState;

const SLOW_INTERVAL: Duration = Duration::from_millis(150);
const FAST_INTERVAL: Duration = Duration::from_millis(33);
/// 이보다 작은 창(CSS px)은 발판으로 쓰지 않는다 (툴팁, 작은 팝업)
const MIN_SIZE: f64 = 80.0;

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
}

#[derive(Default)]
pub struct PlatformState {
    fast: AtomicBool,
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
    loop {
        let fast = state.fast.load(Ordering::Relaxed);
        thread::sleep(if fast { FAST_INTERVAL } else { SLOW_INTERVAL });

        let (origin_x, origin_y, scale) = app.state::<Arc<OverlayState>>().origin();
        if scale <= 0.0 {
            continue;
        }
        let windows: Vec<WindowRect> = native::list()
            .into_iter()
            .map(|window| to_css(window, origin_x, origin_y, scale))
            .filter(|rect| rect.width >= MIN_SIZE && rect.height >= MIN_SIZE)
            .collect();
        if last.as_ref() != Some(&windows) {
            if app.emit_to("main", "windows", &windows).is_err() {
                break;
            }
            last = Some(windows);
        }
    }
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

#[cfg(windows)]
mod native {
    use super::NativeWindow;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowLongPtrW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };

    /// 바탕화면·작업표시줄은 발판이 아니다 (작업표시줄 위는 작업 영역 바닥으로 따로 처리).
    const SHELL_CLASSES: [&str; 4] = ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

    /// EnumWindows는 Z 순서(앞 → 뒤)로 최상위 창을 나열한다.
    pub fn list() -> Vec<NativeWindow> {
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
        })
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::NativeWindow;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::geometry::CGRect;
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
    };

    /// CGWindowList는 앞 → 뒤 순서다. 창 사각형·레이어·PID는 화면 기록 권한 없이 읽힌다.
    pub fn list() -> Vec<NativeWindow> {
        let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
        let Some(info) = copy_window_info(options, kCGNullWindowID) else {
            return Vec::new();
        };
        let own = std::process::id() as i64;
        info.iter()
            .filter_map(|item| {
                let dictionary: CFDictionary<CFString, CFType> =
                    unsafe { CFDictionary::wrap_under_get_rule(*item as CFDictionaryRef) };
                inspect(&dictionary, own)
            })
            .collect()
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
        })
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod native {
    use super::NativeWindow;

    pub fn list() -> Vec<NativeWindow> {
        Vec::new()
    }
}
