using Musicarr.Application.DTOs;
using Musicarr.Application.Interfaces;
using Musicarr.Domain.Entities;
using Musicarr.Domain.Enums;
using Musicarr.Domain.Interfaces;
using Microsoft.Extensions.Logging;

namespace Musicarr.Application.Services;

public class CatalogService : ICatalogService
{
    private readonly IJellyfinService _jellyfinService;
    private readonly IDeezerProvider _deezerProvider;
    private readonly ILogger<CatalogService> _logger;

    public CatalogService(IJellyfinService jellyfinService, IDeezerProvider deezerProvider, ILogger<CatalogService> logger)
    {
        _jellyfinService = jellyfinService;
        _deezerProvider = deezerProvider;
        _logger = logger;
    }

    public async Task<IEnumerable<ArtistDto>> GetArtistsAsync()
    {
        var libraryArtists = await GetLibraryArtistsAsync();
        var artistTasks = libraryArtists.Select(async libraryArtist =>
        {
            var deezerArtist = await FindBestArtistMatchAsync(libraryArtist.Name);
            return deezerArtist != null
                ? ToArtistDto(deezerArtist, libraryArtist)
                : ToArtistDto(new Artist
                {
                    Id = Guid.NewGuid(),
                    DeezerId = libraryArtist.JellyfinId,
                    Name = libraryArtist.Name,
                    ImageUrl = libraryArtist.ImageUrl,
                    Overview = libraryArtist.Overview,
                    Genres = libraryArtist.Genres,
                }, libraryArtist);
        });

        return (await Task.WhenAll(artistTasks))
            .OrderBy(artist => artist.Name)
            .ToList();
    }

    public async Task<IEnumerable<AlbumDto>> GetAlbumsAsync(string? artistId = null)
    {
        if (!string.IsNullOrWhiteSpace(artistId))
        {
            var resolvedArtistId = await ResolveArtistIdAsync(artistId);
            if (string.IsNullOrWhiteSpace(resolvedArtistId))
                return Enumerable.Empty<AlbumDto>();

            var libraryAlbums = await GetLibraryAlbumsAsync();
            var albumLookup = libraryAlbums
                .GroupBy(album => BuildAlbumKey(album.Title, album.ArtistName))
                .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);

            return (await _deezerProvider.GetArtistAlbumsAsync(resolvedArtistId))
                .Select(album =>
                {
                    albumLookup.TryGetValue(BuildAlbumKey(album.Title, album.ArtistName), out var localAlbum);
                    return ToAlbumDto(album, localAlbum);
                })
                .OrderByDescending(album => album.Year)
                .ThenBy(album => album.Title)
                .ToList();
        }

        var libraryAlbumsForHome = await GetLibraryAlbumsAsync();
        var albumTasks = libraryAlbumsForHome.Select(async libraryAlbum =>
        {
            var deezerAlbum = await FindBestAlbumMatchAsync(libraryAlbum.Title, libraryAlbum.ArtistName);
            return deezerAlbum != null
                ? ToAlbumDto(deezerAlbum, libraryAlbum)
                : ToAlbumDto(new Album
                {
                    Id = Guid.NewGuid(),
                    DeezerId = libraryAlbum.JellyfinId,
                    Title = libraryAlbum.Title,
                    ArtistName = libraryAlbum.ArtistName,
                    ImageUrl = libraryAlbum.ImageUrl,
                    Year = libraryAlbum.Year,
                    Overview = libraryAlbum.Overview,
                    Genres = libraryAlbum.Genres,
                }, libraryAlbum);
        });

        return (await Task.WhenAll(albumTasks))
            .OrderByDescending(album => album.Year)
            .ThenBy(album => album.Title)
            .ToList();
    }

    public async Task<IEnumerable<TrackDto>> GetTracksAsync(string? albumId = null, string? artistId = null)
    {
        var libraryTracks = await GetLibraryTracksAsync();
        var trackLookup = libraryTracks
            .GroupBy(track => BuildTrackKey(track.Title, track.ArtistName))
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);

        if (!string.IsNullOrWhiteSpace(albumId))
        {
            var album = await GetAlbumByIdAsync(albumId);
            return album?.Tracks ?? Enumerable.Empty<TrackDto>();
        }

        if (!string.IsNullOrWhiteSpace(artistId))
        {
            var resolvedArtistId = await ResolveArtistIdAsync(artistId);
            if (string.IsNullOrWhiteSpace(resolvedArtistId))
                return Enumerable.Empty<TrackDto>();

            return (await _deezerProvider.GetArtistTopTracksAsync(resolvedArtistId))
                .Select(track =>
                {
                    trackLookup.TryGetValue(BuildTrackKey(track.Title, track.ArtistName), out var localTrack);
                    return ToTrackDto(track, localTrack);
                })
                .OrderBy(track => track.TrackNumber == 0 ? int.MaxValue : track.TrackNumber)
                .ThenBy(track => track.Title)
                .ToList();
        }

        return Enumerable.Empty<TrackDto>();
    }

    public async Task<AlbumDto?> GetAlbumByIdAsync(string albumId)
    {
        var resolvedAlbumId = await ResolveAlbumIdAsync(albumId);
        if (string.IsNullOrWhiteSpace(resolvedAlbumId))
            return null;

        var deezerAlbum = await _deezerProvider.GetAlbumAsync(resolvedAlbumId);
        if (deezerAlbum == null)
            return null;

        var libraryAlbums = await GetLibraryAlbumsAsync();
        var libraryTracks = await GetLibraryTracksAsync();
        var localAlbum = libraryAlbums.FirstOrDefault(album => BuildAlbumKey(album.Title, album.ArtistName) == BuildAlbumKey(deezerAlbum.Title, deezerAlbum.ArtistName));
        var trackLookup = libraryTracks
            .GroupBy(track => BuildTrackKey(track.Title, track.ArtistName))
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);

        var trackDtos = deezerAlbum.Tracks
            .Select(track =>
            {
                trackLookup.TryGetValue(BuildTrackKey(track.Title, track.ArtistName), out var localTrack);
                return ToTrackDto(track, localTrack);
            })
            .OrderBy(track => track.DiscNumber)
            .ThenBy(track => track.TrackNumber)
            .ToList();

        return ToAlbumDto(deezerAlbum, localAlbum, trackDtos);
    }

    public async Task<ArtistDto?> GetArtistByIdAsync(string artistId)
    {
        var resolvedArtistId = await ResolveArtistIdAsync(artistId);
        if (string.IsNullOrWhiteSpace(resolvedArtistId))
            return null;

        var deezerArtist = await _deezerProvider.GetArtistAsync(resolvedArtistId);
        if (deezerArtist == null)
            return null;

        var libraryArtists = await GetLibraryArtistsAsync();
        var localArtist = libraryArtists.FirstOrDefault(artist => Normalize(artist.Name) == Normalize(deezerArtist.Name));
        return ToArtistDto(deezerArtist, localArtist);
    }

    private async Task<string?> ResolveArtistIdAsync(string artistId)
    {
        var deezerArtist = await _deezerProvider.GetArtistAsync(artistId);
        if (deezerArtist != null)
            return deezerArtist.DeezerId;

        var libraryArtists = await GetLibraryArtistsAsync();
        var localArtist = libraryArtists.FirstOrDefault(artist => artist.JellyfinId == artistId);
        if (localArtist == null)
            return null;

        var deezerMatch = await FindBestArtistMatchAsync(localArtist.Name);
        return deezerMatch?.DeezerId;
    }

    private async Task<string?> ResolveAlbumIdAsync(string albumId)
    {
        var deezerAlbum = await _deezerProvider.GetAlbumAsync(albumId);
        if (deezerAlbum != null)
            return deezerAlbum.DeezerId;

        var libraryAlbums = await GetLibraryAlbumsAsync();
        var localAlbum = libraryAlbums.FirstOrDefault(album => album.JellyfinId == albumId);
        if (localAlbum == null)
            return null;

        var deezerMatch = await FindBestAlbumMatchAsync(localAlbum.Title, localAlbum.ArtistName);
        return deezerMatch?.DeezerId;
    }

    private async Task<Artist?> FindBestArtistMatchAsync(string artistName)
    {
        var matches = await _deezerProvider.SearchArtistsAsync(artistName);
        return matches
            .OrderByDescending(artist => Normalize(artist.Name) == Normalize(artistName))
            .ThenBy(artist => artist.Name)
            .FirstOrDefault();
    }

    private async Task<Album?> FindBestAlbumMatchAsync(string albumTitle, string? artistName)
    {
        var query = string.IsNullOrWhiteSpace(artistName)
            ? albumTitle
            : $"{artistName} {albumTitle}";
        var matches = await _deezerProvider.SearchAlbumsAsync(query);
        return matches
            .OrderByDescending(album => BuildAlbumKey(album.Title, album.ArtistName) == BuildAlbumKey(albumTitle, artistName))
            .ThenBy(album => album.Title)
            .FirstOrDefault();
    }

    private async Task<List<Artist>> GetLibraryArtistsAsync()
    {
        try
        {
            return (await _jellyfinService.GetArtistsAsync()).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Unable to load Jellyfin artists for availability checks");
            return new List<Artist>();
        }
    }

    private async Task<List<Album>> GetLibraryAlbumsAsync()
    {
        try
        {
            return (await _jellyfinService.GetAlbumsAsync()).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Unable to load Jellyfin albums for availability checks");
            return new List<Album>();
        }
    }

    private async Task<List<Track>> GetLibraryTracksAsync()
    {
        try
        {
            return (await _jellyfinService.GetTracksAsync()).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Unable to load Jellyfin tracks for availability checks");
            return new List<Track>();
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
}
