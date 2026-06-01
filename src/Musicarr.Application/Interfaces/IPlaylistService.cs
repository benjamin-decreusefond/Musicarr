using Musicarr.Application.DTOs;

namespace Musicarr.Application.Interfaces;

public interface IPlaylistService
{
    Task<IEnumerable<PlaylistDto>> GetPlaylistsAsync();
    Task<PlaylistDto?> GetPlaylistAsync(Guid playlistId);
    Task<PlaylistDto?> CreatePlaylistAsync(string name, string? description = null);
    Task<bool> DeletePlaylistAsync(Guid playlistId);
    Task<bool> AddTrackAsync(Guid playlistId, Guid trackId);
    Task<bool> RemoveTrackAsync(Guid playlistId, Guid trackId);
    Task<bool> ReorderTracksAsync(Guid playlistId, List<Guid> trackIds);
}
