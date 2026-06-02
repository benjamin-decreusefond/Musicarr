using Musicarr.Domain.Enums;

namespace Musicarr.Domain.Interfaces;

public interface ILidarrService
{
    Task<IEnumerable<Domain.Entities.Artist>> SearchArtistsAsync(string query);
    Task<IEnumerable<Domain.Entities.Album>> SearchAlbumsAsync(string query);
    Task<bool> AddArtistAsync(string musicBrainzId, string artistName);
    Task<bool> AddAlbumAsync(string musicBrainzId, string artistMusicBrainzId, string artistName);
    Task<AcquisitionStatus> GetArtistStatusAsync(string musicBrainzId);
    Task<AcquisitionStatus> GetAlbumStatusAsync(string musicBrainzId);
    Task<bool> RefreshArtistAsync(string lidarrId);
}
