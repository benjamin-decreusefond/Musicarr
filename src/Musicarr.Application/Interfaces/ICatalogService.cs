using Musicarr.Application.DTOs;

namespace Musicarr.Application.Interfaces;

public interface ICatalogService
{
    Task<IEnumerable<ArtistDto>> GetArtistsAsync(string token);
    Task<IEnumerable<AlbumDto>> GetAlbumsAsync(string token, Guid? artistId = null);
    Task<IEnumerable<TrackDto>> GetTracksAsync(string token, Guid? albumId = null);
    Task<AlbumDto?> GetAlbumByIdAsync(string token, Guid albumId);
    Task<ArtistDto?> GetArtistByIdAsync(string token, Guid artistId);
}
