using Musicarr.Application.DTOs;
using Musicarr.Application.Interfaces;
using Musicarr.Domain.Entities;
using Musicarr.Domain.Enums;
using Musicarr.Domain.Interfaces;
using Microsoft.Extensions.Logging;

namespace Musicarr.Application.Services;

public class SearchService : ISearchService
{
    private readonly IJellyfinService _jellyfinService;
    private readonly IDeezerProvider _deezerProvider;
    private readonly ILogger<SearchService> _logger;

    private const int MaxArtists = 5;
    private const int MaxAlbums = 6;
    private const int MaxTracks = 5;
    private const int MatchScoreWeight = 2;

    public SearchService(
        IJellyfinService jellyfinService,
        IDeezerProvider deezerProvider,
        ILogger<SearchService> logger)
    {
        _jellyfinService = jellyfinService;
        _deezerProvider = deezerProvider;
        _logger = logger;
    }

    public async Task<SearchResultDto> SearchAsync(string query)
    {
        _logger.LogInformation("Searching Deezer metadata for: {Query}", Sanitize(query));

        var (libraryArtists, libraryAlbums, libraryTracks) = await GetLibrarySnapshotAsync();
        var artistLookup = libraryArtists.ToDictionary(artist => Normalize(artist.Name), artist => artist, StringComparer.Ordinal);
        var albumLookup = libraryAlbums
            .GroupBy(album => BuildAlbumKey(album.Title, album.ArtistName))
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
        var trackLookup = libraryTracks
            .GroupBy(track => BuildTrackKey(track.Title, track.ArtistName))
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);

        var deezerArtistsTask = _deezerProvider.SearchArtistsAsync(query);
        var deezerAlbumsTask = _deezerProvider.SearchAlbumsAsync(query);
        var deezerTracksTask = _deezerProvider.SearchTracksAsync(query);
        await Task.WhenAll(deezerArtistsTask, deezerAlbumsTask, deezerTracksTask);

        var artists = SortByRelevance(
                deezerArtistsTask.Result
                    .Select(artist => ToArtistDto(artist, artistLookup.TryGetValue(Normalize(artist.Name), out var localArtist) ? localArtist : null))
                    .DistinctBy(artist => artist.Id),
                query,
                artist => artist.Name,
                artist => artist.Availability)
            .Take(MaxArtists)
            .ToList();

        var albums = SortByRelevance(
                deezerAlbumsTask.Result
                    .Select(album =>
                    {
                        albumLookup.TryGetValue(BuildAlbumKey(album.Title, album.ArtistName), out var localAlbum);
                        return ToAlbumDto(album, localAlbum);
                    })
                    .DistinctBy(album => album.Id),
                query,
                album => album.Title,
                album => album.Availability)
            .Take(MaxAlbums)
            .ToList();

        var tracks = SortByRelevance(
                deezerTracksTask.Result
                    .Select(track =>
                    {
                        trackLookup.TryGetValue(BuildTrackKey(track.Title, track.ArtistName), out var localTrack);
                        return ToTrackDto(track, localTrack);
                    })
                    .DistinctBy(track => track.Id),
                query,
                track => track.Title,
                track => track.Availability)
            .Take(MaxTracks)
            .ToList();

        return new SearchResultDto(artists, albums, tracks);
    }

    public async Task<SearchResultDto> GetSuggestionsAsync()
    {
        _logger.LogInformation("Loading Deezer chart suggestions");

        var (libraryArtists, libraryAlbums, libraryTracks) = await GetLibrarySnapshotAsync();
        var artistLookup = libraryArtists.ToDictionary(artist => Normalize(artist.Name), artist => artist, StringComparer.Ordinal);
        var albumLookup = libraryAlbums
            .GroupBy(album => BuildAlbumKey(album.Title, album.ArtistName))
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
        var trackLookup = libraryTracks
            .GroupBy(track => BuildTrackKey(track.Title, track.ArtistName))
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);

        var chartArtistsTask = _deezerProvider.GetChartArtistsAsync();
        var chartAlbumsTask = _deezerProvider.GetChartAlbumsAsync();
        var chartTracksTask = _deezerProvider.GetChartTracksAsync();
        await Task.WhenAll(chartArtistsTask, chartAlbumsTask, chartTracksTask);

        var artists = chartArtistsTask.Result
            .Select(artist => ToArtistDto(artist, artistLookup.TryGetValue(Normalize(artist.Name), out var localArtist) ? localArtist : null))
            .DistinctBy(artist => artist.Id)
            .Take(12)
            .ToList();

        var albums = chartAlbumsTask.Result
            .Select(album =>
            {
                albumLookup.TryGetValue(BuildAlbumKey(album.Title, album.ArtistName), out var localAlbum);
                return ToAlbumDto(album, localAlbum);
            })
            .DistinctBy(album => album.Id)
            .Take(12)
            .ToList();

        var tracks = chartTracksTask.Result
            .Select(track =>
            {
                trackLookup.TryGetValue(BuildTrackKey(track.Title, track.ArtistName), out var localTrack);
                return ToTrackDto(track, localTrack);
            })
            .DistinctBy(track => track.Id)
            .Take(12)
            .ToList();

        return new SearchResultDto(artists, albums, tracks);
    }

    private async Task<(List<Artist> Artists, List<Album> Albums, List<Track> Tracks)> GetLibrarySnapshotAsync()
    {
        try
        {
            var artistsTask = _jellyfinService.GetArtistsAsync();
            var albumsTask = _jellyfinService.GetAlbumsAsync();
            var tracksTask = _jellyfinService.GetTracksAsync();
            await Task.WhenAll(artistsTask, albumsTask, tracksTask);

            return (
                artistsTask.Result.ToList(),
                albumsTask.Result.ToList(),
                tracksTask.Result.ToList());
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Unable to load Jellyfin availability snapshot");
            return (new List<Artist>(), new List<Album>(), new List<Track>());
        }
    }

    private static ArtistDto ToArtistDto(Artist deezerArtist, Artist? localArtist)
    {
        return new ArtistDto(
            deezerArtist.DeezerId ?? localArtist?.JellyfinId ?? deezerArtist.Id.ToString(),
            deezerArtist.Name,
            deezerArtist.MusicBrainzId,
            localArtist?.JellyfinId,
            deezerArtist.ImageUrl,
            deezerArtist.Overview,
            deezerArtist.Genres,
            localArtist != null ? MediaAvailability.Available : MediaAvailability.NotAvailable);
    }

    private static AlbumDto ToAlbumDto(Album deezerAlbum, Album? localAlbum, List<TrackDto>? tracks = null)
    {
        return new AlbumDto(
            deezerAlbum.DeezerId ?? localAlbum?.JellyfinId ?? deezerAlbum.Id.ToString(),
            deezerAlbum.Title,
            deezerAlbum.ArtistName,
            deezerAlbum.DeezerArtistId,
            deezerAlbum.MusicBrainzId,
            localAlbum?.JellyfinId,
            deezerAlbum.ImageUrl,
            deezerAlbum.Year,
            deezerAlbum.Overview,
            deezerAlbum.Genres,
            localAlbum != null ? MediaAvailability.Available : MediaAvailability.NotAvailable,
            tracks);
    }

    private static TrackDto ToTrackDto(Track deezerTrack, Track? localTrack)
    {
        return new TrackDto(
            deezerTrack.DeezerId ?? localTrack?.JellyfinId ?? deezerTrack.Id.ToString(),
            deezerTrack.Title,
            deezerTrack.ArtistName,
            deezerTrack.ArtistDeezerId,
            deezerTrack.AlbumTitle,
            deezerTrack.AlbumDeezerId,
            localTrack?.JellyfinId,
            deezerTrack.TrackNumber,
            deezerTrack.DiscNumber,
            deezerTrack.DurationTicks,
            localTrack?.StreamUrl,
            localTrack != null ? MediaAvailability.Available : MediaAvailability.NotAvailable,
            deezerTrack.ImageUrl);
    }

    private static IEnumerable<T> SortByRelevance<T>(
        IEnumerable<T> items,
        string query,
        Func<T, string> nameSelector,
        Func<T, MediaAvailability> availabilitySelector)
    {
        return items.OrderBy(item =>
        {
            var name = nameSelector(item);
            var matchScore = name.Equals(query, StringComparison.OrdinalIgnoreCase) ? 0
                : name.StartsWith(query, StringComparison.OrdinalIgnoreCase) ? 1
                : 2;
            var availabilityScore = availabilitySelector(item) == MediaAvailability.Available ? 0 : 1;
            return (matchScore * MatchScoreWeight) + availabilityScore;
        });
    }

    private static string BuildAlbumKey(string? title, string? artistName)
    {
        return $"{Normalize(artistName)}|{Normalize(title)}";
    }

    private static string BuildTrackKey(string? title, string? artistName)
    {
        return $"{Normalize(artistName)}|{Normalize(title)}";
    }

    private static string Normalize(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return string.Empty;

        return new string(value.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());
    }

    private static string Sanitize(string value)
    {
        return value.Replace("\n", string.Empty).Replace("\r", string.Empty).Replace("\t", string.Empty);
    }
}
