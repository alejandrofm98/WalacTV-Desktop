#!/bin/bash
set -e

# install-acestream-linux.sh DEST_DIR
# Instala el engine Acestream autocontenido en user-space (sin sudo):
#   - tarball oficial 22.04/py3.10 (trae binario + wheels propios)
#   - CPython 3.10 portable (python-build-standalone)
#   - pip install de requirements.txt en pylibs/
# Idempotente: si el marcador coincide, no hace nada.
# Solo x86_64. Tamano final aprox: 250 MB. Red: ~110 MB.

ACE_VERSION="3.2.11"
ACE_URL="http://dl.acestream.org/linux/acestream_${ACE_VERSION}_ubuntu_22.04_x86_64_py3.10.tar.gz"
PY_TAG="20241016"
PY_VER="3.10.15"
PY_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_TAG}/cpython-${PY_VER}%2B${PY_TAG}-x86_64-unknown-linux-gnu-install_only.tar.gz"
BUNDLE_MARKER="walactv-acestream-bundle-v1"

DEST_DIR="${1:?usage: install-acestream-linux.sh DEST_DIR}"

if [ "$(uname -m)" != "x86_64" ]; then
    echo "Arquitectura no soportada: $(uname -m) (solo x86_64)" >&2
    exit 1
fi

if [ -f "$DEST_DIR/.walactv-bundle" ] && grep -q "$BUNDLE_MARKER" "$DEST_DIR/.walactv-bundle"; then
    echo "acestream bundle already installed in $DEST_DIR"
    exit 0
fi

mkdir -p "$DEST_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "[1/4] Descargando engine Acestream ${ACE_VERSION}..."
curl --fail --location --retry 2 --output "$TMP_DIR/engine.tar.gz" "$ACE_URL"

echo "[2/4] Descargando Python ${PY_VER} portable..."
curl --fail --location --retry 2 --output "$TMP_DIR/python.tar.gz" "$PY_URL"

echo "[3/4] Extrayendo en $DEST_DIR..."
tar xzf "$TMP_DIR/engine.tar.gz" -C "$DEST_DIR"
tar xzf "$TMP_DIR/python.tar.gz" -C "$DEST_DIR"

if [ ! -x "$DEST_DIR/acestreamengine" ]; then
    echo "acestreamengine no encontrado tras extraer" >&2
    exit 1
fi

echo "[4/4] Instalando dependencias Python (puede tardar minutos)..."
PIP_DISABLE_PIP_VERSION_CHECK=1 \
"$DEST_DIR/python/bin/python3" -m pip install --target "$DEST_DIR/pylibs" \
    -r "$DEST_DIR/requirements.txt"

echo "$BUNDLE_MARKER" > "$DEST_DIR/.walactv-bundle"
cat > "$DEST_DIR/PROVENANCE.txt" <<EOF
WalacTV Acestream bundle (Linux, user-space, auto-instalado).
Engine: ${ACE_URL}
Python: ${PY_URL}
Lanzado por la app con LD_LIBRARY_PATH/PYTHONHOME/PYTHONPATH propios.
EOF

echo "acestream bundle installed in $DEST_DIR"
du -sh "$DEST_DIR"
