using Musicarr.Application.DTOs;
using Musicarr.Application.Interfaces;
using Musicarr.Domain.Interfaces;
using Microsoft.Extensions.Logging;

namespace Musicarr.Application.Services;

public class AuthenticationService : IAuthenticationService
{
    private readonly IJellyfinService _jellyfinService;
    private readonly ILogger<AuthenticationService> _logger;

    public AuthenticationService(IJellyfinService jellyfinService, ILogger<AuthenticationService> logger)
    {
        _jellyfinService = jellyfinService;
        _logger = logger;
    }

    public async Task<AuthResponseDto?> LoginAsync(AuthRequestDto request)
    {
        _logger.LogInformation("Attempting authentication for user {Username}", request.Username);
        
        var (success, token, userId) = await _jellyfinService.AuthenticateAsync(request.Username, request.Password);
        
        if (!success || string.IsNullOrEmpty(token) || string.IsNullOrEmpty(userId))
        {
            _logger.LogWarning("Authentication failed for user {Username}", request.Username);
            return null;
        }

        _logger.LogInformation("Authentication successful for user {Username}", request.Username);
        
        return new AuthResponseDto(
            Token: token,
            UserId: userId,
            Username: request.Username,
            ExpiresAt: DateTime.UtcNow.AddHours(24)
        );
    }

    public Task<bool> ValidateTokenAsync(string token)
    {
        return Task.FromResult(!string.IsNullOrEmpty(token));
    }
}
