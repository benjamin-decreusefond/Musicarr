using Microsoft.AspNetCore.Mvc;
using Musicarr.Application.DTOs;
using Musicarr.Application.Interfaces;

namespace Musicarr.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class RequestsController : ControllerBase
{
    private readonly IRequestService _requestService;

    public RequestsController(IRequestService requestService)
    {
        _requestService = requestService;
    }

    [HttpGet]
    [ProducesResponseType(typeof(List<RequestDto>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetAll()
    {
        var requests = await _requestService.GetRequestsAsync();
        return Ok(requests);
    }

    [HttpPost]
    [ProducesResponseType(typeof(RequestDto), StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> Create([FromBody] CreateRequestDto request)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(new { Message = "Name is required" });

        if (request.Type != "album" && request.Type != "track")
            return BadRequest(new { Message = "Type must be 'album' or 'track'" });

        var result = await _requestService.CreateRequestAsync(request);
        if (result is null)
            return BadRequest(new { Message = "Failed to create request" });

        return CreatedAtAction(nameof(GetAll), result);
    }

    [HttpDelete("{id:int}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Cancel(int id)
    {
        var success = await _requestService.CancelRequestAsync(id);
        return success ? NoContent() : NotFound(new { Message = "Request not found or cannot be cancelled" });
    }

    [HttpPost("sync")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<IActionResult> Sync()
    {
        await _requestService.SyncStatusesAsync();
        return NoContent();
    }
}
