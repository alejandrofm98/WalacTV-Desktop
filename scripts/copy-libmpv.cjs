/**
 * copy-libmpv.js
 *
 * Cross-platform helper that copies libmpv DLLs from
 * src-tauri/resources/libmpv/ into the frontend dist/ directory
 * so Tauri's bundler picks them up as part of frontendDist.
 *
 * This avoids tauri-codegen's `resources` glob processing on Windows,
 * which fails with os error 123 (ERROR_INVALID_NAME) for certain
 * file patterns.
 *
 * Runs as part of tauri.conf.json -> build.beforeBundleCommand,
 * after the Rust build and after `pnpm build` creates the dist/ directory.
 * No-op when no .dll files are found (e.g. on Linux/macOS).
 */
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src-tauri', 'resources', 'libmpv');
const destDir = path.join(__dirname, '..', 'dist');

if (!fs.existsSync(srcDir)) {
  console.log('[copy-libmpv] Source directory not found, skipping.');
  process.exit(0);
}

if (!fs.existsSync(destDir)) {
  console.log('[copy-libmpv] dist/ not found, skipping.');
  process.exit(0);
}

let count = 0;
const entries = fs.readdirSync(srcDir);
for (const entry of entries) {
  if (entry.toLowerCase().endsWith('.dll')) {
    const src = path.join(srcDir, entry);
    const dest = path.join(destDir, entry);
    fs.copyFileSync(src, dest);
    console.log(`[copy-libmpv] Copied ${entry}`);
    count++;
  }
}

if (count === 0) {
  console.log('[copy-libmpv] No .dll files found, skipping.');
} else {
  console.log(`[copy-libmpv] Copied ${count} DLL(s) to dist/`);
}
