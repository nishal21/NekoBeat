//! Windows taskbar playback progress. This module is never compiled elsewhere.

#![cfg(target_os = "windows")]

use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::Shell::{
    ITaskbarList3, TaskbarList, TBPF_ERROR, TBPF_NOPROGRESS, TBPF_NORMAL, TBPF_PAUSED,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowThreadProcessId,
};

unsafe extern "system" fn find_process_window(hwnd: HWND, data: LPARAM) -> BOOL {
    let mut process_id = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    if process_id == GetCurrentProcessId() && GetWindowTextLengthW(hwnd) > 0 {
        *(data.0 as *mut HWND) = hwnd;
        return BOOL(0);
    }
    BOOL(1)
}

fn main_window() -> Result<HWND, String> {
    let mut result = HWND(std::ptr::null_mut());
    unsafe {
        let _ = EnumWindows(
            Some(find_process_window),
            LPARAM((&mut result as *mut HWND) as isize),
        );
    }
    if result.0.is_null() {
        Err("NekoBeat window was not found".into())
    } else {
        Ok(result)
    }
}

#[tauri::command]
pub fn set_windows_taskbar_progress(
    state: String,
    completed: u64,
    total: u64,
) -> Result<(), String> {
    let hwnd = main_window()?;
    let progress_state = match state.as_str() {
        "none" => TBPF_NOPROGRESS,
        "normal" => TBPF_NORMAL,
        "paused" => TBPF_PAUSED,
        "error" => TBPF_ERROR,
        _ => return Err(format!("unsupported taskbar state: {state}")),
    };

    unsafe {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let result = (|| -> windows::core::Result<()> {
            let taskbar: ITaskbarList3 =
                CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)?;
            taskbar.HrInit()?;
            taskbar.SetProgressState(hwnd, progress_state)?;
            if progress_state != TBPF_NOPROGRESS {
                taskbar.SetProgressValue(hwnd, completed.min(total.max(1)), total.max(1))?;
            }
            Ok(())
        })();
        if initialized {
            CoUninitialize();
        }
        result.map_err(|error| format!("Windows taskbar progress: {error}"))
    }
}
