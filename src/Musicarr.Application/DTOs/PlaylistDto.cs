namespace Musicarr.Application.DTOs;

public record PlaylistDto(
    Guid Id,
    string Name,
    string? Description,
    string? ImageUrl,
    int TrackCount,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    List<TrackDto>? Tracks = null
);
