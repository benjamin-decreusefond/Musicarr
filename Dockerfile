# Build stage
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

COPY Musicarr.sln .
COPY src/Musicarr.Domain/Musicarr.Domain.csproj src/Musicarr.Domain/
COPY src/Musicarr.Application/Musicarr.Application.csproj src/Musicarr.Application/
COPY src/Musicarr.Infrastructure/Musicarr.Infrastructure.csproj src/Musicarr.Infrastructure/
COPY src/Musicarr.Api/Musicarr.Api.csproj src/Musicarr.Api/

RUN dotnet restore

COPY src/ src/
RUN dotnet publish src/Musicarr.Api/Musicarr.Api.csproj -c Release -o /app/publish --no-restore

# Frontend build stage
FROM node:20-alpine AS frontend-build
WORKDIR /app
COPY src/Musicarr.Web/package*.json ./
RUN npm ci
COPY src/Musicarr.Web/ .
RUN npm run build

# Runtime stage
FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS runtime
WORKDIR /app

RUN adduser --disabled-password --gecos "" musicarr
USER musicarr

COPY --from=build /app/publish .
COPY --from=frontend-build /app/dist ./wwwroot

EXPOSE 5000
ENV ASPNETCORE_URLS=http://+:5000
ENV ASPNETCORE_ENVIRONMENT=Production

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:5000/health || exit 1

ENTRYPOINT ["dotnet", "Musicarr.Api.dll"]
