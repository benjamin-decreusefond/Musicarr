using Microsoft.Extensions.DependencyInjection;
using Musicarr.Application.Interfaces;
using Musicarr.Application.Services;

namespace Musicarr.Application.Common;

public static class DependencyInjection
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        services.AddScoped<IAuthenticationService, AuthenticationService>();
        services.AddScoped<ICatalogService, CatalogService>();
        services.AddScoped<ISearchService, SearchService>();
        services.AddScoped<IAcquisitionService, AcquisitionService>();
        services.AddScoped<IPlaybackService, PlaybackService>();
        services.AddScoped<IPlaylistService, PlaylistService>();
        return services;
    }
}
