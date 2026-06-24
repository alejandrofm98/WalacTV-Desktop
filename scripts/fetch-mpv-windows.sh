#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOURCES_DIR="$SCRIPT_DIR/../src-tauri/resources/mpv"

TAG="20260610"
ASSET="mpv-x86_64-20260610-git-304426c.7z"
URL="https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/${TAG}/${ASSET}"

if [ -f "$RESOURCES_DIR/mpv.exe" ]; then
  echo "mpv.exe ya presente en $RESOURCES_DIR. Omitiendo descarga."
  exit 0
fi

mkdir -p "$RESOURCES_DIR"
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

echo "Descargando mpv $TAG..."
curl -fL "$URL" -o "$TMPDIR/mpv.7z"

echo "Extrayendo..."
7z x "$TMPDIR/mpv.7z" -o"$TMPDIR/extracted" > /dev/null

MPV_DIR="$(dirname "$(find "$TMPDIR/extracted" -name 'mpv.exe' -type f | head -1)")"
if [ -z "$MPV_DIR" ]; then
  echo "ERROR: no se encontro mpv.exe en el archivo extraido."
  exit 1
fi

cp "$MPV_DIR"/*.exe "$MPV_DIR"/*.dll "$RESOURCES_DIR/" 2>/dev/null
cp "$MPV_DIR/LICENSE" "$RESOURCES_DIR/LICENSE.mpv.txt" 2>/dev/null || \
  cp "$MPV_DIR/COPYING" "$RESOURCES_DIR/LICENSE.mpv.txt" 2>/dev/null || true

echo "mpv $TAG extraido a $RESOURCES_DIR"
