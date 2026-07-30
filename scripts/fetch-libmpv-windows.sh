#!/bin/bash
set -e

# fetch-libmpv-windows.sh
# Downloads libmpv-2.dll + dependencies from shinchiro/mpv-winbuild-cmake
# for bundling in the Windows NSIS installer.
#
# Uses `7z e` (extract without paths) to flatten all DLLs into a single
# directory, avoiding `find` which silently fails on some files under
# Git Bash on Windows (due to long paths or path encoding issues).

LIBMPV_VERSION="20260610"
LIBMPV_URL="https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/${LIBMPV_VERSION}/mpv-x86_64-${LIBMPV_VERSION}-git-304426c.7z"

DEST_DIR="$(cd "$(dirname "$0")/../src-tauri/resources" && pwd)/libmpv"
mkdir -p "$DEST_DIR"

cd /tmp
if [ ! -f "libmpv-windows.7z" ]; then
    echo "Downloading libmpv for Windows..."
    curl -L -o libmpv-windows.7z "$LIBMPV_URL"
fi

echo "Extracting libmpv..."
# Use `7z e` (extract without directory paths) to flatten all DLLs
# into DEST_DIR. This avoids the `find` command which fails silently
# on some files under Git Bash on Windows.
7z e -y -o"$DEST_DIR" libmpv-windows.7z -aoa "*.dll" 2>/dev/null || {
    echo "DLL extraction with filter failed, trying full extraction..."
    7z x -y -olibmpv-extract libmpv-windows.7z 2>/dev/null
    # Fallback: manually copy DLLs if 7z e filter didn't work
    if [ -d "libmpv-extract" ]; then
        cp -f libmpv-extract/**/*.dll "$DEST_DIR/" 2>/dev/null || true
        cp -f libmpv-extract/*/*.dll "$DEST_DIR/" 2>/dev/null || true
        rm -rf libmpv-extract
    fi
}

# Ensure LICENSE exists
if [ ! -f "$DEST_DIR/LICENSE.libmpv.txt" ]; then
    echo "libmpv (GPL-2.0)" > "$DEST_DIR/LICENSE.libmpv.txt"
    echo "Downloaded from: $LIBMPV_URL" >> "$DEST_DIR/LICENSE.libmpv.txt"
fi

# Cleanup
rm -f /tmp/libmpv-windows.7z

echo "libmpv installed to $DEST_DIR"
ls -la "$DEST_DIR"
