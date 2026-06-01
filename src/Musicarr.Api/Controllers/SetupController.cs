using Microsoft.AspNetCore.Mvc;
using Musicarr.Application.DTOs;
using Musicarr.Application.Interfaces;

namespace Musicarr.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class SetupController : ControllerBase
{
    private readonly IAdminUserService _adminUserService;

    public SetupController(IAdminUserService adminUserService)
    {
        _adminUserService = adminUserService;
    }

    [HttpGet("status")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<IActionResult> GetStatus()
    {
        var hasAdminUser = await _adminUserService.HasAdminUserAsync();
        return Ok(new { HasAdminUser = hasAdminUser });
    }

    [HttpPost("create-admin")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<IActionResult> CreateAdmin([FromBody] CreateAdminDto request)
    {
        if (string.IsNullOrWhiteSpace(request.Username) || string.IsNullOrWhiteSpace(request.Password))
            return BadRequest(new { Message = "Username and password are required" });

        if (request.Password.Length < 8)
            return BadRequest(new { Message = "Password must be at least 8 characters" });

        if (await _adminUserService.HasAdminUserAsync())
            return Conflict(new { Message = "An admin account already exists" });

        var success = await _adminUserService.CreateAdminUserAsync(request.Username, request.Password);
        if (!success)
            return BadRequest(new { Message = "Failed to create admin account" });

        return Ok(new { Message = "Admin account created successfully" });
    }
}
