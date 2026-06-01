using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Musicarr.Application.Interfaces;

namespace Musicarr.Infrastructure.MusicDiscovery;

public class DeezerImageService : IDeezerImageService
{
    private readonly HttpClient _httpClient;
    private readonly ILogger<DeezerImageService> _logger;

    public DeezerImageService(HttpClient httpClient, ILogger<DeezerImageService> logger)
    {
        _httpClient = httpClient;
        _httpClient.BaseAddress = new Uri("https://api.deezer.com/");
        _httpClient.DefaultRequestHeaders.Add("User-Agent", "Musicarr/1.0.0 (https://github.com/musicarr)");
        _logger = logger;
    }

    public async Task<string?> GetArtistImageUrlAsync(string artistName)
    {
        try
        {
            var response = await _httpClient.GetFromJsonAsync<JsonElement>(
                $"search/artist?q={Uri.EscapeDataString(artistName)}&limit=1");

            if (response.TryGetProperty("data", out var data) && data.GetArrayLength() > 0)
            {
                var first = data[0];
                if (first.TryGetProperty("picture_medium", out var pic))
                    return pic.GetString();
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to fetch artist image from Deezer for {ArtistName}", artistName);
        }
        return null;
    }

    public async Task<string?> GetAlbumImageUrlAsync(string albumTitle, string? artistName)
    {
        try
        {
            var q = artistName != null ? $"{albumTitle} {artistName}" : albumTitle;
            var response = await _httpClient.GetFromJsonAsync<JsonElement>(
                $"search/album?q={Uri.EscapeDataString(q)}&limit=1");

            if (response.TryGetProperty("data", out var data) && data.GetArrayLength() > 0)
            {
                var first = data[0];
                if (first.TryGetProperty("cover_medium", out var cover))
                    return cover.GetString();
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to fetch album image from Deezer for {AlbumTitle}", albumTitle);
        }
        return null;
    }
}
