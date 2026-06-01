using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Musicarr.Domain.Entities;
using Musicarr.Domain.Interfaces;

namespace Musicarr.Infrastructure.MusicDiscovery;

public class MusicBrainzProvider : IMusicDiscoveryProvider
{
    private readonly HttpClient _httpClient;
    private readonly ILogger<MusicBrainzProvider> _logger;

    public string ProviderName => "MusicBrainz";

    public MusicBrainzProvider(HttpClient httpClient, ILogger<MusicBrainzProvider> logger)
    {
        _httpClient = httpClient;
        _logger = logger;
        _httpClient.BaseAddress = new Uri("https://musicbrainz.org/ws/2/");
        _httpClient.DefaultRequestHeaders.Add("User-Agent", "Musicarr/1.0.0 (https://github.com/musicarr)");
        _httpClient.DefaultRequestHeaders.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("application/json"));
    }

    public async Task<IEnumerable<Artist>> SearchArtistsAsync(string query)
    {
        try
        {
            var response = await _httpClient.GetFromJsonAsync<JsonElement>(
                $"artist?query={Uri.EscapeDataString(query)}&limit=20&fmt=json");

            if (!response.TryGetProperty("artists", out var artists))
                return Enumerable.Empty<Artist>();

            return artists.EnumerateArray().Select(item => new Artist
            {
                Id = Guid.NewGuid(),
                Name = item.GetProperty("name").GetString() ?? "Unknown",
                MusicBrainzId = item.GetProperty("id").GetString(),
                Genres = item.TryGetProperty("tags", out var tags) 
                    ? tags.EnumerateArray()
                        .Where(t => t.TryGetProperty("name", out _))
                        .Select(t => t.GetProperty("name").GetString()!)
                        .Take(5).ToList()
                    : new List<string>()
            }).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to search artists on MusicBrainz");
            return Enumerable.Empty<Artist>();
        }
    }

    public async Task<IEnumerable<Album>> SearchAlbumsAsync(string query)
    {
        try
        {
            var response = await _httpClient.GetFromJsonAsync<JsonElement>(
                $"release-group?query={Uri.EscapeDataString(query)}&limit=20&fmt=json");

            if (!response.TryGetProperty("release-groups", out var releases))
                return Enumerable.Empty<Album>();

            return releases.EnumerateArray().Select(item => new Album
            {
                Id = Guid.NewGuid(),
                Title = item.GetProperty("title").GetString() ?? "Unknown",
                MusicBrainzId = item.GetProperty("id").GetString(),
                ArtistName = item.TryGetProperty("artist-credit", out var credits) && credits.GetArrayLength() > 0
                    ? credits[0].TryGetProperty("name", out var name) ? name.GetString() : null
                    : null,
                Year = item.TryGetProperty("first-release-date", out var date) && date.GetString()?.Length >= 4
                    ? int.TryParse(date.GetString()![..4], out var y) ? y : null
                    : null
            }).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to search albums on MusicBrainz");
            return Enumerable.Empty<Album>();
        }
    }

    public async Task<IEnumerable<Track>> SearchTracksAsync(string query)
    {
        try
        {
            var response = await _httpClient.GetFromJsonAsync<JsonElement>(
                $"recording?query={Uri.EscapeDataString(query)}&limit=20&fmt=json");

            if (!response.TryGetProperty("recordings", out var recordings))
                return Enumerable.Empty<Track>();

            return recordings.EnumerateArray().Select(item => new Track
            {
                Id = Guid.NewGuid(),
                Title = item.GetProperty("title").GetString() ?? "Unknown",
                ArtistName = item.TryGetProperty("artist-credit", out var credits) && credits.GetArrayLength() > 0
                    ? credits[0].TryGetProperty("name", out var name) ? name.GetString() : null
                    : null,
                DurationTicks = item.TryGetProperty("length", out var length) ? length.GetInt64() * 10000 : null
            }).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to search tracks on MusicBrainz");
            return Enumerable.Empty<Track>();
        }
    }

    public Task<IEnumerable<Artist>> GetSimilarArtistsAsync(string artistId)
    {
        // MusicBrainz doesn't natively support similar artists
        return Task.FromResult(Enumerable.Empty<Artist>());
    }

    public Task<IEnumerable<Album>> GetRecommendationsAsync(string? artistId = null, string? genre = null)
    {
        // MusicBrainz doesn't natively support recommendations
        return Task.FromResult(Enumerable.Empty<Album>());
    }
}
