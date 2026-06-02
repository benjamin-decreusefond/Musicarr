using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Musicarr.Domain.Entities;
using Musicarr.Domain.Interfaces;

namespace Musicarr.Infrastructure.MusicDiscovery;

public class DeezerProvider : IMusicDiscoveryProvider, IDeezerProvider
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
        return await GetArtistsFromListEndpointAsync($"search/artist?q={Uri.EscapeDataString(query)}&limit=10");
    }

    public async Task<IEnumerable<Album>> SearchAlbumsAsync(string query)
    {
        return await GetAlbumsFromListEndpointAsync($"search/album?q={Uri.EscapeDataString(query)}&limit=10");
    }

    public async Task<IEnumerable<Track>> SearchTracksAsync(string query)
    {
        return await GetTracksFromListEndpointAsync($"search/track?q={Uri.EscapeDataString(query)}&limit=10");
    }

    public async Task<Artist?> GetArtistAsync(string artistId)
    {
        try
        {
            var response = await _httpClient.GetFromJsonAsync<JsonElement>($"artist/{Uri.EscapeDataString(artistId)}");
            return HasError(response) ? null : MapArtist(response);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get Deezer artist {ArtistId}", SanitizeForLog(artistId));
            return null;
        }
    }

    public async Task<IEnumerable<Album>> GetArtistAlbumsAsync(string artistId)
    {
        return await GetAlbumsFromListEndpointAsync($"artist/{Uri.EscapeDataString(artistId)}/albums?limit=50");
    }

    public async Task<IEnumerable<Track>> GetArtistTopTracksAsync(string artistId)
    {
        return await GetTracksFromListEndpointAsync($"artist/{Uri.EscapeDataString(artistId)}/top?limit=20");
    }

    public async Task<Album?> GetAlbumAsync(string albumId)
    {
        try
        {
            var response = await _httpClient.GetFromJsonAsync<JsonElement>($"album/{Uri.EscapeDataString(albumId)}");
            if (HasError(response))
                return null;

            var album = MapAlbum(response);
            album.Tracks = GetTrackData(response)
                .Select(track => MapTrack(track, album.Title, album.DeezerId, album.ImageUrl, album.ArtistName, album.DeezerArtistId))
                .ToList();
            return album;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get Deezer album {AlbumId}", SanitizeForLog(albumId));
            return null;
        }
    }

    public async Task<IEnumerable<Artist>> GetChartArtistsAsync()
    {
        return await GetArtistsFromListEndpointAsync("chart/0/artists?limit=12");
    }

    public async Task<IEnumerable<Album>> GetChartAlbumsAsync()
    {
        return await GetAlbumsFromListEndpointAsync("chart/0/albums?limit=12");
    }

    public async Task<IEnumerable<Track>> GetChartTracksAsync()
    {
        return await GetTracksFromListEndpointAsync("chart/0/tracks?limit=12");
    }

    public Task<IEnumerable<Artist>> GetSimilarArtistsAsync(string artistId)
    {
        return Task.FromResult(Enumerable.Empty<Artist>());
    }

    public async Task<IEnumerable<Album>> GetRecommendationsAsync(string? artistId = null, string? genre = null)
    {
        if (string.IsNullOrWhiteSpace(artistId))
            return Enumerable.Empty<Album>();

        return await GetArtistAlbumsAsync(artistId);
    }

    private async Task<IEnumerable<Artist>> GetArtistsFromListEndpointAsync(string endpoint)
    {
        try
        {
            var response = await _httpClient.GetFromJsonAsync<JsonElement>(endpoint);
            return HasError(response) ? Enumerable.Empty<Artist>() : TryGetData(response).Select(MapArtist).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed Deezer artist request {Endpoint}", SanitizeForLog(endpoint));
            return Enumerable.Empty<Artist>();
        }
    }

    private async Task<IEnumerable<Album>> GetAlbumsFromListEndpointAsync(string endpoint)
    {
        try
        {
            var response = await _httpClient.GetFromJsonAsync<JsonElement>(endpoint);
            return HasError(response) ? Enumerable.Empty<Album>() : TryGetData(response).Select(MapAlbum).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed Deezer album request {Endpoint}", SanitizeForLog(endpoint));
            return Enumerable.Empty<Album>();
        }
    }

    private async Task<IEnumerable<Track>> GetTracksFromListEndpointAsync(string endpoint)
    {
        try
        {
            var response = await _httpClient.GetFromJsonAsync<JsonElement>(endpoint);
            return HasError(response) ? Enumerable.Empty<Track>() : TryGetData(response).Select(item => MapTrack(item)).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed Deezer track request {Endpoint}", SanitizeForLog(endpoint));
            return Enumerable.Empty<Track>();
        }
    }

    private static IEnumerable<JsonElement> TryGetData(JsonElement response)
    {
        if (!response.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
            return Enumerable.Empty<JsonElement>();

        return data.EnumerateArray();
    }

    private static IEnumerable<JsonElement> GetTrackData(JsonElement response)
    {
        if (!response.TryGetProperty("tracks", out var tracks) || !tracks.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
            return Enumerable.Empty<JsonElement>();

        return data.EnumerateArray();
    }

    private static bool HasError(JsonElement response)
    {
        return response.ValueKind != JsonValueKind.Undefined
            && response.TryGetProperty("error", out _);
    }

    private static Artist MapArtist(JsonElement item)
    {
        return new Artist
        {
            Id = Guid.NewGuid(),
            DeezerId = GetString(item, "id"),
            Name = GetString(item, "name") ?? "Unknown",
            ImageUrl = GetString(item, "picture_medium") ?? GetString(item, "picture_big") ?? GetString(item, "picture_xl"),
            Overview = BuildArtistOverview(item),
            Genres = GetGenres(item),
        };
    }

    private static Album MapAlbum(JsonElement item)
    {
        var trackCount = item.TryGetProperty("nb_tracks", out var tracks) && tracks.TryGetInt32(out var count)
            ? count
            : (int?)null;

        return new Album
        {
            Id = Guid.NewGuid(),
            DeezerId = GetString(item, "id"),
            Title = GetString(item, "title") ?? "Unknown",
            ArtistName = TryGetNestedString(item, "artist", "name"),
            DeezerArtistId = TryGetNestedString(item, "artist", "id"),
            ImageUrl = GetString(item, "cover_medium") ?? GetString(item, "cover_big") ?? GetString(item, "cover_xl"),
            Year = ParseYear(GetString(item, "release_date")),
            Overview = BuildAlbumOverview(item, trackCount),
            Genres = GetGenres(item),
        };
    }

    private static Track MapTrack(
        JsonElement item,
        string? fallbackAlbumTitle = null,
        string? fallbackAlbumId = null,
        string? fallbackAlbumImage = null,
        string? fallbackArtistName = null,
        string? fallbackArtistId = null)
    {
        return new Track
        {
            Id = Guid.NewGuid(),
            DeezerId = GetString(item, "id"),
            Title = GetString(item, "title") ?? "Unknown",
            ArtistName = TryGetNestedString(item, "artist", "name") ?? fallbackArtistName,
            ArtistDeezerId = TryGetNestedString(item, "artist", "id") ?? fallbackArtistId,
            AlbumTitle = TryGetNestedString(item, "album", "title") ?? fallbackAlbumTitle,
            AlbumDeezerId = TryGetNestedString(item, "album", "id") ?? fallbackAlbumId,
            TrackNumber = GetInt(item, "track_position") ?? 0,
            DiscNumber = GetInt(item, "disk_number") ?? 1,
            DurationTicks = item.TryGetProperty("duration", out var duration) && duration.TryGetInt64(out var seconds)
                ? seconds * TimeSpan.TicksPerSecond
                : null,
            ImageUrl = TryGetNestedString(item, "album", "cover_medium")
                ?? TryGetNestedString(item, "album", "cover_big")
                ?? TryGetNestedString(item, "album", "cover_xl")
                ?? fallbackAlbumImage,
        };
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

    private static int? GetInt(JsonElement item, string propertyName)
    {
        if (!item.TryGetProperty(propertyName, out var property))
            return null;

        return property.ValueKind switch
        {
            JsonValueKind.Number when property.TryGetInt32(out var value) => value,
            JsonValueKind.String when int.TryParse(property.GetString(), out var value) => value,
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

    private static List<string> GetGenres(JsonElement item)
    {
        if (!item.TryGetProperty("genres", out var genres) || !genres.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
            return new List<string>();

        return data.EnumerateArray()
            .Select(genre => GetString(genre, "name"))
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Take(5)
            .Cast<string>()
            .ToList();
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

    private static string? BuildAlbumOverview(JsonElement item, int? trackCount)
    {
        var parts = new List<string>();
        var label = GetString(item, "label");
        if (!string.IsNullOrWhiteSpace(label))
            parts.Add(label);
        if (trackCount.HasValue)
            parts.Add($"{trackCount.Value} track{(trackCount.Value == 1 ? string.Empty : "s")}");

        return parts.Count > 0 ? string.Join(" • ", parts) : null;
    }

    private static string SanitizeForLog(string value)
    {
        return value.Replace("\n", string.Empty).Replace("\r", string.Empty).Replace("\t", string.Empty);
    }
}
