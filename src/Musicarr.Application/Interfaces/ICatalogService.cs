using Musicarr.Application.DTOs;

namespace Musicarr.Application.Interfaces;

public interface ICatalogService
{
    Task<IEnumerable<ArtistDto>> GetArtistsAsync();
    Task<IEnumerable<AlbumDto>> GetAlbumsAsync(string? artistId = null);
    Task<IEnumerable<TrackDto>> GetTracksAsync(string? albumId = null, string? artistId = null);
    Task<AlbumDto?> GetAlbumByIdAsync(string albumId);
    Task<ArtistDto?> GetArtistByIdAsync(string artistId);
}
