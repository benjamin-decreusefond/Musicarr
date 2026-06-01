using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Musicarr.Domain.Entities;
using Musicarr.Domain.Interfaces;
using Musicarr.Infrastructure.Configuration;

namespace Musicarr.Infrastructure.Jellyfin;

public class JellyfinService : IJellyfinService
{
    private readonly HttpClient _httpClient;
    private readonly IOptionsSnapshot<JellyfinOptions> _optionsSnapshot;
    private readonly ILogger<JellyfinService> _logger;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public JellyfinService(HttpClient httpClient, IOptionsSnapshot<JellyfinOptions> options, ILogger<JellyfinService> logger)
    {
        _httpClient = httpClient;
        _optionsSnapshot = options;
        _logger = logger;

        if (!string.IsNullOrWhiteSpace(options.Value.BaseUrl))
            _httpClient.BaseAddress = new Uri(options.Value.BaseUrl);
    }

    public async Task<IEnumerable<Artist>> GetArtistsAsync()
    {
        if (!IsConfigured()) return Enumerable.Empty<Artist>();

        try
        {
            SetAuthHeader();
            var response = await _httpClient.GetFromJsonAsync<JsonElement>("/Artists?Recursive=true");
            var items = response.GetProperty("Items");

            return items.EnumerateArray().Select(item => new Artist
            {
                Id = Guid.NewGuid(),
                JellyfinId = item.GetProperty("Id").GetString(),
                Name = item.GetProperty("Name").GetString() ?? "Unknown",
                Overview = item.TryGetProperty("Overview", out var overview) ? overview.GetString() : null,
                ImageUrl = GetImageUrl(item.GetProperty("Id").GetString()!)
            }).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get artists from Jellyfin");
            return Enumerable.Empty<Artist>();
        }
    }

    public async Task<IEnumerable<Album>> GetAlbumsAsync(string? artistId = null)
    {
        if (!IsConfigured()) return Enumerable.Empty<Album>();

        try
        {
            SetAuthHeader();
            var url = "/Items?IncludeItemTypes=MusicAlbum&Recursive=true";
            if (!string.IsNullOrEmpty(artistId))
                url += $"&ArtistIds={artistId}";

            var response = await _httpClient.GetFromJsonAsync<JsonElement>(url);
            var items = response.GetProperty("Items");

            return items.EnumerateArray().Select(item => new Album
            {
                Id = Guid.NewGuid(),
                JellyfinId = item.GetProperty("Id").GetString(),
                Title = item.GetProperty("Name").GetString() ?? "Unknown",
                ArtistName = item.TryGetProperty("AlbumArtist", out var artist) ? artist.GetString() : null,
                Year = item.TryGetProperty("ProductionYear", out var year) ? year.GetInt32() : null,
                ImageUrl = GetImageUrl(item.GetProperty("Id").GetString()!)
            }).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get albums from Jellyfin");
            return Enumerable.Empty<Album>();
        }
    }

    public async Task<IEnumerable<Track>> GetTracksAsync(string? albumId = null)
    {
        if (!IsConfigured()) return Enumerable.Empty<Track>();

        try
        {
            SetAuthHeader();
            var url = "/Items?IncludeItemTypes=Audio&Recursive=true";
            if (!string.IsNullOrEmpty(albumId))
                url += $"&ParentId={albumId}";

            var response = await _httpClient.GetFromJsonAsync<JsonElement>(url);
            var items = response.GetProperty("Items");

            return items.EnumerateArray().Select(item => new Track
            {
                Id = Guid.NewGuid(),
                JellyfinId = item.GetProperty("Id").GetString(),
                Title = item.GetProperty("Name").GetString() ?? "Unknown",
                ArtistName = item.TryGetProperty("AlbumArtist", out var artist) ? artist.GetString() : null,
                TrackNumber = item.TryGetProperty("IndexNumber", out var index) ? index.GetInt32() : 0,
                DiscNumber = item.TryGetProperty("ParentIndexNumber", out var disc) ? disc.GetInt32() : 1,
                DurationTicks = item.TryGetProperty("RunTimeTicks", out var ticks) ? ticks.GetInt64() : null,
                StreamUrl = $"{_optionsSnapshot.Value.BaseUrl}/Audio/{item.GetProperty("Id").GetString()}/universal"
            }).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get tracks from Jellyfin");
            return Enumerable.Empty<Track>();
        }
    }

    public Task<string?> GetStreamUrlAsync(string itemId)
    {
        if (!IsConfigured()) return Task.FromResult<string?>(null);
        var url = $"{_optionsSnapshot.Value.BaseUrl}/Audio/{itemId}/universal?api_key={_optionsSnapshot.Value.ApiKey}";
        return Task.FromResult<string?>(url);
    }

    public Task<string?> GetImageUrlAsync(string itemId)
    {
        return Task.FromResult<string?>(GetImageUrl(itemId));
    }

    public async Task<bool> RefreshLibraryAsync()
    {
        if (!IsConfigured()) return false;

        try
        {
            SetAuthHeader();
            var response = await _httpClient.PostAsync("/Library/Refresh", null);
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to refresh Jellyfin library");
            return false;
        }
    }

    public async Task<IEnumerable<Playlist>> GetPlaylistsAsync()
    {
        if (!IsConfigured()) return Enumerable.Empty<Playlist>();

        try
        {
            SetAuthHeader();
            var response = await _httpClient.GetFromJsonAsync<JsonElement>(
                "/Items?IncludeItemTypes=Playlist&Recursive=true");
            var items = response.GetProperty("Items");

            return items.EnumerateArray().Select(item => new Playlist
            {
                Id = Guid.NewGuid(),
                JellyfinId = item.GetProperty("Id").GetString(),
                Name = item.GetProperty("Name").GetString() ?? "Unknown",
                ImageUrl = GetImageUrl(item.GetProperty("Id").GetString()!)
            }).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get playlists from Jellyfin");
            return Enumerable.Empty<Playlist>();
        }
    }

    public async Task<Playlist?> CreatePlaylistAsync(string name, IEnumerable<string> trackIds)
    {
        if (!IsConfigured()) return null;

        try
        {
            SetAuthHeader();
            var request = new { Name = name, Ids = trackIds.ToArray(), MediaType = "Audio" };
            var response = await _httpClient.PostAsJsonAsync("/Playlists", request);

            if (!response.IsSuccessStatusCode) return null;

            var result = await response.Content.ReadFromJsonAsync<JsonElement>();
            return new Playlist
            {
                Id = Guid.NewGuid(),
                JellyfinId = result.GetProperty("Id").GetString(),
                Name = name
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to create playlist in Jellyfin");
            return null;
        }
    }

    public async Task<bool> DeletePlaylistAsync(string playlistId)
    {
        if (!IsConfigured()) return false;

        try
        {
            SetAuthHeader();
            var response = await _httpClient.DeleteAsync($"/Items/{playlistId}");
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to delete playlist from Jellyfin");
            return false;
        }
    }

    public async Task<bool> AddToPlaylistAsync(string playlistId, IEnumerable<string> trackIds)
    {
        if (!IsConfigured()) return false;

        try
        {
            SetAuthHeader();
            var ids = string.Join(",", trackIds);
            var response = await _httpClient.PostAsync($"/Playlists/{playlistId}/Items?Ids={ids}", null);
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to add tracks to playlist");
            return false;
        }
    }

    public async Task<bool> RemoveFromPlaylistAsync(string playlistId, IEnumerable<string> trackIds)
    {
        if (!IsConfigured()) return false;

        try
        {
            SetAuthHeader();
            var ids = string.Join(",", trackIds);
            var response = await _httpClient.DeleteAsync($"/Playlists/{playlistId}/Items?EntryIds={ids}");
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to remove tracks from playlist");
            return false;
        }
    }

    private bool IsConfigured()
    {
        return !string.IsNullOrWhiteSpace(_optionsSnapshot.Value.BaseUrl)
            && !string.IsNullOrWhiteSpace(_optionsSnapshot.Value.ApiKey);
    }

    private void SetAuthHeader()
    {
        _httpClient.DefaultRequestHeaders.Remove("X-Emby-Token");
        _httpClient.DefaultRequestHeaders.Add("X-Emby-Token", _optionsSnapshot.Value.ApiKey);
    }

    private static string GetImageUrl(string itemId)
    {
        return $"/api/images/jellyfin/{itemId}";
    }
}
