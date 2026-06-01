using Musicarr.Domain.Enums;

namespace Musicarr.Application.DTOs;

public record AlbumDto(
    Guid Id,
    string Title,
    string? ArtistName,
    Guid? ArtistId,
    string? MusicBrainzId,
    string? JellyfinId,
    string? ImageUrl,
    int? Year,
    string? Overview,
    List<string> Genres,
    MediaAvailability Availability,
    List<TrackDto>? Tracks = null
);
