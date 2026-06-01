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
│              React Frontend                  │
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
│  ┌──────────┐ ┌──────────┐ ┌────────────┐  │
│  │ Jellyfin │ │  Lidarr  │ │MusicBrainz │  │
│  │ Adapter  │ │ Adapter  │ │  Adapter   │  │
│  └──────────┘ └──────────┘ └────────────┘  │
└─────────────────────────────────────────────┘
```

## Tech Stack

### Backend
- ASP.NET Core 9 / C#
- Clean Architecture
- Entity Framework Core + PostgreSQL
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

# Configure environment variables
export JELLYFIN_API_KEY=your_jellyfin_api_key
export LIDARR_API_KEY=your_lidarr_api_key

# Start all services
docker-compose up -d
```

The application will be available at `http://localhost:5000`.

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

Configuration is managed through environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `ConnectionStrings__DefaultConnection` | PostgreSQL connection string | `Host=localhost;Database=musicarr;...` |
| `Jellyfin__BaseUrl` | Jellyfin server URL | `http://localhost:8096` |
| `Jellyfin__ApiKey` | Jellyfin API key | - |
| `Lidarr__BaseUrl` | Lidarr server URL | `http://localhost:8686` |
| `Lidarr__ApiKey` | Lidarr API key | - |
| `MusicDiscovery__Provider` | Discovery provider | `MusicBrainz` |

## API Documentation

When running in development mode, Swagger UI is available at `/swagger`.

### Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Authenticate with Jellyfin |
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
