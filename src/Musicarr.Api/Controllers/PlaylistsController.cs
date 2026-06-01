using Microsoft.AspNetCore.Mvc;
using Musicarr.Api.Extensions;
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
        var token = HttpContext.GetToken();
        var userId = HttpContext.GetUserId();
        if (string.IsNullOrEmpty(token) || string.IsNullOrEmpty(userId)) return Unauthorized();

        var playlists = await _playlistService.GetPlaylistsAsync(token, userId);
        return Ok(playlists);
    }

    [HttpGet("{id}")]
    [ProducesResponseType(typeof(PlaylistDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetPlaylist(Guid id)
    {
        var token = HttpContext.GetToken();
        if (string.IsNullOrEmpty(token)) return Unauthorized();

        var playlist = await _playlistService.GetPlaylistAsync(token, id);
        return playlist != null ? Ok(playlist) : NotFound();
    }

    [HttpPost]
    [ProducesResponseType(typeof(PlaylistDto), StatusCodes.Status201Created)]
    public async Task<IActionResult> CreatePlaylist([FromBody] CreatePlaylistRequest request)
    {
        var token = HttpContext.GetToken();
        var userId = HttpContext.GetUserId();
        if (string.IsNullOrEmpty(token) || string.IsNullOrEmpty(userId)) return Unauthorized();

        var playlist = await _playlistService.CreatePlaylistAsync(token, userId, request.Name, request.Description);
        if (playlist == null) return BadRequest(new { Message = "Failed to create playlist" });

        return CreatedAtAction(nameof(GetPlaylist), new { id = playlist.Id }, playlist);
    }

    [HttpDelete("{id}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<IActionResult> DeletePlaylist(Guid id)
    {
        var token = HttpContext.GetToken();
        if (string.IsNullOrEmpty(token)) return Unauthorized();

        await _playlistService.DeletePlaylistAsync(token, id);
        return NoContent();
    }

    [HttpPost("{id}/tracks")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<IActionResult> AddTrack(Guid id, [FromBody] AddTrackRequest request)
    {
        var token = HttpContext.GetToken();
        if (string.IsNullOrEmpty(token)) return Unauthorized();

        var result = await _playlistService.AddTrackAsync(token, id, request.TrackId);
        return result ? Ok() : BadRequest(new { Message = "Failed to add track" });
    }

    [HttpDelete("{id}/tracks/{trackId}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<IActionResult> RemoveTrack(Guid id, Guid trackId)
    {
        var token = HttpContext.GetToken();
        if (string.IsNullOrEmpty(token)) return Unauthorized();

        await _playlistService.RemoveTrackAsync(token, id, trackId);
        return NoContent();
    }
}

public record CreatePlaylistRequest(string Name, string? Description = null);
public record AddTrackRequest(Guid TrackId);
