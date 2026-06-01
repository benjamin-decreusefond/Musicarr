using Musicarr.Application.DTOs;

namespace Musicarr.Application.Interfaces;

public interface IPlaylistService
{
    Task<IEnumerable<PlaylistDto>> GetPlaylistsAsync(string token, string userId);
    Task<PlaylistDto?> GetPlaylistAsync(string token, Guid playlistId);
    Task<PlaylistDto?> CreatePlaylistAsync(string token, string userId, string name, string? description = null);
    Task<bool> DeletePlaylistAsync(string token, Guid playlistId);
    Task<bool> AddTrackAsync(string token, Guid playlistId, Guid trackId);
    Task<bool> RemoveTrackAsync(string token, Guid playlistId, Guid trackId);
    Task<bool> ReorderTracksAsync(string token, Guid playlistId, List<Guid> trackIds);
}
