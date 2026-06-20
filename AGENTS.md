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
| iptv-api          | Backend central     | FastAPI, Python 3.12, Postgres | `github.com/alejandrofm98/iptv-api`                 | Este proyecto consume sus endpoints REST. Ver `iptv-api/AGENTS.md` secciones 4.1-4.2 |
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
