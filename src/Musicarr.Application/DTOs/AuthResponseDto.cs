namespace Musicarr.Application.DTOs;

public record AuthResponseDto(
    string Token,
    string UserId,
    string Username,
    DateTime ExpiresAt
);
