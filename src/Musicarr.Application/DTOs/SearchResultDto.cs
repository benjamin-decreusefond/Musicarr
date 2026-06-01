namespace Musicarr.Application.DTOs;

public record SearchResultDto(
    List<ArtistDto> Artists,
    List<AlbumDto> Albums,
    List<TrackDto> Tracks
);
