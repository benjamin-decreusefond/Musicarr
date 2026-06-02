namespace Musicarr.Application.DTOs;

public record DiscoverSectionDto(
    string Id,
    string Title,
    string ContentType,
    List<AlbumDto>? Albums = null,
    List<ArtistDto>? Artists = null
);
