# WalacTV Desktop

Aplicación de escritorio para streaming IPTV/multimedia, construida con Tauri 2, React 19 y TypeScript.

## Características

- Catálogo de películas, series y canales en vivo
- Guía de TV y eventos en tiempo real
- Búsqueda con filtros por país, grupo y género
- Reproducción de video con libmpv embebido (FFI directo en Rust)
- Auto-actualización desde GitHub Releases
- Escalado adaptativo DPI (1080p / 1440p / 4K)

## Requisitos

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install) + cargo
- [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) (WebKit2GTK, etc.)
- **libmpv** — reproductor multimedia embebido (FFI directo)

  | OS      | Instalación |
  |---------|-------------|
  | Linux   | `sudo apt install libmpv-dev` (Ubuntu/Debian), `sudo dnf install mpv-libs-devel` (Fedora), `sudo pacman -S mpv` (Arch) |
  | Windows | Se bundlea automáticamente (DLLs incluidos en el instalador) |
  | macOS   | `brew install mpv` (Homebrew) |

## Instalación

```bash
# Instalar dependencias JS
pnpm install

# Copiar .env y configurar la URL del backend
cp .env.example .env
# Editar .env con tu VITE_API_URL

# Ejecutar en modo desarrollo
pnpm tauri dev

# Build de producción
pnpm tauri build
```

## Configuración

Crea un archivo `.env` en la raíz del proyecto:

```
VITE_API_URL=https://tu-backend.com
```

Si no se define, la app no podrá conectarse al backend.

## Estructura

```
walactv-desktop/
├── src/                    # Frontend (React + TypeScript)
│   ├── api/                # Cliente HTTP y tipos
│   ├── components/         # Componentes UI
│   ├── config.ts           # Configuración centralizada
│   ├── credentials.ts      # Almacenamiento seguro de credenciales
│   ├── player/             # Player service wrapper (invoke + listen)
│   ├── store/              # Estado global (Zustand)
│   └── updater.ts          # Auto-actualizador
├── src-tauri/              # Backend (Rust)
│   ├── src/
│   │   ├── main.rs         # Entrypoint
│   │   ├── lib.rs          # Tauri builder + command registration
│   │   ├── mpv/            # libmpv FFI, handle, event loop
│   │   │   ├── ffi.rs      # Bindings dinámicos (libloading)
│   │   │   ├── handle.rs   # MpvInstance wrapper
│   │   │   ├── events.rs   # Event loop thread
│   │   │   └── platform/   # Window handle por OS
│   │   └── commands/       # #[tauri::command] funciones
│   ├── capabilities/       # Permisos Tauri
│   ├── resources/libmpv/   # DLLs bundlados (Windows)
│   └── tauri.conf.json     # Configuración base de la app
├── .env.example            # Plantilla de variables de entorno
└── vite.config.ts          # Configuración Vite + proxy
```

## Stack

| Capa | Tecnología |
|------|-----------|
| Shell | Tauri 2 |
| Frontend | React 19, TypeScript, Vite 6 |
| Estado | Zustand 5 |
| Backend | Rust (tauri-plugin-store, tauri-plugin-http) |
| Player | libmpv embebido (FFI Rust) |
| API | REST (fetch) |

## Licencia

Privada. El binario incluye libmpv (GPL-2.0) bajo los términos de GPL-2.0.
Ver `src-tauri/resources/libmpv/LICENSE.libmpv.txt` para más detalles.
