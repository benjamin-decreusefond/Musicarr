using Musicarr.Application.DTOs;
using Musicarr.Application.Interfaces;
using Musicarr.Domain.Enums;
using Musicarr.Domain.Interfaces;
using Microsoft.Extensions.Logging;

namespace Musicarr.Application.Services;

public class PlaylistService : IPlaylistService
{
    private readonly IJellyfinService _jellyfinService;
    private readonly ILogger<PlaylistService> _logger;

    public PlaylistService(IJellyfinService jellyfinService, ILogger<PlaylistService> logger)
    {
        _jellyfinService = jellyfinService;
        _logger = logger;
    }

    public async Task<IEnumerable<PlaylistDto>> GetPlaylistsAsync()
    {
        var playlists = await _jellyfinService.GetPlaylistsAsync();
        return playlists.Select(p => new PlaylistDto(
            p.Id, p.Name, p.Description, p.ImageUrl,
            p.Tracks.Count, p.CreatedAt, p.UpdatedAt
        ));
    }

    public async Task<PlaylistDto?> GetPlaylistAsync(Guid playlistId)
    {
        return null;
    }

    public async Task<PlaylistDto?> CreatePlaylistAsync(string name, string? description = null)
    {
        var playlist = await _jellyfinService.CreatePlaylistAsync(name, Enumerable.Empty<string>());
        if (playlist == null) return null;

        return new PlaylistDto(
            playlist.Id, playlist.Name, description, playlist.ImageUrl,
            0, DateTime.UtcNow, DateTime.UtcNow
        );
    }

    public async Task<bool> DeletePlaylistAsync(Guid playlistId)
    {
        return await _jellyfinService.DeletePlaylistAsync(playlistId.ToString());
    }

    public async Task<bool> AddTrackAsync(Guid playlistId, Guid trackId)
    {
        return await _jellyfinService.AddToPlaylistAsync(playlistId.ToString(), new[] { trackId.ToString() });
    }

    public async Task<bool> RemoveTrackAsync(Guid playlistId, Guid trackId)
    {
        return await _jellyfinService.RemoveFromPlaylistAsync(playlistId.ToString(), new[] { trackId.ToString() });
    }

    public Task<bool> ReorderTracksAsync(Guid playlistId, List<Guid> trackIds)
    {
        _logger.LogWarning("Reorder not yet implemented for Jellyfin playlists");
        return Task.FromResult(false);
    }
}
