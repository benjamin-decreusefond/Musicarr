using Musicarr.Application.DTOs;

namespace Musicarr.Application.Interfaces;

public interface ICatalogService
{
    Task<IEnumerable<ArtistDto>> GetArtistsAsync();
    Task<IEnumerable<AlbumDto>> GetAlbumsAsync(Guid? artistId = null);
    Task<IEnumerable<TrackDto>> GetTracksAsync(Guid? albumId = null);
    Task<AlbumDto?> GetAlbumByIdAsync(Guid albumId);
    Task<ArtistDto?> GetArtistByIdAsync(Guid artistId);
}
