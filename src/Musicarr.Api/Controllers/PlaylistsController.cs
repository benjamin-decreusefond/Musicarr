using Microsoft.AspNetCore.Mvc;
using Musicarr.Application.DTOs;
using Musicarr.Application.Interfaces;

namespace Musicarr.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class PlaylistsController : ControllerBase
{
    private readonly IPlaylistService _playlistService;

    public PlaylistsController(IPlaylistService playlistService)
    {
        _playlistService = playlistService;
    }

    [HttpGet]
    [ProducesResponseType(typeof(IEnumerable<PlaylistDto>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetPlaylists()
    {
        var playlists = await _playlistService.GetPlaylistsAsync();
        return Ok(playlists);
    }

    [HttpGet("{id}")]
    [ProducesResponseType(typeof(PlaylistDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetPlaylist(Guid id)
    {
        var playlist = await _playlistService.GetPlaylistAsync(id);
        return playlist != null ? Ok(playlist) : NotFound();
    }

    [HttpPost]
    [ProducesResponseType(typeof(PlaylistDto), StatusCodes.Status201Created)]
    public async Task<IActionResult> CreatePlaylist([FromBody] CreatePlaylistRequest request)
    {
        var playlist = await _playlistService.CreatePlaylistAsync(request.Name, request.Description);
        if (playlist == null) return BadRequest(new { Message = "Failed to create playlist" });

        return CreatedAtAction(nameof(GetPlaylist), new { id = playlist.Id }, playlist);
    }

    [HttpDelete("{id}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<IActionResult> DeletePlaylist(Guid id)
    {
        await _playlistService.DeletePlaylistAsync(id);
        return NoContent();
    }

    [HttpPost("{id}/tracks")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<IActionResult> AddTrack(Guid id, [FromBody] AddTrackRequest request)
    {
        var result = await _playlistService.AddTrackAsync(id, request.TrackId);
        return result ? Ok() : BadRequest(new { Message = "Failed to add track" });
    }

    [HttpDelete("{id}/tracks/{trackId}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<IActionResult> RemoveTrack(Guid id, Guid trackId)
    {
        await _playlistService.RemoveTrackAsync(id, trackId);
        return NoContent();
    }
}

public record CreatePlaylistRequest(string Name, string? Description = null);
public record AddTrackRequest(Guid TrackId);
