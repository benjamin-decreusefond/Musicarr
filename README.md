# Musicarr

A self-hosted music platform that provides a Spotify-like experience by combining music playback from **Jellyfin**, music acquisition through **Lidarr**, and music discovery through **MusicBrainz**.

## Features

- 🎵 **Stream Music** – Play music directly from your Jellyfin library
- 🔍 **Unified Search** – Search across your library and MusicBrainz simultaneously
- 📥 **Request Music** – Request new music downloads through Lidarr
- 📋 **Playlists** – Create and manage playlists synced with Jellyfin
- 🎨 **Modern UI** – Dark-themed, Spotify-inspired interface
- 🔐 **Local Auth** – Authenticate using your Musicarr admin account

## Architecture

```
┌─────────────────────────────────────────────┐
│              React Frontend                 │
│         (TypeScript + MUI + Vite)           │
└─────────────────┬───────────────────────────┘
                  │ REST API
┌─────────────────▼───────────────────────────┐
│           ASP.NET Core 9 API                │
├─────────────────────────────────────────────┤
│  Application Layer (Services, DTOs)         │
├─────────────────────────────────────────────┤
│  Domain Layer (Entities, Interfaces)        │
├─────────────────────────────────────────────┤
│  Infrastructure Layer (Adapters)            │
│  ┌──────────┐ ┌──────────┐ ┌────────────┐   │
│  │ Jellyfin │ │  Lidarr  │ │MusicBrainz │   │
│  │ Adapter  │ │ Adapter  │ │  Adapter   │   │
│  └──────────┘ └──────────┘ └────────────┘   │
└─────────────────────────────────────────────┘
```

## Tech Stack

### Backend
- ASP.NET Core 9 / C#
- Clean Architecture
- Entity Framework Core + SQLite
- REST API with OpenAPI/Swagger

### Frontend
- React 18 + TypeScript
- Vite
- Material UI
- React Router

### Infrastructure
- Docker + Docker Compose
- Kubernetes manifests
- Helm chart

## Quick Start

### Prerequisites
- Docker & Docker Compose
- Jellyfin server (accessible)
- Lidarr instance (optional, for music acquisition)

### Running with Docker Compose

```bash
# Clone the repository
git clone https://github.com/BenjaminDecreusefond/Musicarr.git
cd Musicarr

# Start all services
docker-compose up -d
```

The application will be available at `http://localhost:5000`. On first launch, you will be prompted to **create an admin account**. After logging in, you can configure Jellyfin and Lidarr connections from the **Settings** page.

### Development Setup

#### Backend
```bash
# Restore packages
dotnet restore

# Run the API
cd src/Musicarr.Api
dotnet run
```

#### Frontend
```bash
cd src/Musicarr.Web
npm install
npm run dev
```

The frontend dev server runs at `http://localhost:5173` with API proxy to `http://localhost:5000`.

## Configuration

Musicarr uses a **config file** stored in a data directory, similar to how Sonarr and Radarr manage their settings. On first launch, Musicarr prompts you to create an admin account. Jellyfin and Lidarr connections can be configured later from the **Settings** page in the web UI.

### First Launch

1. Navigate to `http://localhost:5000` (or your configured URL)
2. Create your admin account (username + password)
3. Log in and optionally configure Jellyfin/Lidarr from **Settings**

### Data Directory

The data directory defaults to `<app>/data/` and can be overridden with the `MUSICARR_DATA_DIR` environment variable:

```bash
export MUSICARR_DATA_DIR=/path/to/your/config
```

The data directory stores:
- `config.json` – Jellyfin, Lidarr, and MusicDiscovery settings
- `jwt-secret.key` – Auto-generated JWT signing secret (do not share)
- `musicarr.db` – SQLite database (unless a custom connection string is set)

### Updating Settings

Settings can be updated at any time via **Settings** in the sidebar of the web UI. Changes take effect immediately.

### Environment Variables (Optional Overrides)

You can still use environment variables to pre-seed the configuration (they take lower priority than `config.json`):

| Variable | Description | Default |
|----------|-------------|---------|
| `ConnectionStrings__DefaultConnection` | SQLite connection string | `Data Source=musicarr.db` |
| `Jellyfin__BaseUrl` | Jellyfin server URL | `http://localhost:8096` |
| `Jellyfin__ApiKey` | Jellyfin API key | - |
| `Lidarr__BaseUrl` | Lidarr server URL | `http://localhost:8686` |
| `Lidarr__ApiKey` | Lidarr API key | - |
| `MusicDiscovery__Provider` | Discovery provider | `MusicBrainz` |
| `MUSICARR_DATA_DIR` | Path to data/config directory | `<app>/data/` |

## API Documentation

When running in development mode, Swagger UI is available at `/swagger`.

### Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Authenticate with Jellyfin |
| GET | `/api/settings` | Get current settings (API keys masked) |
| PUT | `/api/settings` | Update settings and save to config file |
| GET | `/api/settings/status` | Returns `{ isConfigured: bool }` |
| GET | `/api/catalog/artists` | List artists from library |
| GET | `/api/catalog/albums` | List albums from library |
| GET | `/api/catalog/tracks` | List tracks from library |
| GET | `/api/search?q=` | Unified search |
| GET | `/api/playlists` | List playlists |
| POST | `/api/playlists` | Create playlist |
| POST | `/api/acquisition/request` | Request music download |
| GET | `/api/playback/stream/{id}` | Get stream URL |
| GET | `/health` | Health check |
| GET | `/health/ready` | Readiness probe |
| GET | `/health/live` | Liveness probe |

## Project Structure

```
Musicarr/
├── src/
│   ├── Musicarr.Domain/          # Entities, interfaces, enums
│   ├── Musicarr.Application/     # Services, DTOs, business logic
│   ├── Musicarr.Infrastructure/  # External service adapters, persistence
│   ├── Musicarr.Api/             # REST API controllers, middleware
│   └── Musicarr.Web/             # React frontend
├── Dockerfile
├── docker-compose.yml
└── Musicarr.sln
```

## License

MIT
