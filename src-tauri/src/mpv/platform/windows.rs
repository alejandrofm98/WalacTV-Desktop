//! Windows-specific support for mpv HWND embedding.

use std::ffi::c_void;

type Hwnd = *mut c_void;
type Bool = i32;

const HWND_TOP: Hwnd = std::ptr::null_mut();
const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_SHOWWINDOW: u32 = 0x0040;

struct ChildList {
    parent: Hwnd,
    handles: Vec<isize>,
}

#[link(name = "user32")]
extern "system" {
    fn EnumChildWindows(
        parent: Hwnd,
        callback: Option<unsafe extern "system" fn(Hwnd, isize) -> Bool>,
        data: isize,
    ) -> Bool;
    fn GetClassNameW(window: Hwnd, class_name: *mut u16, max_count: i32) -> i32;
    fn GetParent(window: Hwnd) -> Hwnd;
    fn SetWindowPos(
        window: Hwnd,
        insert_after: Hwnd,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        flags: u32,
    ) -> Bool;
}

unsafe extern "system" fn collect_direct_child(window: Hwnd, data: isize) -> Bool {
    let list = &mut *(data as *mut ChildList);
    if GetParent(window) == list.parent {
        list.handles.push(window as isize);
    }
    1
}

fn child_hwnds(parent: i64) -> Result<Vec<isize>, String> {
    let mut list = ChildList {
        parent: parent as Hwnd,
        handles: Vec::new(),
    };
    let result = unsafe {
        EnumChildWindows(
            list.parent,
            Some(collect_direct_child),
            &mut list as *mut ChildList as isize,
        )
    };
    if result == 0 {
        Err("EnumChildWindows failed".to_string())
    } else {
        Ok(list.handles)
    }
}

pub fn snapshot_child_hwnds(parent: i64) -> Result<Vec<isize>, String> {
    child_hwnds(parent)
}

fn window_class(window: isize) -> String {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetClassNameW(window as Hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
}

pub fn raise_mpv_child(parent: i64, previous: &[isize]) -> Result<bool, String> {
    let new_children: Vec<_> = child_hwnds(parent)?
        .into_iter()
        .filter(|window| !previous.contains(window))
        .collect();

    if new_children.is_empty() {
        return Ok(false);
    }

    let mpv_children: Vec<_> = new_children
        .iter()
        .copied()
        .filter(|window| window_class(*window).to_ascii_lowercase().contains("mpv"))
        .collect();
    let targets = if mpv_children.is_empty() {
        vec![*new_children.last().expect("new_children is not empty")]
    } else {
        mpv_children
    };

    let mut raised = false;
    for window in targets {
        let result = unsafe {
            SetWindowPos(
                window as Hwnd,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
        };
        raised |= result != 0;
    }

    if raised {
        Ok(true)
    } else {
        Err("SetWindowPos failed for the mpv child window".to_string())
    }
}
