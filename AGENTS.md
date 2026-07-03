# AGENTS.md - WalacTV Desktop

> Guia para agentes de codigo que trabajen en walactv-desktop.
> Secciones 0-2 son contexto obligatorio antes de tocar nada.
> Secciones 3-8 son referencia operativa.

## 0. Ecosistema y posicion del proyecto

WalacTV Desktop es uno de los clientes del ecosistema WalacTV, un sistema
IPTV/multimedia con backend centralizado (`iptv-api`).

```
   +-------------+        +-------------+
   |  walactvWeb |        | WalacTV     |
   |  Angular 20 |        | Android TV  |
   |  :4200      |        | Kotlin      |
   +------+------+        +------+------+
          |   HTTP + JWT         |  REST + HLS
          v                     v
   +--------------------------------------+
   |          iptv-api (backend)          |
   |     FastAPI @ localhost:3010         |
   +--------------------------------------+
          ^
          |  REST + HLS
   +------+------+
   | WalacTV     |
   | Desktop     |
   | Tauri 2     |
   | (este repo) |
   +-------------+
```

### Tabla de proyectos hermanos

| Proyecto          | Rol                 | Stack                          | Repo                                                | Relacion con este proyecto                                    |
| ----------------- | ------------------- | ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------- |
| iptv-api          | Backend central     | FastAPI, Python 3.12, Postgres | `github.com/alejandrofm98/iptv-api`                 | Este proyecto consume sus endpoints REST. Clonado en `/home/alejandro/PycharmProjects/iptv-api`. Ver `iptv-api/AGENTS.md` secciones 4.1-4.2 |
| walactv-scrapper  | Productor catalogos | Python 3.12, Ofelia, Ansible   | `github.com/alejandrofm98/walactv-scrapper`         | No interactua directamente (iptv-api es intermediario)         |
| WalacTV (Android) | Cliente TV          | Kotlin, Android TV             | `github.com/alejandrofm98/WalacTV`                  | Mismo backend, mismos endpoints, clientes equivalentes         |
| walactvWeb        | Cliente web         | Angular 20                     | `github.com/alejandrofm98/walactvWeb`               | Mismo backend, mismo protocolo                                |

## 1. Contexto rapido

- **Stack**: Tauri 2 (Rust), React 19, TypeScript 5.8, Vite 6, Zustand 5
- **Package manager**: pnpm
- **Backend**: iptv-api en `https://iptv.walerike.com` (configurable via `VITE_API_URL`)
- **Player**: MPV (proceso externo, invocado desde Rust)
- **Credenciales**: `tauri-plugin-store` (encriptadas en `credentials.dat`, NO en localStorage)
- **Build**: `pnpm tauri build` genera binarios nativos (.deb, .AppImage, .exe)

```bash
pnpm install
cp .env.example .env   # configurar VITE_API_URL
pnpm tauri dev         # desarrollo con hot-reload
pnpm tauri build       # build de produccion
```

## 2. Arquitectura

### 2.1 Capas

```
src/
  api/             # Cliente HTTP (fetch) + tipos TypeScript
    client.ts      # Todas las llamadas a la API
    types.ts       # Interfaces y tipos del dominio
  components/      # Componentes React (17 componentes)
  config.ts        # Configuracion centralizada (API_URL, GITHUB_REPO)
  credentials.ts   # Almacenamiento seguro de credenciales (tauri-plugin-store)
  store/           # Estado global (Zustand)
    useAppStore.ts # Store unico: auth, UI state, playback
  updater.ts       # Auto-actualizador via GitHub Releases
  styles/          # CSS global (variables CSS con oklch)
  version.ts       # Constante VERSION

src-tauri/
  src/main.rs      # Comandos Rust: open_in_mpv, get_scale_info
  capabilities/    # Permisos Tauri (core, http, store)
  tauri.conf.json  # Configuracion de la app Tauri
```

### 2.2 Flujo de datos

```
Usuario -> React Component -> api/client.ts -> fetch(IPV_API_URL/...)
                                         <- JSON response
                                         <- Mappped a CatalogItem, etc.
          -> Zustand store (useAppStore)
          -> Re-render
```

### 2.3 Credenciales (seguridad)

Las credenciales del usuario (username/password) se almacenan en `credentials.dat`
via `tauri-plugin-store` (encriptado en disco). Module-level cache en `credentials.ts`
para acceso sincrono desde `resolveUrl()` y `getMpvUrl()`.

**Flujo**:
1. Login -> `api/login()` -> `saveCredentials()` (async store + memory cache)
2. Init -> `loadCredentials()` (async store -> memory cache)
3. Stream URL -> `getUsername()` / `getPassword()` (sync, from memory)
4. SignOut -> `clearCredentials()` (async store + memory)

**NUNCA** usar `localStorage` para passwords. Solo token y username van en localStorage.

### 2.4 Configuracion

`src/config.ts` es la fuente unica de verdad. Todas las URLs hardcodeadas fueron
eliminadas. La URL del backend viene de `VITE_API_URL` (env var).

| Variable        | Descripcion                         | Default |
| --------------- | ----------------------------------- | ------- |
| `VITE_API_URL`  | URL del backend iptv-api            | (ninguno, obligatorio) |

## 3. Convenciones de codigo

- **Language**: TypeScript estricto (`strict: true` en tsconfig).
- **Componentes**: un componente por archivo, CSS Modules para estilos.
- **Estados**: Zustand store unico (`useAppStore`). No usar Context de React.
- **Estilos**: CSS Modules (`.module.css`), variables CSS globales en `global.css`.
- **Path alias**: `@/` -> `src/` (configurado en Vite + tsconfig).
- **Sin emojis** en codigo, comentarios ni docs.
- **Funciones**: `camelCase`. Componentes: `PascalCase`. Const: `UPPER_CASE`.

## 4. Patrones obligatorios

1. **Credenciales**: usar `credentials.ts` (save/load/clear/getUsername/getPassword).
   Jamas `localStorage` para passwords.
2. **URL del backend**: importar `API_URL` / `BASE` desde `src/config.ts`.
   No hardcodear `iptv.walerike.com` en ningun archivo.
3. **Estilos**: crear `Componente.module.css` junto al componente.
   No usar Tailwind, styled-components, ni CSS-in-JS.
4. **Componentes**: crear carpeta `Componente/` con `Componente.tsx` + `Componente.module.css`.
5. **API**: agregar funciones nuevas en `src/api/client.ts`.
   Tipar responses con interfaces en `src/api/types.ts`.
6. **Estado**: si es global, va en `useAppStore`. Si es local del componente, usar `useState`.
7. **Build**: antes de commitear, verificar `pnpm tsc --noEmit` y `pnpm vite build`.

## 5. Endpoints consumidos (contrato con iptv-api)

Ver secciones 4.1 y 4.2 de `iptv-api/AGENTS.md`. Los endpoints principales:

- `POST /api/auth/login` (form-urlencoded)
- `GET /api/home?country=...`
- `GET /api/content?...&page=...&page_size=...`
- `GET /api/search?q=...&page=...`
- `GET /api/series/{name}/episodes?page=...`
- `GET /api/channel-favorites`
- `GET /api/watch-progress`
- `GET /api/calendar/{date}?client=desktop`
- `GET /live/{username}/{password}/{channelId}` (stream directo)
- `GET /movie/{username}/{password}/{providerId}` (stream pelicula)

**Reglas**: si iptv-api cambia un endpoint, este repo se rompe. Coordinar cambios
con el owner antes de mergear en iptv-api.

## 6. Comandos utiles

```bash
# Desarrollo
pnpm tauri dev                    # App completa con hot-reload
pnpm dev                          # Solo frontend (Vite, puerto 1420)

# Build
pnpm tsc --noEmit                 # Type check
pnpm vite build                   # Build frontend
pnpm tauri build                  # Build completo (frontend + Rust)

# Rust (desde src-tauri/)
cargo check                        # Type check Rust
cargo build                        # Build Rust

# Limpieza
pnpm rimraf dist src-tauri/target  # Limpiar builds
```

## 7. Seguridad

- `.gitignore` protege: `.env*`, `.idea/`, `.opencode/`, `*.pem`, `*.key`,
  `*.cert`, `credentials.dat`.
- **NUNCA** commitear `.env`, credenciales, certificados, o `credentials.dat`.
- `.env.example` es el unico archivo de env commiteable (sin valores reales).
- Las passwords van en `tauri-plugin-store` (encriptado), NO en localStorage.
- El proxy de Vite reescribe URLs en dev para evitar CORS, pero en produccion
  las peticiones van directas a `VITE_API_URL`.

## 8. Checklist antes de cerrar una tarea

1. `pnpm tsc --noEmit` sin errores.
2. `pnpm vite build` exitoso.
3. Sin URLs hardcodeadas de `iptv.walerike.com` en `src/` (solo en `config.ts` default).
4. Sin passwords en `localStorage` (solo en `credentials.ts` / store).
5. Sin emojis en codigo ni comentarios.
6. Si tocaste endpoints de la API, verificar compatibilidad con `iptv-api/AGENTS.md` 4.1-4.2.
7. Si agregaste componentes, verificar que tienen `.module.css` asociado.

## 9. Release y actualizaciones

### Flujo de release
1. Actualizar version en `src/version.ts`, `package.json`, y `src-tauri/tauri.conf.json`.
2. Commitear y pushear tag `vX.Y.Z`.
3. El workflow `release.yml` construye y firma los bundles para Windows (NSIS) y Linux (AppImage).
4. `tauri-action` genera `latest.json` con las firmas y lo sube como asset de la release.
5. Los usuarios reciben la actualizacion via `tauri-plugin-updater`.
6. En Windows la app se cierra al instalar (NSIS).
7. En Linux el AppImage se reemplaza en caliente.

### Keypair de firma
- Private key: `~/.tauri/walactv-desktop.key` (NUNCA commiteada, NUNCA compartida).
- Public key: en `tauri.conf.json` `plugins.updater.pubkey`.
- Si la private key se pierde, el updater se rompe para todos los usuarios existentes.
- Para regenerar: `pnpm tauri signer generate --ci --write-keys ~/.tauri/walactv-desktop.key`.
- La private key se pasa al CI via secret `TAURI_SIGNING_PRIVATE_KEY`.

### mpv bundled (Windows)

En Windows, mpv se empaqueta dentro del installer NSIS via `bundled.resources`
para evitar el error "program not found" si el usuario no tiene mpv en el PATH.

**Fuente**: shinchiro/mpv-winbuild-cmake - builds x86_64 genericas (no v3).
**Tag actual**: `20260610` (ver `scripts/fetch-mpv-windows.sh`).

**Como actualizar**:
1. Ir a https://github.com/shinchiro/mpv-winbuild-cmake/releases
2. Elegir el ultimo tag (formato `YYYYMMDD`)
3. Actualizar `TAG` y `ASSET` en `scripts/fetch-mpv-windows.sh`
4. Ejecutar `scripts/fetch-mpv-windows.sh` localmente
5. Verificar que `src-tauri/resources/mpv/mpv.exe` y DLLs se actualizaron
6. Hacer build de prueba en Windows

**Flujo en build**:
- Local: `scripts/fetch-mpv-windows.sh` (requiere `curl` y `7z`)
- CI: se ejecuta automaticamente en el job de Windows de `release.yml`
- Linux/Mac: no se ejecuta el script; `open_in_mpv` usa `mpv` del PATH

**En runtime** (`main.rs`):
1. Busca `resource_dir/resources/mpv/mpv.exe` (bundled)
2. Si no existe, fallback a `mpv` en PATH del sistema

**Licencia**: mpv se distribuye bajo GPLv2+. El binario se descarga de shinchiro
y se redistribuye como parte del installer. El archivo `LICENSE.mpv.txt` se
incluye en `src-tauri/resources/mpv/`.
