using Musicarr.Domain.Entities;

namespace Musicarr.Domain.Interfaces;

public interface IJellyfinService
{
    Task<IEnumerable<Artist>> GetArtistsAsync();
    Task<IEnumerable<Album>> GetAlbumsAsync(string? artistId = null);
    Task<IEnumerable<Track>> GetTracksAsync(string? albumId = null);
    Task<string?> GetStreamUrlAsync(string itemId);
    Task<string?> GetImageUrlAsync(string itemId);
    Task<bool> RefreshLibraryAsync();
    Task<IEnumerable<Playlist>> GetPlaylistsAsync();
    Task<Playlist?> CreatePlaylistAsync(string name, IEnumerable<string> trackIds);
    Task<bool> DeletePlaylistAsync(string playlistId);
    Task<bool> AddToPlaylistAsync(string playlistId, IEnumerable<string> trackIds);
    Task<bool> RemoveFromPlaylistAsync(string playlistId, IEnumerable<string> trackIds);
}
