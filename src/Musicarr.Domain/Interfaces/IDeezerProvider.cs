namespace Musicarr.Domain.Interfaces;

public interface IDeezerProvider
{
    Task<IEnumerable<Domain.Entities.Artist>> SearchArtistsAsync(string query);
    Task<IEnumerable<Domain.Entities.Album>> SearchAlbumsAsync(string query);
    Task<IEnumerable<Domain.Entities.Track>> SearchTracksAsync(string query);
    Task<Domain.Entities.Artist?> GetArtistAsync(string artistId);
    Task<IEnumerable<Domain.Entities.Album>> GetArtistAlbumsAsync(string artistId);
    Task<IEnumerable<Domain.Entities.Track>> GetArtistTopTracksAsync(string artistId);
    Task<Domain.Entities.Album?> GetAlbumAsync(string albumId);
    Task<IEnumerable<Domain.Entities.Artist>> GetChartArtistsAsync();
    Task<IEnumerable<Domain.Entities.Album>> GetChartAlbumsAsync();
    Task<IEnumerable<Domain.Entities.Track>> GetChartTracksAsync();
    Task<IEnumerable<Domain.Entities.Artist>> GetRelatedArtistsAsync(string artistId);
    Task<IEnumerable<Domain.Entities.Album>> GetNewReleasesAsync();
    Task<IEnumerable<Domain.Entities.Album>> GetGenreAlbumsAsync(int genreId);
    Task<IEnumerable<Domain.Entities.Artist>> GetGenreArtistsAsync(int genreId);
}
