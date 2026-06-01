using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Musicarr.Domain.Entities;
using Musicarr.Domain.Interfaces;

namespace Musicarr.Infrastructure.MusicDiscovery;

public class DeezerProvider : IMusicDiscoveryProvider
{
    private readonly HttpClient _httpClient;
    private readonly ILogger<DeezerProvider> _logger;

    public string ProviderName => "Deezer";

    public DeezerProvider(HttpClient httpClient, ILogger<DeezerProvider> logger)
    {
        _httpClient = httpClient;
        _logger = logger;

        var version = Assembly.GetEntryAssembly()?.GetName().Version?.ToString(3) ?? "1.0.0";
        _httpClient.DefaultRequestHeaders.UserAgent.ParseAdd($"Musicarr/{version} (https://github.com/musicarr)");
    }

    public async Task<IEnumerable<Artist>> SearchArtistsAsync(string query)
    {
        try
        {
            var response = await _httpClient.GetFromJsonAsync<JsonElement>(
                $"search/artist?q={Uri.EscapeDataString(query)}&limit=10");

            return TryGetData(response).Select(item => new Artist
            {
                Id = Guid.NewGuid(),
                Name = GetString(item, "name") ?? "Unknown",
                MusicBrainzId = GetString(item, "id"),
                ImageUrl = GetString(item, "picture_medium") ?? GetString(item, "picture_xl"),
                Overview = BuildArtistOverview(item),
            }).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to search artists on Deezer");
            return Enumerable.Empty<Artist>();
        }
    }

    public async Task<IEnumerable<Album>> SearchAlbumsAsync(string query)
    {
        try
        {
            var response = await _httpClient.GetFromJsonAsync<JsonElement>(
                $"search/album?q={Uri.EscapeDataString(query)}&limit=10");

            return TryGetData(response).Select(item => new Album
            {
                Id = Guid.NewGuid(),
                Title = GetString(item, "title") ?? "Unknown",
                MusicBrainzId = GetString(item, "id"),
                ArtistName = TryGetNestedString(item, "artist", "name"),
                ImageUrl = GetString(item, "cover_medium") ?? GetString(item, "cover_xl"),
                Year = ParseYear(GetString(item, "release_date")),
            }).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to search albums on Deezer");
            return Enumerable.Empty<Album>();
        }
    }

    public async Task<IEnumerable<Track>> SearchTracksAsync(string query)
    {
        try
        {
            var response = await _httpClient.GetFromJsonAsync<JsonElement>(
                $"search/track?q={Uri.EscapeDataString(query)}&limit=10");

            return TryGetData(response).Select(item => new Track
            {
                Id = Guid.NewGuid(),
                Title = GetString(item, "title") ?? "Unknown",
                ArtistName = TryGetNestedString(item, "artist", "name"),
                DurationTicks = item.TryGetProperty("duration", out var duration) && duration.TryGetInt64(out var seconds)
                    ? seconds * TimeSpan.TicksPerSecond
                    : null,
                StreamUrl = GetString(item, "preview"),
                ImageUrl = TryGetNestedString(item, "album", "cover_medium")
                    ?? TryGetNestedString(item, "album", "cover_xl"),
            }).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to search tracks on Deezer");
            return Enumerable.Empty<Track>();
        }
    }

    public Task<IEnumerable<Artist>> GetSimilarArtistsAsync(string artistId)
    {
        return Task.FromResult(Enumerable.Empty<Artist>());
    }

    public async Task<IEnumerable<Album>> GetRecommendationsAsync(string? artistId = null, string? genre = null)
    {
        if (string.IsNullOrWhiteSpace(artistId))
            return Enumerable.Empty<Album>();

        try
        {
            var artist = await _httpClient.GetFromJsonAsync<JsonElement>($"artist/{Uri.EscapeDataString(artistId)}");
            var artistName = GetString(artist, "name");
            var response = await _httpClient.GetFromJsonAsync<JsonElement>($"artist/{Uri.EscapeDataString(artistId)}/albums?limit=10");

            return TryGetData(response).Select(item => new Album
            {
                Id = Guid.NewGuid(),
                Title = GetString(item, "title") ?? "Unknown",
                MusicBrainzId = GetString(item, "id"),
                ArtistName = TryGetNestedString(item, "artist", "name") ?? artistName,
                ImageUrl = GetString(item, "cover_medium") ?? GetString(item, "cover_xl"),
                Year = ParseYear(GetString(item, "release_date")),
            }).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to fetch Deezer recommendations for artist {ArtistId}", artistId);
            return Enumerable.Empty<Album>();
        }
    }

    private static IEnumerable<JsonElement> TryGetData(JsonElement response)
    {
        if (!response.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
            return Enumerable.Empty<JsonElement>();

        return data.EnumerateArray();
    }

    private static string? GetString(JsonElement item, string propertyName)
    {
        if (!item.TryGetProperty(propertyName, out var property))
            return null;

        return property.ValueKind switch
        {
            JsonValueKind.String => property.GetString(),
            JsonValueKind.Number => property.GetRawText(),
            _ => null,
        };
    }

    private static string? TryGetNestedString(JsonElement item, string parentName, string propertyName)
    {
        return item.TryGetProperty(parentName, out var parent) ? GetString(parent, propertyName) : null;
    }

    private static int? ParseYear(string? releaseDate)
    {
        return !string.IsNullOrWhiteSpace(releaseDate) && releaseDate.Length >= 4 && int.TryParse(releaseDate[..4], out var year)
            ? year
            : null;
    }

    private static string? BuildArtistOverview(JsonElement item)
    {
        var parts = new List<string>();

        if (item.TryGetProperty("nb_album", out var albumCount) && albumCount.TryGetInt32(out var albums))
            parts.Add($"{albums} album{(albums == 1 ? string.Empty : "s")}");

        if (item.TryGetProperty("nb_fan", out var fanCount) && fanCount.TryGetInt32(out var fans))
            parts.Add($"{fans:N0} fan{(fans == 1 ? string.Empty : "s")}");

        return parts.Count > 0 ? string.Join(" • ", parts) : null;
    }
}
