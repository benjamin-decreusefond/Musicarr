namespace Musicarr.Application.DTOs;

public record RequestDto(
    int Id,
    string Type,
    string Title,
    string? ArtistName,
    string? DeezerAlbumId,
    string? MusicBrainzId,
    string Status,
    DateTime RequestedAt,
    DateTime? CompletedAt
);

public record CreateRequestDto(
    string Type,
    string Name,
    string? ArtistName = null,
    string? AlbumTitle = null,
    string? MusicBrainzId = null,
    string? DeezerAlbumId = null
);
