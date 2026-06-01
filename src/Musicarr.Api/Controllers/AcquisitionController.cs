using Microsoft.AspNetCore.Mvc;
using Musicarr.Application.DTOs;
using Musicarr.Application.Interfaces;

namespace Musicarr.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class AcquisitionController : ControllerBase
{
    private readonly IAcquisitionService _acquisitionService;

    public AcquisitionController(IAcquisitionService acquisitionService)
    {
        _acquisitionService = acquisitionService;
    }

    [HttpPost("request")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> RequestMusic([FromBody] AcquisitionRequestDto request)
    {
        if (string.IsNullOrWhiteSpace(request.MusicBrainzId))
            return BadRequest(new { Message = "MusicBrainzId is required" });

        var result = request.Type.ToLowerInvariant() switch
        {
            "artist" => await _acquisitionService.RequestArtistAsync(request),
            "album" => await _acquisitionService.RequestAlbumAsync(request),
            _ => false
        };

        return result ? Ok(new { Message = "Request submitted successfully" }) : BadRequest(new { Message = "Failed to submit request" });
    }

    [HttpGet("status/{musicBrainzId}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<IActionResult> GetStatus(string musicBrainzId, [FromQuery] string type = "artist")
    {
        var status = await _acquisitionService.GetStatusAsync(musicBrainzId, type);
        return Ok(new { MusicBrainzId = musicBrainzId, Status = status.ToString() });
    }
}
