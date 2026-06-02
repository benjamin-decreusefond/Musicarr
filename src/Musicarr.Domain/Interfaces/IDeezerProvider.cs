using Musicarr.Domain.Entities;

namespace Musicarr.Domain.Interfaces;

public interface IDeezerProvider
{
    Task<IEnumerable<Artist>> SearchArtistsAsync(string query);
    Task<IEnumerable<Album>> SearchAlbumsAsync(string query);
    Task<IEnumerable<Track>> SearchTracksAsync(string query);
    Task<Artist?> GetArtistAsync(string artistId);
    Task<IEnumerable<Album>> GetArtistAlbumsAsync(string artistId);
    Task<IEnumerable<Track>> GetArtistTopTracksAsync(string artistId);
    Task<Album?> GetAlbumAsync(string albumId);
    Task<IEnumerable<Artist>> GetChartArtistsAsync();
    Task<IEnumerable<Album>> GetChartAlbumsAsync();
    Task<IEnumerable<Track>> GetChartTracksAsync();
}
