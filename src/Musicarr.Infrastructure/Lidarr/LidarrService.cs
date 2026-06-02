using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Musicarr.Domain.Entities;
using Musicarr.Domain.Enums;
using Musicarr.Domain.Interfaces;
using Musicarr.Infrastructure.Configuration;

namespace Musicarr.Infrastructure.Lidarr;

public class LidarrService : ILidarrService
{
    private readonly HttpClient _httpClient;
    private readonly LidarrOptions _options;
    private readonly ILogger<LidarrService> _logger;

    public LidarrService(HttpClient httpClient, IOptionsSnapshot<LidarrOptions> options, ILogger<LidarrService> logger)
    {
        _httpClient = httpClient;
        _options = options.Value;
        _logger = logger;
        // The typed HTTP client is transient: IHttpClientFactory creates a new HttpClient
        // per injection, so DefaultRequestHeaders starts empty and is safe to set here.
        if (!string.IsNullOrWhiteSpace(_options.BaseUrl))
        {
            _httpClient.BaseAddress = new Uri(_options.BaseUrl);
            _httpClient.DefaultRequestHeaders.Add("X-Api-Key", _options.ApiKey);
        }
    }

    public async Task<IEnumerable<Artist>> SearchArtistsAsync(string query)
    {
        try
        {
            var response = await _httpClient.GetFromJsonAsync<JsonElement>($"/api/v1/artist/lookup?term={Uri.EscapeDataString(query)}");
            return response.EnumerateArray().Select(item => new Artist
            {
                Id = Guid.NewGuid(),
                Name = item.GetProperty("artistName").GetString() ?? "Unknown",
                MusicBrainzId = item.TryGetProperty("foreignArtistId", out var mbId) ? mbId.GetString() : null,
                Overview = item.TryGetProperty("overview", out var overview) ? overview.GetString() : null,
                ImageUrl = GetImageUrl(item)
            }).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to search artists in Lidarr");
            return Enumerable.Empty<Artist>();
        }
    }

    public async Task<IEnumerable<Album>> SearchAlbumsAsync(string query)
    {
        try
        {
            var response = await _httpClient.GetFromJsonAsync<JsonElement>($"/api/v1/album/lookup?term={Uri.EscapeDataString(query)}");
            return response.EnumerateArray().Select(item => new Album
            {
                Id = Guid.NewGuid(),
                Title = item.GetProperty("title").GetString() ?? "Unknown",
                ArtistName = item.TryGetProperty("artist", out var artist) && artist.TryGetProperty("artistName", out var name) ? name.GetString() : null,
                ArtistMusicBrainzId = item.TryGetProperty("artist", out var artistForMbId) && artistForMbId.TryGetProperty("foreignArtistId", out var artistMbId) ? artistMbId.GetString() : null,
                MusicBrainzId = item.TryGetProperty("foreignAlbumId", out var mbId) ? mbId.GetString() : null
            }).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to search albums in Lidarr");
            return Enumerable.Empty<Album>();
        }
    }

    public async Task<bool> AddArtistAsync(string musicBrainzId, string artistName)
    {
        try
        {
            var request = new
            {
                foreignArtistId = musicBrainzId,
                artistName,
                qualityProfileId = _options.QualityProfileId,
                metadataProfileId = _options.MetadataProfileId,
                rootFolderPath = _options.RootFolderPath,
                monitored = true,
                addOptions = new { monitor = "all", searchForMissingAlbums = true }
            };

            var response = await _httpClient.PostAsJsonAsync("/api/v1/artist", request);
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to add artist to Lidarr");
            return false;
        }
    }

    public async Task<bool> AddAlbumAsync(string musicBrainzId, string artistMusicBrainzId, string artistName)
    {
        try
        {
            var request = new
            {
                foreignAlbumId = musicBrainzId,
                monitored = true,
                addOptions = new { searchForNewAlbum = true },
                artist = new
                {
                    foreignArtistId = artistMusicBrainzId,
                    artistName,
                    qualityProfileId = _options.QualityProfileId,
                    metadataProfileId = _options.MetadataProfileId,
                    rootFolderPath = _options.RootFolderPath,
                    monitored = true,
                    addOptions = new { monitor = "all", searchForMissingAlbums = false }
                }
            };

            var response = await _httpClient.PostAsJsonAsync("/api/v1/album", request);
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to add album to Lidarr");
            return false;
        }
    }

    public async Task<AcquisitionStatus> GetArtistStatusAsync(string musicBrainzId)
    {
        try
        {
            var response = await _httpClient.GetFromJsonAsync<JsonElement>("/api/v1/artist");
            var artist = response.EnumerateArray()
                .FirstOrDefault(a => a.TryGetProperty("foreignArtistId", out var id) && id.GetString() == musicBrainzId);

            if (artist.ValueKind == JsonValueKind.Undefined) return AcquisitionStatus.None;
            return AcquisitionStatus.Completed;
        }
        catch
        {
            return AcquisitionStatus.None;
        }
    }

    public async Task<AcquisitionStatus> GetAlbumStatusAsync(string musicBrainzId)
    {
        try
        {
            var response = await _httpClient.GetFromJsonAsync<JsonElement>("/api/v1/album");
            var album = response.EnumerateArray()
                .FirstOrDefault(a => a.TryGetProperty("foreignAlbumId", out var id) && id.GetString() == musicBrainzId);

            if (album.ValueKind == JsonValueKind.Undefined) return AcquisitionStatus.None;
            
            if (album.TryGetProperty("statistics", out var stats) && 
                stats.TryGetProperty("percentOfTracks", out var percent) && 
                percent.GetDouble() >= 100)
                return AcquisitionStatus.Completed;

            return AcquisitionStatus.Downloading;
        }
        catch
        {
            return AcquisitionStatus.None;
        }
    }

    public async Task<bool> RefreshArtistAsync(string lidarrId)
    {
        try
        {
            var response = await _httpClient.PostAsJsonAsync("/api/v1/command", new
            {
                name = "RefreshArtist",
                artistId = int.Parse(lidarrId)
            });
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to refresh artist in Lidarr");
            return false;
        }
    }

    private static string? GetImageUrl(JsonElement item)
    {
        if (item.TryGetProperty("images", out var images))
        {
            var poster = images.EnumerateArray().FirstOrDefault(i => 
                i.TryGetProperty("coverType", out var ct) && ct.GetString() == "poster");
            if (poster.ValueKind != JsonValueKind.Undefined && poster.TryGetProperty("remoteUrl", out var url))
                return url.GetString();
        }
        return null;
    }
}
