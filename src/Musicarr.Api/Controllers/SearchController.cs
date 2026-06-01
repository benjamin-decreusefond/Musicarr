using Microsoft.AspNetCore.Mvc;
using Musicarr.Api.Extensions;
using Musicarr.Application.DTOs;
using Musicarr.Application.Interfaces;

namespace Musicarr.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class SearchController : ControllerBase
{
    private readonly ISearchService _searchService;

    public SearchController(ISearchService searchService)
    {
        _searchService = searchService;
    }

    [HttpGet]
    [ProducesResponseType(typeof(SearchResultDto), StatusCodes.Status200OK)]
    public async Task<IActionResult> Search([FromQuery] string q)
    {
        if (string.IsNullOrWhiteSpace(q))
            return BadRequest(new { Message = "Search query is required" });

        var token = HttpContext.GetToken();
        if (string.IsNullOrEmpty(token)) return Unauthorized();

        var results = await _searchService.SearchAsync(q, token);
        return Ok(results);
    }
}
