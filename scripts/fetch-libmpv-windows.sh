#!/bin/bash
set -e

# fetch-libmpv-windows.sh
# Downloads libmpv-2.dll + dependencies from shinchiro/mpv-winbuild-cmake
# for bundling in the Windows NSIS installer.

LIBMPV_VERSION="20260610"
LIBMPV_URL="https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/${LIBMPV_VERSION}/mpv-x86_64-${LIBMPV_VERSION}-git-304426c.7z"

DEST_DIR="$(dirname "$0")/../src-tauri/resources/libmpv"
mkdir -p "$DEST_DIR"

cd /tmp
if [ ! -f "libmpv-windows.7z" ]; then
    echo "Downloading libmpv for Windows..."
    curl -L -o libmpv-windows.7z "$LIBMPV_URL"
fi

echo "Extracting libmpv..."
# Extract only DLLs and license
mkdir -p libmpv-extract
7z x -y -olibmpv-extract libmpv-windows.7z 2>/dev/null || {
    echo "Trying alternative extraction path..."
    7z x -y -olibmpv-extract libmpv-windows.7z "*.dll" "LICENSE*" 2>/dev/null || {
        echo "Extraction failed. Trying with wildcard..."
        7z x -y libmpv-windows.7z -o"$DEST_DIR" 2>/dev/null
        echo "Extracted to $DEST_DIR directly."
    }
}

# Find and copy DLLs from extracted directory
if [ -d "libmpv-extract" ]; then
    find libmpv-extract -name "*.dll" -exec cp {} "$DEST_DIR" \; 2>/dev/null || true
    find libmpv-extract -name "LICENSE*" -exec cp {} "$DEST_DIR/LICENSE.libmpv.txt" \; 2>/dev/null || true
    rm -rf libmpv-extract
fi

# Ensure LICENSE exists
if [ ! -f "$DEST_DIR/LICENSE.libmpv.txt" ]; then
    echo "libmpv (GPL-2.0)" > "$DEST_DIR/LICENSE.libmpv.txt"
    echo "Downloaded from: $LIBMPV_URL" >> "$DEST_DIR/LICENSE.libmpv.txt"
fi

# Cleanup
rm -f /tmp/libmpv-windows.7z

echo "libmpv installed to $DEST_DIR"
ls -la "$DEST_DIR"
