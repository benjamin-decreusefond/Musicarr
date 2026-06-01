using Musicarr.Application.DTOs;

namespace Musicarr.Application.Interfaces;

public interface IAuthenticationService
{
    Task<AuthResponseDto?> LoginAsync(AuthRequestDto request);
    Task<bool> ValidateTokenAsync(string token);
}
