using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Musicarr.Application.Interfaces;
using Musicarr.Domain.Interfaces;
using Musicarr.Infrastructure.Configuration;
using Musicarr.Infrastructure.Jellyfin;
using Musicarr.Infrastructure.Lidarr;
using Musicarr.Infrastructure.MusicDiscovery;
using Musicarr.Infrastructure.Persistence;

namespace Musicarr.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services, IConfiguration configuration, string configFilePath)
    {
        // Configuration
        services.Configure<JellyfinOptions>(configuration.GetSection(JellyfinOptions.Section));
        services.Configure<LidarrOptions>(configuration.GetSection(LidarrOptions.Section));
        services.Configure<MusicDiscoveryOptions>(configuration.GetSection(MusicDiscoveryOptions.Section));

        // Config file service
        services.AddSingleton<IConfigService>(sp =>
            new ConfigFileService(configFilePath, sp.GetRequiredService<ILogger<ConfigFileService>>()));

        // Database
        var connectionString = configuration.GetConnectionString("DefaultConnection");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            connectionString = "Data Source=musicarr.db";
        }

        services.AddDbContext<MusicarrDbContext>(options =>
            options.UseSqlite(connectionString));

        // HTTP Clients
        services.AddHttpClient<IJellyfinService, JellyfinService>();
        services.AddHttpClient<ILidarrService, LidarrService>();
        services.AddHttpClient<IMusicDiscoveryProvider, MusicBrainzProvider>();

        // Repositories
        services.AddScoped<IPlaylistRepository, PlaylistRepository>();

        return services;
    }
}
