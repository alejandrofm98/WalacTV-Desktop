#!/usr/bin/env bash
# WalacTV Desktop - libmpv auto-installer for Linux
# =================================================
# Downloads libmpv.so.2 from the system package manager WITHOUT requiring root.
# Extracts to ~/.local/share/walactv-desktop/libmpv/ so the app can load it
# via libloading with the full path.
#
# Supported package managers: apt (Debian/Ubuntu), dnf (Fedora),
#   pacman (Arch), zypper (openSUSE).
#
# Exit codes:
#   0 - libmpv.so.2 is ready (already existed or freshly installed)
#   1 - installation failed (see stderr for details)

set -euo pipefail

APP_NAME="walactv-desktop"
LIBMPV_DIR=""

# ── Path resolution ──────────────────────────────────────────────────────

detect_data_dir() {
    local xdg_data="${XDG_DATA_HOME:-}"
    if [ -n "$xdg_data" ]; then
        LIBMPV_DIR="${xdg_data}/${APP_NAME}/libmpv"
    else
        local home="${HOME:-}"
        if [ -z "$home" ]; then
            echo "ERROR: \$HOME is not set" >&2
            return 1
        fi
        LIBMPV_DIR="${home}/.local/share/${APP_NAME}/libmpv"
    fi
    mkdir -p "$LIBMPV_DIR"
}

# ── Package manager detection ────────────────────────────────────────────

detect_pkg_manager() {
    if command -v apt-get &>/dev/null; then
        echo "apt"
    elif command -v dnf &>/dev/null; then
        echo "dnf"
    elif command -v pacman &>/dev/null; then
        echo "pacman"
    elif command -v zypper &>/dev/null; then
        echo "zypper"
    else
        echo "unknown"
    fi
}

# ── Installers ───────────────────────────────────────────────────────────

install_apt() {
    local tmpdir
    tmpdir=$(mktemp -d)
    cd "$tmpdir" || return 1

    # Try package names in order: libmpv2 (bookworm+), libmpv1 (bullseye),
    # mpv-libs (Ubuntu variants)
    local pkg=""
    if apt-get download libmpv2 2>/dev/null; then
        pkg="libmpv2"
    elif apt-get download libmpv1 2>/dev/null; then
        pkg="libmpv1"
    elif apt-get download mpv-libs 2>/dev/null; then
        pkg="mpv-libs"
    elif apt-get download libmpv-dev 2>/dev/null; then
        pkg="libmpv-dev"
    fi

    if [ -z "$pkg" ]; then
        rm -rf "$tmpdir"
        echo "ERROR: Could not download libmpv package via apt (tried libmpv2, libmpv1, mpv-libs, libmpv-dev)" >&2
        return 1
    fi

    local deb_file
    deb_file=$(ls *.deb 2>/dev/null | head -1)
    if [ -z "$deb_file" ]; then
        rm -rf "$tmpdir"
        echo "ERROR: No .deb file downloaded for $pkg" >&2
        return 1
    fi

    # Extract .deb
    mkdir extracted
    dpkg-deb -x "$deb_file" extracted

    local so_file
    so_file=$(find extracted -name "libmpv.so.2" -type f 2>/dev/null | head -1)
    if [ -z "$so_file" ]; then
        # Maybe it's a dev package with versioned .so
        so_file=$(find extracted -name "libmpv.so*" -type f 2>/dev/null | head -1)
    fi
    if [ -z "$so_file" ]; then
        rm -rf "$tmpdir"
        echo "ERROR: libmpv.so not found in downloaded package $pkg" >&2
        return 1
    fi

    install -m 644 "$so_file" "$LIBMPV_DIR/libmpv.so.2"

    # Also copy the .so symlink target if it exists and differs
    local so_link
    so_link=$(find extracted -name "libmpv.so" -type l 2>/dev/null | head -1)
    if [ -n "$so_link" ]; then
        local target
        target=$(readlink -f "$so_link" 2>/dev/null || true)
        if [ -n "$target" ] && [ "$target" != "$so_file" ]; then
            install -m 644 "$target" "$LIBMPV_DIR/"
        fi
    fi

    rm -rf "$tmpdir"
    echo "OK: libmpv.so.2 installed to $LIBMPV_DIR (apt/$pkg)"
}

install_dnf() {
    local tmpdir
    tmpdir=$(mktemp -d)
    cd "$tmpdir" || return 1

    # Try package names: mpv-libs (primary), mpv-libs-devel (alternative)
    local pkg=""
    if dnf download mpv-libs 2>/dev/null; then
        pkg="mpv-libs"
    elif dnf download mpv-libs-devel 2>/dev/null; then
        pkg="mpv-libs-devel"
    fi

    if [ -z "$pkg" ]; then
        rm -rf "$tmpdir"
        echo "ERROR: Could not download libmpv package via dnf (tried mpv-libs, mpv-libs-devel)" >&2
        return 1
    fi

    local rpm_file
    rpm_file=$(ls *.rpm 2>/dev/null | head -1)
    if [ -z "$rpm_file" ]; then
        rm -rf "$tmpdir"
        echo "ERROR: No .rpm file downloaded for $pkg" >&2
        return 1
    fi

    # Extract .rpm
    mkdir extracted
    cd extracted
    if command -v rpm2cpio &>/dev/null; then
        rpm2cpio "../$rpm_file" | cpio -idmv 2>/dev/null || true
    else
        # Fallback: use rpm2archive if available
        if command -v rpm2archive &>/dev/null; then
            rpm2archive "../$rpm_file" | tar -xf - 2>/dev/null || true
        else
            rm -rf "$tmpdir"
            echo "ERROR: Neither rpm2cpio nor rpm2archive found" >&2
            return 1
        fi
    fi
    cd "$tmpdir"

    local so_file
    so_file=$(find extracted -name "libmpv.so.2" -type f 2>/dev/null | head -1)
    if [ -z "$so_file" ]; then
        so_file=$(find extracted -name "libmpv.so*" -type f 2>/dev/null | head -1)
    fi
    if [ -z "$so_file" ]; then
        rm -rf "$tmpdir"
        echo "ERROR: libmpv.so not found in downloaded RPM $pkg" >&2
        return 1
    fi

    install -m 644 "$so_file" "$LIBMPV_DIR/libmpv.so.2"
    rm -rf "$tmpdir"
    echo "OK: libmpv.so.2 installed to $LIBMPV_DIR (dnf/$pkg)"
}

install_pacman() {
    # pacman -Sw requires root on most systems to write to /var/cache/pacman/pkg/.
    # Try it; if it fails, show error with manual instructions.
    local tmpdir
    tmpdir=$(mktemp -d)

    if pacman -Sw --noconfirm mpv 2>/dev/null; then
        local pkg_file
        pkg_file=$(ls /var/cache/pacman/pkg/mpv-*.pkg.tar.* 2>/dev/null | sort -V | tail -1)
        if [ -z "$pkg_file" ] || [ ! -f "$pkg_file" ]; then
            # Try looking in alternative cache locations
            pkg_file=$(find /var/cache/pacman/pkg -name "mpv-*.pkg.tar.*" 2>/dev/null | sort -V | tail -1)
        fi

        if [ -n "$pkg_file" ] && [ -f "$pkg_file" ]; then
            tar -xf "$pkg_file" -C "$tmpdir"

            local so_file
            so_file=$(find "$tmpdir" -name "libmpv.so.2" -type f 2>/dev/null | head -1)
            if [ -n "$so_file" ]; then
                install -m 644 "$so_file" "$LIBMPV_DIR/libmpv.so.2"
                rm -rf "$tmpdir"
                echo "OK: libmpv.so.2 installed to $LIBMPV_DIR (pacman)"
                return 0
            fi
            echo "ERROR: libmpv.so.2 not found in pacman mpv package" >&2
            rm -rf "$tmpdir"
            return 1
        fi
        echo "ERROR: mpv package downloaded but not found in pacman cache" >&2
        rm -rf "$tmpdir"
        return 1
    fi

    rm -rf "$tmpdir"
    echo "ERROR: pacman -Sw requires root on this system." >&2
    echo "Please install mpv manually: sudo pacman -S mpv" >&2
    return 1
}

install_zypper() {
    local tmpdir
    tmpdir=$(mktemp -d)
    cd "$tmpdir" || return 1

    local pkg=""
    if zypper download mpv-libs 2>/dev/null; then
        pkg="mpv-libs"
    elif zypper download mpv-devel 2>/dev/null; then
        pkg="mpv-devel"
    fi

    if [ -z "$pkg" ]; then
        rm -rf "$tmpdir"
        echo "ERROR: Could not download libmpv package via zypper (tried mpv-libs, mpv-devel)" >&2
        return 1
    fi

    local rpm_file
    rpm_file=$(ls *.rpm 2>/dev/null | head -1)
    if [ -z "$rpm_file" ]; then
        rm -rf "$tmpdir"
        echo "ERROR: No .rpm file downloaded via zypper" >&2
        return 1
    fi

    mkdir extracted
    cd extracted
    if command -v rpm2cpio &>/dev/null; then
        rpm2cpio "../$rpm_file" | cpio -idmv 2>/dev/null || true
    else
        rpm2archive "../$rpm_file" | tar -xf - 2>/dev/null || true
    fi
    cd "$tmpdir"

    local so_file
    so_file=$(find extracted -name "libmpv.so.2" -type f 2>/dev/null | head -1)
    if [ -z "$so_file" ]; then
        so_file=$(find extracted -name "libmpv.so*" -type f 2>/dev/null | head -1)
    fi
    if [ -z "$so_file" ]; then
        rm -rf "$tmpdir"
        echo "ERROR: libmpv.so not found in downloaded zypper package $pkg" >&2
        return 1
    fi

    install -m 644 "$so_file" "$LIBMPV_DIR/libmpv.so.2"
    rm -rf "$tmpdir"
    echo "OK: libmpv.so.2 installed to $LIBMPV_DIR (zypper/$pkg)"
}

# ── Main ─────────────────────────────────────────────────────────────────

main() {
    if ! detect_data_dir; then
        exit 1
    fi

    # If libmpv is already installed locally, done
    if [ -f "$LIBMPV_DIR/libmpv.so.2" ]; then
        echo "OK: libmpv.so.2 already exists at $LIBMPV_DIR"
        exit 0
    fi

    local pkg_manager
    pkg_manager=$(detect_pkg_manager)
    echo "Detected package manager: ${pkg_manager}"

    case "$pkg_manager" in
        apt)
            install_apt
            ;;
        dnf)
            install_dnf
            ;;
        pacman)
            install_pacman
            ;;
        zypper)
            install_zypper
            ;;
        *)
            echo "ERROR: No supported package manager found." >&2
            echo "Install libmpv manually:" >&2
            echo "  Debian/Ubuntu: sudo apt install libmpv-dev" >&2
            echo "  Fedora:       sudo dnf install mpv-libs-devel" >&2
            echo "  Arch:         sudo pacman -S mpv" >&2
            echo "  openSUSE:     sudo zypper install mpv-devel" >&2
            exit 1
            ;;
    esac
}

main "$@"
