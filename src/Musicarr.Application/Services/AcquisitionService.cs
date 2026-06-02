using Musicarr.Application.DTOs;
using Musicarr.Application.Interfaces;
using Musicarr.Domain.Enums;
using Musicarr.Domain.Interfaces;
using Microsoft.Extensions.Logging;

namespace Musicarr.Application.Services;

public class AcquisitionService : IAcquisitionService
{
    private readonly ILidarrService _lidarrService;
    private readonly ILogger<AcquisitionService> _logger;

    public AcquisitionService(ILidarrService lidarrService, ILogger<AcquisitionService> logger)
    {
        _lidarrService = lidarrService;
        _logger = logger;
    }

    public async Task<bool> RequestArtistAsync(AcquisitionRequestDto request)
    {
        var musicBrainzId = request.MusicBrainzId;
        if (string.IsNullOrWhiteSpace(musicBrainzId))
        {
            var matches = await _lidarrService.SearchArtistsAsync(request.Name);
            musicBrainzId = matches
                .OrderByDescending(artist => IsExactArtistMatch(artist.Name, request.Name))
                .ThenBy(artist => artist.Name)
                .Select(artist => artist.MusicBrainzId)
                .FirstOrDefault(id => !string.IsNullOrWhiteSpace(id));
        }

        if (string.IsNullOrWhiteSpace(musicBrainzId))
        {
            _logger.LogWarning("Unable to resolve Lidarr artist lookup for {Name}", Sanitize(request.Name));
            return false;
        }

        _logger.LogInformation("Requesting artist: {Name} ({MusicBrainzId})", Sanitize(request.Name), Sanitize(musicBrainzId));
        return await _lidarrService.AddArtistAsync(musicBrainzId, request.Name);
    }

    public async Task<bool> RequestAlbumAsync(AcquisitionRequestDto request)
    {
        var albumTitle = request.AlbumTitle ?? request.Name;
        var musicBrainzId = request.MusicBrainzId;
        var artistName = request.ArtistName;
        string? artistMusicBrainzId = null;

        if (string.IsNullOrWhiteSpace(musicBrainzId))
        {
            var lookupQuery = string.IsNullOrWhiteSpace(request.ArtistName)
                ? albumTitle
                : $"{request.ArtistName} {albumTitle}";
            var matches = await _lidarrService.SearchAlbumsAsync(lookupQuery);
            var match = matches
                .OrderByDescending(album => IsExactAlbumMatch(album.Title, albumTitle, album.ArtistName, request.ArtistName))
                .ThenBy(album => album.Title)
                .FirstOrDefault(album => !string.IsNullOrWhiteSpace(album.MusicBrainzId));

            if (match is not null)
            {
                musicBrainzId ??= match.MusicBrainzId;
                artistName ??= match.ArtistName;
                artistMusicBrainzId ??= match.ArtistMusicBrainzId;
            }
        }

        if (string.IsNullOrWhiteSpace(musicBrainzId))
        {
            _logger.LogWarning("Unable to resolve Lidarr album lookup for {Artist} - {Album}", Sanitize(request.ArtistName ?? string.Empty), Sanitize(albumTitle));
            return false;
        }

        if (string.IsNullOrWhiteSpace(artistMusicBrainzId) && !string.IsNullOrWhiteSpace(artistName))
        {
            var artistMatches = await _lidarrService.SearchArtistsAsync(artistName);
            artistMusicBrainzId = artistMatches
                .OrderByDescending(artist => IsExactArtistMatch(artist.Name, artistName))
                .ThenBy(artist => artist.Name)
                .Select(artist => artist.MusicBrainzId)
                .FirstOrDefault(id => !string.IsNullOrWhiteSpace(id));
        }

        if (string.IsNullOrWhiteSpace(artistMusicBrainzId) || string.IsNullOrWhiteSpace(artistName))
        {
            _logger.LogWarning("Unable to resolve Lidarr artist lookup for album {Artist} - {Album}", Sanitize(request.ArtistName ?? string.Empty), Sanitize(albumTitle));
            return false;
        }

        _logger.LogInformation("Requesting album: {Name} ({MusicBrainzId})", Sanitize(albumTitle), Sanitize(musicBrainzId));
        return await _lidarrService.AddAlbumAsync(musicBrainzId, artistMusicBrainzId, artistName);
    }

    public async Task<AcquisitionStatus> GetStatusAsync(string musicBrainzId, string type)
    {
        return type.ToLowerInvariant() switch
        {
            "artist" => await _lidarrService.GetArtistStatusAsync(musicBrainzId),
            "album" => await _lidarrService.GetAlbumStatusAsync(musicBrainzId),
            _ => AcquisitionStatus.None
        };
    }

    private static bool IsExactArtistMatch(string artistName, string query)
    {
        return Normalize(artistName) == Normalize(query);
    }

    private static bool IsExactAlbumMatch(string albumTitle, string expectedAlbumTitle, string? artistName, string? expectedArtistName)
    {
        if (Normalize(albumTitle) != Normalize(expectedAlbumTitle))
            return false;

        return string.IsNullOrWhiteSpace(expectedArtistName)
            || Normalize(artistName) == Normalize(expectedArtistName);
    }

    private static string Normalize(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return string.Empty;

        return new string(value.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());
    }

    private static string Sanitize(string input)
    {
        return input.Replace("\n", string.Empty).Replace("\r", string.Empty).Replace("\t", string.Empty);
    }
}
