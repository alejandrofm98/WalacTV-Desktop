# WalacTV Desktop

Aplicación de escritorio para streaming IPTV/multimedia, construida con Tauri 2, React 19 y TypeScript.

## Características

- Catálogo de películas, series y canales en vivo
- Guía de TV y eventos en tiempo real
- Búsqueda con filtros por país, grupo y género
- Reproducción nativa via MPV con hardware decoding
- Auto-actualización desde GitHub Releases
- Escalado adaptativo DPI (1080p / 1440p / 4K)

## Requisitos

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install) + cargo
- [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) (WebKit2GTK, etc.)
- [MPV](https://mpv.io/) instalado y en el PATH

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
│   ├── store/              # Estado global (Zustand)
│   └── updater.ts          # Auto-actualizador
├── src-tauri/              # Backend (Rust)
│   ├── src/main.rs         # Comandos Tauri (MPV, DPI)
│   ├── capabilities/       # Permisos Tauri
│   └── tauri.conf.json     # Configuración de la app
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
| Player | MPV (externo) |
| API | REST (fetch) |

## Licencia

Privada.
