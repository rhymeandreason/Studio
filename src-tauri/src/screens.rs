//! Screen geometry for moving between displays (big display ↔ bare laptop).
//!
//! Two jobs, both working in global *logical points* (the coordinate space
//! AX/CGWindowList and `winlayout` use: origin top-left of the primary
//! display):
//!
//! - **Fit a saved Mode layout** to the screens attached now: each recorded
//!   window remembers the work area of the screen it was on (`screen`); on
//!   replay, if that screen isn't attached, its frame is scaled
//!   proportionally into the current screen that best overlaps it, then
//!   clamped so it's fully visible. Layouts recorded before `screen` existed
//!   fall back to the bounding box of all their windows as the source.
//! - **Keep Studio's own windows on screen** when a display is unplugged:
//!   macOS moves windows onto the remaining screen but never shrinks them, so
//!   a watcher pulls any overflowing Studio window back inside (and shrinks
//!   it if it's bigger than the screen).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn overlap(&self, o: &Rect) -> f64 {
        let w = (self.x + self.w).min(o.x + o.w) - self.x.max(o.x);
        let h = (self.y + self.h).min(o.y + o.h) - self.y.max(o.y);
        w.max(0.0) * h.max(0.0)
    }

    /// Fully inside `o`, with a couple of points of slack for rounding.
    fn within(&self, o: &Rect) -> bool {
        const SLACK: f64 = 2.0;
        self.x >= o.x - SLACK
            && self.y >= o.y - SLACK
            && self.x + self.w <= o.x + o.w + SLACK
            && self.y + self.h <= o.y + o.h + SLACK
    }

    fn center_in(&self, o: &Rect) -> bool {
        let (cx, cy) = (self.x + self.w / 2.0, self.y + self.h / 2.0);
        cx >= o.x && cx < o.x + o.w && cy >= o.y && cy < o.y + o.h
    }

    /// Shrink to fit inside `area`, then slide in from whichever edge it
    /// overflows. Never grows or moves a window that already fits.
    pub fn clamp_into(&self, area: &Rect) -> Rect {
        let w = self.w.min(area.w);
        let h = self.h.min(area.h);
        let x = self.x.min(area.x + area.w - w).max(area.x);
        let y = self.y.min(area.y + area.h - h).max(area.y);
        Rect { x, y, w, h }
    }
}

/// Work areas (minus menu bar / macOS Dock) of every attached screen, in
/// logical points. Tauri reports monitors in physical pixels scaled by each
/// monitor's own factor, so divide per monitor.
pub fn work_areas(app: &AppHandle) -> Vec<Rect> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let s = m.scale_factor();
            let a = m.work_area();
            Rect {
                x: a.position.x as f64 / s,
                y: a.position.y as f64 / s,
                w: a.size.width as f64 / s,
                h: a.size.height as f64 / s,
            }
        })
        .collect()
}

/// The screen a window is "on" at record time: the one holding its center,
/// else the one it overlaps most.
pub fn screen_of(r: &Rect, screens: &[Rect]) -> Option<Rect> {
    screens
        .iter()
        .find(|s| r.center_in(s))
        .or_else(|| {
            screens
                .iter()
                .max_by(|a, b| r.overlap(a).total_cmp(&r.overlap(b)))
        })
        .copied()
}

/// Map `r` (recorded on screen `src`) onto the current `screens`. If `src`
/// is still attached, only clamp; otherwise scale proportionally from `src`
/// into the current screen overlapping it most (the first screen if none
/// do), then clamp. Scaling never takes the width below `min_w` (or the
/// recorded width, if that was already narrower) — small tool windows don't
/// need to shrink.
pub fn fit(r: &Rect, src: &Rect, screens: &[Rect], min_w: f64) -> Rect {
    let Some(first) = screens.first() else { return *r };
    if let Some(same) = screens.iter().find(|s| src.within(s)) {
        return r.clamp_into(same);
    }
    let dst = screens
        .iter()
        .filter(|s| src.overlap(s) > 0.0)
        .max_by(|a, b| src.overlap(a).total_cmp(&src.overlap(b)))
        .unwrap_or(first);
    let (sx, sy) = (dst.w / src.w.max(1.0), dst.h / src.h.max(1.0));
    Rect {
        x: dst.x + (r.x - src.x) * sx,
        y: dst.y + (r.y - src.y) * sy,
        w: (r.w * sx).max(r.w.min(min_w)),
        h: r.h * sy,
    }
    .clamp_into(dst)
}

/// Bounding box of a set of frames — the stand-in source screen for layouts
/// recorded before each window stored its own.
pub fn bounds(rects: &[Rect]) -> Option<Rect> {
    let first = rects.first()?;
    let (mut x0, mut y0) = (first.x, first.y);
    let (mut x1, mut y1) = (first.x + first.w, first.y + first.h);
    for r in &rects[1..] {
        x0 = x0.min(r.x);
        y0 = y0.min(r.y);
        x1 = x1.max(r.x + r.w);
        y1 = y1.max(r.y + r.h);
    }
    Some(Rect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
}

/// Windows that place themselves (or deliberately sit outside the work
/// area) — never clamp these.
const SELF_PLACED: &[&str] = &["spotlight", "mode-switcher", crate::dock::DOCK_LABEL];

/// Pull every visible Studio window fully onto the screen it's mostly on,
/// shrinking it if needed. Windows that already fit are left alone.
pub fn clamp_studio_windows(app: &AppHandle) {
    let screens = work_areas(app);
    for (label, win) in app.webview_windows() {
        if SELF_PLACED.contains(&label.as_str()) || !win.is_visible().unwrap_or(false) {
            continue;
        }
        let (Ok(pos), Ok(outer), Ok(inner), Ok(s)) =
            (win.outer_position(), win.outer_size(), win.inner_size(), win.scale_factor())
        else {
            continue;
        };
        let r = Rect {
            x: pos.x as f64 / s,
            y: pos.y as f64 / s,
            w: outer.width as f64 / s,
            h: outer.height as f64 / s,
        };
        let Some(area) = screen_of(&r, &screens) else { continue };
        if r.within(&area) {
            continue;
        }
        let c = r.clamp_into(&area);
        // set_size takes the inner (content) size; keep the title-bar delta.
        let chrome_h = (outer.height as f64 - inner.height as f64) / s;
        let _ = win.set_size(tauri::LogicalSize::new(c.w, (c.h - chrome_h).max(80.0)));
        let _ = win.set_position(tauri::LogicalPosition::new(c.x, c.y));
    }
}

/// Watch for displays being attached/detached (a cheap poll of the monitor
/// list — Tauri has no display-change event) and re-clamp Studio's windows
/// once macOS has finished shuffling them.
pub fn start_display_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let signature = |app: &AppHandle| {
            let mut v: Vec<String> = work_areas(app)
                .iter()
                .map(|r| format!("{:.0},{:.0},{:.0},{:.0}", r.x, r.y, r.w, r.h))
                .collect();
            v.sort();
            v.join("|")
        };
        let mut last = signature(&app);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let now = signature(&app);
            if now != last && !now.is_empty() {
                last = now;
                std::thread::sleep(std::time::Duration::from_millis(800));
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || clamp_studio_windows(&handle));
            }
        }
    });
}
