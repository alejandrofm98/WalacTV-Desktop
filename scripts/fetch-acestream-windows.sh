#!/bin/bash
set -e

# fetch-acestream-windows.sh
# Downloads the official Ace Stream Windows installer and extracts ONLY the
# engine subtree (ace_console.exe --client-console + runtime) for bundling
# in the Windows NSIS installer. Mirrors fetch-libmpv-windows.sh.
#
# Redistribucion: binario oficial cerrado (ACE Stream, Innovative Digital
# Technologies). Se descarga de dl.acestream.org en CI; no se commitea.
# Tamano aprox: ~325 MB descomprimido (ui/ son ~172 MB; recortar solo tras
# probar en Windows que --client-console no los necesita).

ACE_VERSION="3.2.8"
ACE_URL="http://dl.acestream.org/Ace_Stream_Media_${ACE_VERSION}.exe"

DEST_DIR="$(cd "$(dirname "$0")/../src-tauri/resources" && pwd)/acestream"
mkdir -p "$DEST_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading Ace Stream ${ACE_VERSION} for Windows..."
curl --fail --location --output "$TMP_DIR/acestream.exe" "$ACE_URL"

echo "Extracting engine subtree..."
7z x -y -o"$TMP_DIR/pkg" "$TMP_DIR/acestream.exe" > /dev/null

ENGINE_DIR="$(find "$TMP_DIR/pkg" -maxdepth 2 -type d -name engine | head -1)"
if [ -z "$ENGINE_DIR" ]; then
    echo "engine dir not found in installer" >&2
    exit 1
fi

cp -r "$ENGINE_DIR/." "$DEST_DIR/"

if [ ! -s "$DEST_DIR/ace_console.exe" ]; then
    echo "ace_console.exe was not extracted" >&2
    exit 1
fi

cat > "$DEST_DIR/PROVENANCE.txt" <<EOF
Ace Stream engine ${ACE_VERSION} (Windows), official closed-source binary.
Downloaded from: ${ACE_URL}
Used headless via: ace_console.exe --client-console (managed sidecar).
EOF

echo "acestream engine installed to $DEST_DIR"
du -sh "$DEST_DIR"
ls "$DEST_DIR"
