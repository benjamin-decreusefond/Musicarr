using Musicarr.Application.DTOs;
using Musicarr.Application.Interfaces;
using Musicarr.Domain.Enums;
using Musicarr.Domain.Interfaces;
using Microsoft.Extensions.Logging;

namespace Musicarr.Application.Services;

public class CatalogService : ICatalogService
{
    private readonly IJellyfinService _jellyfinService;
    private readonly ILogger<CatalogService> _logger;

    public CatalogService(IJellyfinService jellyfinService, ILogger<CatalogService> logger)
    {
        _jellyfinService = jellyfinService;
        _logger = logger;
    }

    public async Task<IEnumerable<ArtistDto>> GetArtistsAsync(string token)
    {
        var artists = await _jellyfinService.GetArtistsAsync(token);
        return artists.Select(a => new ArtistDto(
            a.Id, a.Name, a.MusicBrainzId, a.JellyfinId, a.ImageUrl,
            a.Overview, a.Genres, MediaAvailability.Available
        ));
    }

    public async Task<IEnumerable<AlbumDto>> GetAlbumsAsync(string token, Guid? artistId = null)
    {
        var albums = await _jellyfinService.GetAlbumsAsync(token, artistId?.ToString());
        return albums.Select(a => new AlbumDto(
            a.Id, a.Title, a.ArtistName, a.ArtistId, a.MusicBrainzId, a.JellyfinId,
            a.ImageUrl, a.Year, a.Overview, a.Genres, MediaAvailability.Available
        ));
    }

    public async Task<IEnumerable<TrackDto>> GetTracksAsync(string token, Guid? albumId = null)
    {
        var tracks = await _jellyfinService.GetTracksAsync(token, albumId?.ToString());
        return tracks.Select(t => new TrackDto(
            t.Id, t.Title, t.ArtistName, null, t.AlbumId, t.JellyfinId,
            t.TrackNumber, t.DiscNumber, t.DurationTicks, t.StreamUrl,
            MediaAvailability.Available
        ));
    }

    public async Task<AlbumDto?> GetAlbumByIdAsync(string token, Guid albumId)
    {
        var albums = await _jellyfinService.GetAlbumsAsync(token);
        var album = albums.FirstOrDefault(a => a.Id == albumId || a.JellyfinId == albumId.ToString());
        if (album == null) return null;

        var tracks = await _jellyfinService.GetTracksAsync(token, album.JellyfinId);
        var trackDtos = tracks.Select(t => new TrackDto(
            t.Id, t.Title, t.ArtistName, album.Title, t.AlbumId, t.JellyfinId,
            t.TrackNumber, t.DiscNumber, t.DurationTicks, t.StreamUrl,
            MediaAvailability.Available
        )).ToList();

        return new AlbumDto(
            album.Id, album.Title, album.ArtistName, album.ArtistId,
            album.MusicBrainzId, album.JellyfinId, album.ImageUrl,
            album.Year, album.Overview, album.Genres, MediaAvailability.Available, trackDtos
        );
    }

    public async Task<ArtistDto?> GetArtistByIdAsync(string token, Guid artistId)
    {
        var artists = await _jellyfinService.GetArtistsAsync(token);
        var artist = artists.FirstOrDefault(a => a.Id == artistId || a.JellyfinId == artistId.ToString());
        if (artist == null) return null;

        return new ArtistDto(
            artist.Id, artist.Name, artist.MusicBrainzId, artist.JellyfinId,
            artist.ImageUrl, artist.Overview, artist.Genres, MediaAvailability.Available
        );
    }
}
