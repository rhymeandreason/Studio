use std::path::Path;
use std::process::Command;

fn main() {
    // Compile the Swift background-removal helper (macOS Vision framework) and
    // expose its path to the crate via BGREMOVE_BIN.
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR not set");
    let bin = Path::new(&out_dir).join("bgremove");
    let src = "swift/bgremove.swift";

    let status = Command::new("swiftc")
        .args(["-O", src, "-o"])
        .arg(&bin)
        .args(["-target", "arm64-apple-macosx14.0"])
        .status()
        .expect("failed to invoke swiftc — are the Xcode command-line tools installed?");
    assert!(status.success(), "swiftc failed to build {src}");

    println!("cargo:rustc-env=BGREMOVE_BIN={}", bin.display());
    println!("cargo:rerun-if-changed={src}");

    tauri_build::build();
}
