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
    private readonly JellyfinOptions _options;
    private readonly ILogger<JellyfinService> _logger;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public JellyfinService(HttpClient httpClient, IOptions<JellyfinOptions> options, ILogger<JellyfinService> logger)
    {
        _httpClient = httpClient;
        _options = options.Value;
        _logger = logger;
        _httpClient.BaseAddress = new Uri(_options.BaseUrl);
    }

    public async Task<(bool Success, string? Token, string? UserId)> AuthenticateAsync(string username, string password)
    {
        try
        {
            var request = new
            {
                Username = username,
                Pw = password
            };

            var response = await _httpClient.PostAsJsonAsync("/Users/AuthenticateByName", request);
            if (!response.IsSuccessStatusCode)
                return (false, null, null);

            var result = await response.Content.ReadFromJsonAsync<JsonElement>();
            var token = result.GetProperty("AccessToken").GetString();
            var userId = result.GetProperty("User").GetProperty("Id").GetString();

            return (true, token, userId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to authenticate with Jellyfin");
            return (false, null, null);
        }
    }

    public async Task<IEnumerable<Artist>> GetArtistsAsync(string token)
    {
        try
        {
            SetAuthHeader(token);
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

    public async Task<IEnumerable<Album>> GetAlbumsAsync(string token, string? artistId = null)
    {
        try
        {
            SetAuthHeader(token);
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

    public async Task<IEnumerable<Track>> GetTracksAsync(string token, string? albumId = null)
    {
        try
        {
            SetAuthHeader(token);
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
                StreamUrl = $"{_options.BaseUrl}/Audio/{item.GetProperty("Id").GetString()}/universal"
            }).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get tracks from Jellyfin");
            return Enumerable.Empty<Track>();
        }
    }

    public Task<string?> GetStreamUrlAsync(string token, string itemId)
    {
        var url = $"{_options.BaseUrl}/Audio/{itemId}/universal?api_key={token}";
        return Task.FromResult<string?>(url);
    }

    public Task<string?> GetImageUrlAsync(string itemId)
    {
        return Task.FromResult<string?>(GetImageUrl(itemId));
    }

    public async Task<bool> RefreshLibraryAsync(string token)
    {
        try
        {
            SetAuthHeader(token);
            var response = await _httpClient.PostAsync("/Library/Refresh", null);
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to refresh Jellyfin library");
            return false;
        }
    }

    public async Task<IEnumerable<Playlist>> GetPlaylistsAsync(string token, string userId)
    {
        try
        {
            SetAuthHeader(token);
            var response = await _httpClient.GetFromJsonAsync<JsonElement>(
                $"/Users/{userId}/Items?IncludeItemTypes=Playlist&Recursive=true");
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

    public async Task<Playlist?> CreatePlaylistAsync(string token, string userId, string name, IEnumerable<string> trackIds)
    {
        try
        {
            SetAuthHeader(token);
            var request = new { Name = name, UserId = userId, Ids = trackIds.ToArray(), MediaType = "Audio" };
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

    public async Task<bool> DeletePlaylistAsync(string token, string playlistId)
    {
        try
        {
            SetAuthHeader(token);
            var response = await _httpClient.DeleteAsync($"/Items/{playlistId}");
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to delete playlist from Jellyfin");
            return false;
        }
    }

    public async Task<bool> AddToPlaylistAsync(string token, string playlistId, IEnumerable<string> trackIds)
    {
        try
        {
            SetAuthHeader(token);
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

    public async Task<bool> RemoveFromPlaylistAsync(string token, string playlistId, IEnumerable<string> trackIds)
    {
        try
        {
            SetAuthHeader(token);
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

    private void SetAuthHeader(string token)
    {
        _httpClient.DefaultRequestHeaders.Remove("X-Emby-Token");
        _httpClient.DefaultRequestHeaders.Add("X-Emby-Token", token);
    }

    private string GetImageUrl(string itemId)
    {
        return $"{_options.BaseUrl}/Items/{itemId}/Images/Primary";
    }
}
