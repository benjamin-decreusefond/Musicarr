namespace Musicarr.Application.DTOs;

public record AcquisitionRequestDto(
    string MusicBrainzId,
    string Name,
    string Type // "artist" or "album"
);
