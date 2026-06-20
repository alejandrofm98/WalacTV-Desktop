# High DPI / 2K Scaling Support (Design Spec)

## Overview
The application currently defaults to a 1280x720 window and relies on a hardcoded 15px base font size. On High DPI displays (like 2K/1440p and 4K monitors on Linux), the UI appears too small. This spec outlines a hybrid automatic scaling approach that adjusts both the native window and the web UI to provide an optimal out-of-the-box experience.

## Architecture & Changes

### 1. Backend (Rust / Tauri)
- **Automatic Monitor Detection:** On application startup, the app will query the current monitor using `window.current_monitor()`.
- **Dynamic Window Sizing:** Instead of hardcoding 1280x720, the app will calculate a default window size (e.g., 70-80% of the monitor's dimensions) clamped to reasonable minimums.
- **Webview Zoom Injection:** Tauri allows setting the zoom factor of the underlying webview. We will detect the monitor's `scale_factor` and apply it automatically to the webview window using Tauri's API (e.g., `window.set_zoom()` or by applying it during window creation).
- **Expose Scale Information:** Expose a Tauri command `get_scale_info` that returns the detected scale factor and monitor resolution, in case the frontend needs to make further granular adjustments.

### 2. Frontend (React / CSS)
- **Dynamic CSS Variables:** In the initialization phase (`App.tsx`), fetch the scale info from Rust.
- **Root Font Size:** Apply the scale factor to the root `font-size` via CSS custom properties. For example:
  ```css
  :root {
    --app-scale: 1;
    font-size: calc(15px * var(--app-scale));
  }
  ```
  *(Note: Setting webview zoom from Rust might already scale everything perfectly. The CSS variable serves as a fallback or complementary adjustment for components that use `rem`.)*
- **CSS Review:** Ensure no hardcoded `px` values explicitly break the layout when the base font-size or webview zoom increases.

### 3. Error Handling & Fallbacks
- If monitor detection fails (which can happen in some headless Linux window managers), the system will gracefully fallback to `scale_factor = 1.0` and `1280x720` dimensions.
- No crashes should occur if Tauri cannot set the webview zoom.

## Scope
This design is strictly focused on resolving the high DPI scaling issue. It does not introduce new UI features or a settings menu for manual scaling (as per user preference for automatic detection).
