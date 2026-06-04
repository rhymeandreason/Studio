// Vendors the @imgly/background-removal lib + just the model/wasm it needs into
// src/vendor/imgly/ (gitignored). Run via `npm run setup:bg` (and postinstall).
//
// The lib bundle is self-contained; the model data lives on the imgly CDN as
// hash-named ~4MB chunks described by resources.json. We mirror one model
// (isnet_quint8) + the ONNX-runtime wasm so background removal works fully
// offline with no per-use download. Idempotent: existing chunks are skipped.

import fs from "node:fs";
import path from "node:path";

const LIB_PKG = JSON.parse(
  fs.readFileSync("node_modules/@imgly/background-removal/package.json", "utf8")
);
const VERSION = LIB_PKG.version;
const BASE = `https://staticimgly.com/@imgly/background-removal-data/${VERSION}/dist`;
const LIB_SRC = "node_modules/@imgly/background-removal/dist/index.mjs";

const OUT = "src/vendor/imgly";
const LIB_DIR = path.join(OUT, "lib");
const DATA_DIR = path.join(OUT, "data");

// Resources to vendor: one model + the ONNX-runtime wasm/loader.
const WANT = [
  "/models/isnet_quint8",
  "/onnxruntime-web/ort-wasm-simd-threaded.wasm",
  "/onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm",
  "/onnxruntime-web/ort-wasm-simd-threaded.mjs",
  "/onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs",
];

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function download(url, dest) {
  if (fs.existsSync(dest)) return false;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  return true;
}

async function main() {
  fs.mkdirSync(LIB_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // 1. Vendor the self-contained lib bundle.
  fs.copyFileSync(LIB_SRC, path.join(LIB_DIR, "index.mjs"));
  console.log(`[bg] lib: vendored ${VERSION} bundle`);

  // 2. Resources manifest.
  const res = await getJSON(`${BASE}/resources.json`);
  fs.writeFileSync(path.join(DATA_DIR, "resources.json"), JSON.stringify(res));

  // 3. Chunks for the wanted resources.
  let got = 0;
  let cached = 0;
  for (const key of WANT) {
    const entry = res[key];
    if (!entry) {
      console.warn(`[bg] ! not in manifest: ${key}`);
      continue;
    }
    for (const chunk of entry.chunks) {
      const wrote = await download(`${BASE}/${chunk.name}`, path.join(DATA_DIR, chunk.name));
      wrote ? got++ : cached++;
    }
  }
  console.log(`[bg] data: ${got} chunks downloaded, ${cached} cached`);
}

main().catch((err) => {
  // Don't fail `npm install` if offline — the model can be fetched later via
  // `npm run setup:bg`.
  console.warn(`[bg] setup skipped (${err.message}). Run 'npm run setup:bg' when online.`);
});
