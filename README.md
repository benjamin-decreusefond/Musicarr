# Musicarr

A self-hosted music platform that provides a Spotify-like experience by combining music playback from **Jellyfin**, music acquisition through **Lidarr**, and music discovery through **MusicBrainz**.

## Features

- 🎵 **Stream Music** – Play music directly from your Jellyfin library
- 🔍 **Unified Search** – Search across your library and MusicBrainz simultaneously
- 📥 **Request Music** – Request new music downloads through Lidarr
- 📋 **Playlists** – Create and manage playlists synced with Jellyfin
- 🎨 **Modern UI** – Dark-themed, Spotify-inspired interface
- 🔐 **Jellyfin Auth** – Authenticate using your existing Jellyfin credentials

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

The application will be available at `http://localhost:5000`. On first launch, you will be redirected to the **Setup Wizard** to configure your Jellyfin and Lidarr connections.

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

Musicarr uses a **config file** stored in a data directory, similar to how Sonarr and Radarr manage their settings. On first launch, Musicarr will show a **Setup Wizard** in the browser where you can enter your API keys and service URLs. These are saved to `config.json` in the data directory.

### Data Directory

The data directory defaults to `<app>/data/` and can be overridden with the `MUSICARR_DATA_DIR` environment variable:

```bash
export MUSICARR_DATA_DIR=/path/to/your/config
```

The config file at `$MUSICARR_DATA_DIR/config.json` stores:
- Jellyfin server URL and API key
- Lidarr server URL and API key
- Music discovery provider

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
