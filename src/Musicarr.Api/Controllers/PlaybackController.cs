using Microsoft.AspNetCore.Mvc;
using Musicarr.Api.Extensions;
using Musicarr.Application.Interfaces;

namespace Musicarr.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class PlaybackController : ControllerBase
{
    private readonly IPlaybackService _playbackService;

    public PlaybackController(IPlaybackService playbackService)
    {
        _playbackService = playbackService;
    }

    [HttpGet("stream/{itemId}")]
    [ProducesResponseType(typeof(object), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetStreamUrl(string itemId)
    {
        var token = HttpContext.GetToken();
        if (string.IsNullOrEmpty(token)) return Unauthorized();

        var url = await _playbackService.GetStreamUrlAsync(token, itemId);
        if (string.IsNullOrEmpty(url)) return NotFound();

        return Ok(new { StreamUrl = url });
    }
}
