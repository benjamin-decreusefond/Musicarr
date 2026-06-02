using Musicarr.Domain.Enums;

namespace Musicarr.Application.DTOs;

public record AlbumDto(
    string Id,
    string Title,
    string? ArtistName,
    string? ArtistId,
    string? MusicBrainzId,
    string? JellyfinId,
    string? ImageUrl,
    int? Year,
    string? Overview,
    List<string> Genres,
    MediaAvailability Availability,
    List<TrackDto>? Tracks = null
);
