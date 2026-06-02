using Musicarr.Domain.Enums;

namespace Musicarr.Application.DTOs;

public record TrackDto(
    string Id,
    string Title,
    string? ArtistName,
    string? ArtistId,
    string? AlbumTitle,
    string? AlbumId,
    string? JellyfinId,
    int TrackNumber,
    int DiscNumber,
    long? DurationTicks,
    string? StreamUrl,
    MediaAvailability Availability,
    string? ImageUrl = null
);
