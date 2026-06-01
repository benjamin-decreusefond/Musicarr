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

    public async Task<IEnumerable<PlaylistDto>> GetPlaylistsAsync(string token, string userId)
    {
        var playlists = await _jellyfinService.GetPlaylistsAsync(token, userId);
        return playlists.Select(p => new PlaylistDto(
            p.Id, p.Name, p.Description, p.ImageUrl,
            p.Tracks.Count, p.CreatedAt, p.UpdatedAt
        ));
    }

    public async Task<PlaylistDto?> GetPlaylistAsync(string token, Guid playlistId)
    {
        // For now, return basic info
        return null;
    }

    public async Task<PlaylistDto?> CreatePlaylistAsync(string token, string userId, string name, string? description = null)
    {
        var playlist = await _jellyfinService.CreatePlaylistAsync(token, userId, name, Enumerable.Empty<string>());
        if (playlist == null) return null;

        return new PlaylistDto(
            playlist.Id, playlist.Name, description, playlist.ImageUrl,
            0, DateTime.UtcNow, DateTime.UtcNow
        );
    }

    public async Task<bool> DeletePlaylistAsync(string token, Guid playlistId)
    {
        return await _jellyfinService.DeletePlaylistAsync(token, playlistId.ToString());
    }

    public async Task<bool> AddTrackAsync(string token, Guid playlistId, Guid trackId)
    {
        return await _jellyfinService.AddToPlaylistAsync(token, playlistId.ToString(), new[] { trackId.ToString() });
    }

    public async Task<bool> RemoveTrackAsync(string token, Guid playlistId, Guid trackId)
    {
        return await _jellyfinService.RemoveFromPlaylistAsync(token, playlistId.ToString(), new[] { trackId.ToString() });
    }

    public Task<bool> ReorderTracksAsync(string token, Guid playlistId, List<Guid> trackIds)
    {
        // Jellyfin doesn't natively support reordering via API easily
        _logger.LogWarning("Reorder not yet implemented for Jellyfin playlists");
        return Task.FromResult(false);
    }
}
