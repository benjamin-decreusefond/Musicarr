using Musicarr.Domain.Entities;

namespace Musicarr.Domain.Interfaces;

public interface IJellyfinService
{
    Task<(bool Success, string? Token, string? UserId)> AuthenticateAsync(string username, string password);
    Task<IEnumerable<Artist>> GetArtistsAsync(string token);
    Task<IEnumerable<Album>> GetAlbumsAsync(string token, string? artistId = null);
    Task<IEnumerable<Track>> GetTracksAsync(string token, string? albumId = null);
    Task<string?> GetStreamUrlAsync(string token, string itemId);
    Task<string?> GetImageUrlAsync(string itemId);
    Task<bool> RefreshLibraryAsync(string token);
    Task<IEnumerable<Playlist>> GetPlaylistsAsync(string token, string userId);
    Task<Playlist?> CreatePlaylistAsync(string token, string userId, string name, IEnumerable<string> trackIds);
    Task<bool> DeletePlaylistAsync(string token, string playlistId);
    Task<bool> AddToPlaylistAsync(string token, string playlistId, IEnumerable<string> trackIds);
    Task<bool> RemoveFromPlaylistAsync(string token, string playlistId, IEnumerable<string> trackIds);
}
