namespace Musicarr.Application.DTOs;

public record AcquisitionRequestDto(
    string? MusicBrainzId,
    string Name,
    string Type,
    string? ArtistName = null,
    string? AlbumTitle = null
);
