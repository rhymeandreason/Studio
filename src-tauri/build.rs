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

    // App-icon helper (NSWorkspace icon → PNG), for Workspace app cards.
    let icon_src = "swift/appicon.swift";
    let icon_bin = Path::new(&out_dir).join("appicon");
    swiftc(icon_src, &icon_bin, "macosx11.0");
    println!("cargo:rustc-env=APPICON_BIN={}", icon_bin.display());
    println!("cargo:rerun-if-changed={icon_src}");

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
