using Musicarr.Domain.Enums;

namespace Musicarr.Application.DTOs;

public record ArtistDto(
    string Id,
    string Name,
    string? MusicBrainzId,
    string? JellyfinId,
    string? ImageUrl,
    string? Overview,
    List<string> Genres,
    MediaAvailability Availability,
    List<TrackDto>? TopTracks = null
);
