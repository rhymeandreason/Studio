use std::path::Path;
use std::process::Command;

fn main() {
    // Compile the Swift background-removal helper (macOS Vision framework) and
    // expose its path to the crate via BGREMOVE_BIN.
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR not set");
    let bin = Path::new(&out_dir).join("bgremove");
    let src = "swift/bgremove.swift";

    swiftc(src, &bin, "macosx14.0"); // Vision foreground mask needs macOS 14
    println!("cargo:rustc-env=BGREMOVE_BIN={}", bin.display());
    println!("cargo:rerun-if-changed={src}");

    // QuickLook thumbnail helper (any file type → PNG).
    let ql_src = "swift/qlthumb.swift";
    let ql_bin = Path::new(&out_dir).join("qlthumb");
    swiftc(ql_src, &ql_bin, "macosx11.0");
    println!("cargo:rustc-env=QLTHUMB_BIN={}", ql_bin.display());
    println!("cargo:rerun-if-changed={ql_src}");

    // Clipboard-image helper (NSPasteboard → PNG).
    let pb_src = "swift/pbimage.swift";
    let pb_bin = Path::new(&out_dir).join("pbimage");
    swiftc(pb_src, &pb_bin, "macosx11.0");
    println!("cargo:rustc-env=PBIMAGE_BIN={}", pb_bin.display());
    println!("cargo:rerun-if-changed={pb_src}");

    // Video exporter (AVFoundation composition + baked Core Animation text).
    let vid_src = "swift/vidExport.swift";
    let vid_bin = Path::new(&out_dir).join("vidExport");
    swiftc(vid_src, &vid_bin, "macosx14.0");
    println!("cargo:rustc-env=VIDEXPORT_BIN={}", vid_bin.display());
    println!("cargo:rerun-if-changed={vid_src}");

    // Video rotate helper (AVFoundation passthrough remux with a transform).
    let vrot_src = "swift/vidrotate.swift";
    let vrot_bin = Path::new(&out_dir).join("vidrotate");
    swiftc(vrot_src, &vrot_bin, "macosx11.0");
    println!("cargo:rustc-env=VIDROTATE_BIN={}", vrot_bin.display());
    println!("cargo:rerun-if-changed={vrot_src}");

    // App-icon helper (NSWorkspace icon → PNG), for Workspace app cards.
    let icon_src = "swift/appicon.swift";
    let icon_bin = Path::new(&out_dir).join("appicon");
    swiftc(icon_src, &icon_bin, "macosx11.0");
    println!("cargo:rustc-env=APPICON_BIN={}", icon_bin.display());
    println!("cargo:rerun-if-changed={icon_src}");

    // Window bounds helper (CGWindowListCopyWindowInfo → app,title,x,y,w,h).
    let wb_src = "swift/winbounds.swift";
    let wb_bin = Path::new(&out_dir).join("winbounds");
    swiftc(wb_src, &wb_bin, "macosx11.0");
    println!("cargo:rustc-env=WINBOUNDS_BIN={}", wb_bin.display());
    println!("cargo:rerun-if-changed={wb_src}");

    // Window layout helper (AXUIElement) — record/restore window positions
    // across apps for Workspace modes.
    let wl_src = "swift/winlayout.swift";
    let wl_bin = Path::new(&out_dir).join("winlayout");
    swiftc(wl_src, &wl_bin, "macosx11.0");
    println!("cargo:rustc-env=WINLAYOUT_BIN={}", wl_bin.display());
    println!("cargo:rerun-if-changed={wl_src}");

    // Calendar agenda helper (EventKit → today's events as JSON). macOS 14+
    // for requestFullAccessToEvents.
    let ag_src = "swift/dayagenda.swift";
    let ag_bin = Path::new(&out_dir).join("dayagenda");
    swiftc(ag_src, &ag_bin, "macosx14.0");
    println!("cargo:rustc-env=DAYAGENDA_BIN={}", ag_bin.display());
    println!("cargo:rerun-if-changed={ag_src}");

    // Calendar reader for Tasks (EventKit → next 7 days as rich JSON). macOS 14+
    // for requestFullAccessToEvents. See docs/tasks.md.
    let cr_src = "swift/calread.swift";
    let cr_bin = Path::new(&out_dir).join("calread");
    swiftc(cr_src, &cr_bin, "macosx14.0");
    println!("cargo:rustc-env=CALREAD_BIN={}", cr_bin.display());
    println!("cargo:rerun-if-changed={cr_src}");

    // Travel-time helper for in-person Tasks (CLGeocoder + MKDirections ETA).
    // See docs/tasks.md.
    let tr_src = "swift/transit.swift";
    let tr_bin = Path::new(&out_dir).join("transit");
    swiftc(tr_src, &tr_bin, "macosx11.0");
    println!("cargo:rustc-env=TRANSIT_BIN={}", tr_bin.display());
    println!("cargo:rerun-if-changed={tr_src}");

    // Mac Contacts export helper (Contacts framework → name/emails/phones
    // JSON), for Mycelium's "match Mac Contacts" feature.
    let cd_src = "swift/contactsdump.swift";
    let cd_bin = Path::new(&out_dir).join("contactsdump");
    swiftc(cd_src, &cd_bin, "macosx11.0");
    println!("cargo:rustc-env=CONTACTSDUMP_BIN={}", cd_bin.display());
    println!("cargo:rerun-if-changed={cd_src}");

    tauri_build::build();
}

fn swiftc(src: &str, bin: &Path, target: &str) {
    let status = Command::new("swiftc")
        .args(["-O", src, "-o"])
        .arg(bin)
        .args(["-target", &format!("arm64-apple-{target}")])
        .status()
        .expect("failed to invoke swiftc — are the Xcode command-line tools installed?");
    assert!(status.success(), "swiftc failed to build {src}");
}
