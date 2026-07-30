#!/bin/bash
set -e

# fetch-libmpv-windows.sh
# Downloads libmpv-2.dll + its runtime companion from shinchiro/mpv-winbuild-cmake
# for bundling in the Windows NSIS installer.

LIBMPV_VERSION="20260610"
LIBMPV_REVISION="304426c"
RELEASE_URL="https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/${LIBMPV_VERSION}"
LIBMPV_URL="${RELEASE_URL}/mpv-dev-x86_64-${LIBMPV_VERSION}-git-${LIBMPV_REVISION}.7z"
RUNTIME_URL="${RELEASE_URL}/mpv-x86_64-${LIBMPV_VERSION}-git-${LIBMPV_REVISION}.7z"

DEST_DIR="$(cd "$(dirname "$0")/../src-tauri/resources" && pwd)/libmpv"
mkdir -p "$DEST_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading libmpv for Windows..."
curl --fail --location --output "$TMP_DIR/libmpv.7z" "$LIBMPV_URL"
curl --fail --location --output "$TMP_DIR/runtime.7z" "$RUNTIME_URL"

echo "Extracting libmpv..."
7z e -y -o"$DEST_DIR" "$TMP_DIR/libmpv.7z" libmpv-2.dll
7z e -y -o"$DEST_DIR" "$TMP_DIR/runtime.7z" d3dcompiler_43.dll

if [ ! -s "$DEST_DIR/libmpv-2.dll" ]; then
    echo "libmpv-2.dll was not extracted" >&2
    exit 1
fi

# Ensure LICENSE exists
if [ ! -f "$DEST_DIR/LICENSE.libmpv.txt" ]; then
    echo "libmpv (GPL-2.0)" > "$DEST_DIR/LICENSE.libmpv.txt"
    echo "Downloaded from: $LIBMPV_URL" >> "$DEST_DIR/LICENSE.libmpv.txt"
fi

echo "libmpv installed to $DEST_DIR"
ls -la "$DEST_DIR"
