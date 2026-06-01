using Musicarr.Application.DTOs;
using Musicarr.Application.Interfaces;
using Musicarr.Domain.Enums;
using Musicarr.Domain.Interfaces;
using Microsoft.Extensions.Logging;

namespace Musicarr.Application.Services;

public class SearchService : ISearchService
{
    private readonly IJellyfinService _jellyfinService;
    private readonly IEnumerable<IMusicDiscoveryProvider> _discoveryProviders;
    private readonly ILogger<SearchService> _logger;

    public SearchService(
        IJellyfinService jellyfinService,
        IEnumerable<IMusicDiscoveryProvider> discoveryProviders,
        ILogger<SearchService> logger)
    {
        _jellyfinService = jellyfinService;
        _discoveryProviders = discoveryProviders;
        _logger = logger;
    }

    public async Task<SearchResultDto> SearchAsync(string query, string token)
    {
        _logger.LogInformation("Searching for: {Query}", query);

        var artists = new List<ArtistDto>();
        var albums = new List<AlbumDto>();
        var tracks = new List<TrackDto>();

        // Search Jellyfin library
        try
        {
            var jellyfinArtists = await _jellyfinService.GetArtistsAsync(token);
            var matchingArtists = jellyfinArtists
                .Where(a => a.Name.Contains(query, StringComparison.OrdinalIgnoreCase));
            artists.AddRange(matchingArtists.Select(a => new ArtistDto(
                a.Id, a.Name, a.MusicBrainzId, a.JellyfinId, a.ImageUrl,
                a.Overview, a.Genres, MediaAvailability.Available
            )));

            var jellyfinAlbums = await _jellyfinService.GetAlbumsAsync(token);
            var matchingAlbums = jellyfinAlbums
                .Where(a => a.Title.Contains(query, StringComparison.OrdinalIgnoreCase));
            albums.AddRange(matchingAlbums.Select(a => new AlbumDto(
                a.Id, a.Title, a.ArtistName, a.ArtistId, a.MusicBrainzId, a.JellyfinId,
                a.ImageUrl, a.Year, a.Overview, a.Genres, MediaAvailability.Available
            )));

            var jellyfinTracks = await _jellyfinService.GetTracksAsync(token);
            var matchingTracks = jellyfinTracks
                .Where(t => t.Title.Contains(query, StringComparison.OrdinalIgnoreCase));
            tracks.AddRange(matchingTracks.Select(t => new TrackDto(
                t.Id, t.Title, t.ArtistName, null, t.AlbumId, t.JellyfinId,
                t.TrackNumber, t.DiscNumber, t.DurationTicks, t.StreamUrl,
                MediaAvailability.Available
            )));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Error searching Jellyfin library");
        }

        // Search discovery providers
        foreach (var provider in _discoveryProviders)
        {
            try
            {
                var providerArtists = await provider.SearchArtistsAsync(query);
                artists.AddRange(providerArtists
                    .Where(a => !artists.Any(existing => existing.Name.Equals(a.Name, StringComparison.OrdinalIgnoreCase)))
                    .Select(a => new ArtistDto(
                        a.Id, a.Name, a.MusicBrainzId, null, a.ImageUrl,
                        a.Overview, a.Genres, MediaAvailability.NotAvailable
                    )));

                var providerAlbums = await provider.SearchAlbumsAsync(query);
                albums.AddRange(providerAlbums
                    .Where(a => !albums.Any(existing => existing.Title.Equals(a.Title, StringComparison.OrdinalIgnoreCase)))
                    .Select(a => new AlbumDto(
                        a.Id, a.Title, a.ArtistName, null, a.MusicBrainzId, null,
                        a.ImageUrl, a.Year, a.Overview, a.Genres, MediaAvailability.NotAvailable
                    )));
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Error searching provider {Provider}", provider.ProviderName);
            }
        }

        return new SearchResultDto(artists, albums, tracks);
    }
}
