using Microsoft.AspNetCore.Mvc;
using Musicarr.Application.Interfaces;

namespace Musicarr.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class DiscoverController : ControllerBase
{
    private readonly IDiscoverService _discoverService;

    public DiscoverController(IDiscoverService discoverService)
    {
        _discoverService = discoverService;
    }

    [HttpGet]
    public async Task<IActionResult> GetSections()
    {
        var sections = await _discoverService.GetDiscoverSectionsAsync();
        return Ok(sections);
    }

    [HttpGet("related/{artistId}")]
    public async Task<IActionResult> GetRelatedArtists(string artistId)
    {
        if (string.IsNullOrWhiteSpace(artistId))
            return BadRequest(new { Message = "Artist ID is required" });

        var artists = await _discoverService.GetRelatedArtistsAsync(artistId);
        return Ok(artists);
    }
}
