using Musicarr.Domain.Enums;

namespace Musicarr.Application.DTOs;

public record TrackDto(
    Guid Id,
    string Title,
    string? ArtistName,
    string? AlbumTitle,
    Guid? AlbumId,
    string? JellyfinId,
    int TrackNumber,
    int DiscNumber,
    long? DurationTicks,
    string? StreamUrl,
    MediaAvailability Availability,
    string? ImageUrl = null
);
