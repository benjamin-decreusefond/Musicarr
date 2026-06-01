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
    private readonly IDeezerImageService _deezerImageService;
    private readonly IConfigService _configService;
    private readonly ILogger<SearchService> _logger;

    private const int MaxArtists = 5;
    private const int MaxAlbums = 6;
    private const int MaxTracks = 5;

    public SearchService(
        IJellyfinService jellyfinService,
        IEnumerable<IMusicDiscoveryProvider> discoveryProviders,
        IDeezerImageService deezerImageService,
        IConfigService configService,
        ILogger<SearchService> logger)
    {
        _jellyfinService = jellyfinService;
        _discoveryProviders = discoveryProviders;
        _deezerImageService = deezerImageService;
        _configService = configService;
        _logger = logger;
    }

    public async Task<SearchResultDto> SearchAsync(string query)
    {
        _logger.LogInformation("Searching for: {Query}", query.Replace("\n", "").Replace("\r", ""));

        var artists = new List<ArtistDto>();
        var albums = new List<AlbumDto>();
        var tracks = new List<TrackDto>();

        // Search Jellyfin library
        try
        {
            var jellyfinArtists = await _jellyfinService.GetArtistsAsync();
            var matchingArtists = jellyfinArtists
                .Where(a => a.Name.Contains(query, StringComparison.OrdinalIgnoreCase));
            artists.AddRange(matchingArtists.Select(a => new ArtistDto(
                a.Id, a.Name, a.MusicBrainzId, a.JellyfinId, a.ImageUrl,
                a.Overview, a.Genres, MediaAvailability.Available
            )));

            var jellyfinAlbums = await _jellyfinService.GetAlbumsAsync();
            var matchingAlbums = jellyfinAlbums
                .Where(a => a.Title.Contains(query, StringComparison.OrdinalIgnoreCase));
            albums.AddRange(matchingAlbums.Select(a => new AlbumDto(
                a.Id, a.Title, a.ArtistName, a.ArtistId, a.MusicBrainzId, a.JellyfinId,
                a.ImageUrl, a.Year, a.Overview, a.Genres, MediaAvailability.Available
            )));

            var jellyfinTracks = await _jellyfinService.GetTracksAsync();
            var matchingTracks = jellyfinTracks
                .Where(t => t.Title.Contains(query, StringComparison.OrdinalIgnoreCase));
            // Build a lookup of album imageUrl by albumId for track image enrichment
            var albumImageById = albums.Where(a => a.ImageUrl != null)
                .ToDictionary(a => a.Id, a => a.ImageUrl);
            tracks.AddRange(matchingTracks.Select(t =>
            {
                albumImageById.TryGetValue(t.AlbumId, out var trackImageUrl);
                return new TrackDto(
                    t.Id, t.Title, t.ArtistName, null, t.AlbumId, t.JellyfinId,
                    t.TrackNumber, t.DiscNumber, t.DurationTicks, t.StreamUrl,
                    MediaAvailability.Available, trackImageUrl
                );
            }));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Error searching Jellyfin library");
        }

        // Search configured discovery provider
        var providerName = _configService.GetSettings().MusicDiscovery.Provider;
        var configuredProvider = _discoveryProviders.FirstOrDefault(provider =>
                                   provider.ProviderName.Equals(providerName, StringComparison.OrdinalIgnoreCase))
                               ?? _discoveryProviders.FirstOrDefault(provider =>
                                   provider.ProviderName.Equals("Deezer", StringComparison.OrdinalIgnoreCase))
                               ?? _discoveryProviders.FirstOrDefault();
        var useDeezerImageEnrichment = configuredProvider?.ProviderName.Equals("Deezer", StringComparison.OrdinalIgnoreCase) == true;

        if (configuredProvider != null)
        {
            try
            {
                var providerArtists = await configuredProvider.SearchArtistsAsync(query);
                artists.AddRange(providerArtists
                    .Where(a => !artists.Any(existing => existing.Name.Equals(a.Name, StringComparison.OrdinalIgnoreCase)))
                    .Select(a => new ArtistDto(
                        a.Id, a.Name, a.MusicBrainzId, null, a.ImageUrl,
                        a.Overview, a.Genres, MediaAvailability.NotAvailable
                    )));

                var providerAlbums = await configuredProvider.SearchAlbumsAsync(query);
                albums.AddRange(providerAlbums
                    .Where(a => !albums.Any(existing => existing.Title.Equals(a.Title, StringComparison.OrdinalIgnoreCase)))
                    .Select(a => new AlbumDto(
                        a.Id, a.Title, a.ArtistName, null, a.MusicBrainzId, null,
                        a.ImageUrl, a.Year, a.Overview, a.Genres, MediaAvailability.NotAvailable
                    )));

                var providerTracks = await configuredProvider.SearchTracksAsync(query);
                tracks.AddRange(providerTracks
                    .Where(t => !tracks.Any(existing => existing.Title.Equals(t.Title, StringComparison.OrdinalIgnoreCase)))
                    .Select(t => new TrackDto(
                        t.Id, t.Title, t.ArtistName, null, null, null,
                        t.TrackNumber, t.DiscNumber, t.DurationTicks, t.StreamUrl,
                        MediaAvailability.NotAvailable, t.ImageUrl
                    )));
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Error searching provider {Provider}", configuredProvider.ProviderName);
            }
        }

        // Sort by relevance: exact match first, then starts-with, then library items before discovery
        var sortedArtists = SortByRelevance(artists, query, a => a.Name, a => a.Availability)
            .Take(MaxArtists).ToList();
        var sortedAlbums = SortByRelevance(albums, query, a => a.Title, a => a.Availability)
            .Take(MaxAlbums).ToList();
        var sortedTracks = SortByRelevance(tracks, query, t => t.Title, t => t.Availability)
            .Take(MaxTracks).ToList();

        // Enrich artists without images using Deezer when Deezer is the selected provider
        if (useDeezerImageEnrichment)
        {
            var artistEnrichTasks = sortedArtists
                .Where(a => string.IsNullOrEmpty(a.ImageUrl))
                .Select(async a =>
                {
                    var imageUrl = await _deezerImageService.GetArtistImageUrlAsync(a.Name);
                    return (a, imageUrl);
                });

            foreach (var (artist, imageUrl) in await Task.WhenAll(artistEnrichTasks))
            {
                if (imageUrl != null)
                {
                    var idx = sortedArtists.IndexOf(artist);
                    if (idx >= 0)
                        sortedArtists[idx] = artist with { ImageUrl = imageUrl };
                }
            }
        }

        // Enrich albums without images using Deezer when Deezer is the selected provider
        if (useDeezerImageEnrichment)
        {
            var albumEnrichTasks = sortedAlbums
                .Where(a => string.IsNullOrEmpty(a.ImageUrl))
                .Select(async a =>
                {
                    var imageUrl = await _deezerImageService.GetAlbumImageUrlAsync(a.Title, a.ArtistName);
                    return (a, imageUrl);
                });

            foreach (var (album, imageUrl) in await Task.WhenAll(albumEnrichTasks))
            {
                if (imageUrl != null)
                {
                    var idx = sortedAlbums.IndexOf(album);
                    if (idx >= 0)
                        sortedAlbums[idx] = album with { ImageUrl = imageUrl };
                }
            }
        }

        return new SearchResultDto(sortedArtists, sortedAlbums, sortedTracks);
    }

    private const int MatchScoreWeight = 2;

    private static IEnumerable<T> SortByRelevance<T>(
        IEnumerable<T> items,
        string query,
        Func<T, string> nameSelector,
        Func<T, MediaAvailability> availabilitySelector)
    {
        return items.OrderBy(item =>
        {
            var name = nameSelector(item);
            // Exact match = 0, starts with = 1, contains = 2
            int matchScore = name.Equals(query, StringComparison.OrdinalIgnoreCase) ? 0
                : name.StartsWith(query, StringComparison.OrdinalIgnoreCase) ? 1
                : 2;
            // Library items before discovery (Available=0, else 1)
            int availScore = availabilitySelector(item) == MediaAvailability.Available ? 0 : 1;
            return (matchScore * MatchScoreWeight) + availScore;
        });
    }
}
