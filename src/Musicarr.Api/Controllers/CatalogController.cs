using Microsoft.AspNetCore.Mvc;
using Musicarr.Application.DTOs;
using Musicarr.Application.Interfaces;

namespace Musicarr.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class CatalogController : ControllerBase
{
    private readonly ICatalogService _catalogService;

    public CatalogController(ICatalogService catalogService)
    {
        _catalogService = catalogService;
    }

    [HttpGet("artists")]
    [ProducesResponseType(typeof(IEnumerable<ArtistDto>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetArtists()
    {
        var artists = await _catalogService.GetArtistsAsync();
        return Ok(artists);
    }

    [HttpGet("artists/{id}")]
    [ProducesResponseType(typeof(ArtistDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetArtist(string id)
    {
        var artist = await _catalogService.GetArtistByIdAsync(id);
        return artist != null ? Ok(artist) : NotFound();
    }

    [HttpGet("albums")]
    [ProducesResponseType(typeof(IEnumerable<AlbumDto>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetAlbums([FromQuery] string? artistId = null)
    {
        var albums = await _catalogService.GetAlbumsAsync(artistId);
        return Ok(albums);
    }

    [HttpGet("albums/{id}")]
    [ProducesResponseType(typeof(AlbumDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetAlbum(string id)
    {
        var album = await _catalogService.GetAlbumByIdAsync(id);
        return album != null ? Ok(album) : NotFound();
    }

    [HttpGet("tracks")]
    [ProducesResponseType(typeof(IEnumerable<TrackDto>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetTracks([FromQuery] string? albumId = null, [FromQuery] string? artistId = null)
    {
        var tracks = await _catalogService.GetTracksAsync(albumId, artistId);
        return Ok(tracks);
    }
}
