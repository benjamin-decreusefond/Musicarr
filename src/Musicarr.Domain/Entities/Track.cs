namespace Musicarr.Domain.Entities;

public class Track
{
    public Guid Id { get; set; }
    public string Title { get; set; } = string.Empty;
    public Guid AlbumId { get; set; }
    public string? ArtistName { get; set; }
    public string? JellyfinId { get; set; }
    public int TrackNumber { get; set; }
    public int DiscNumber { get; set; } = 1;
    public long? DurationTicks { get; set; }
    public string? StreamUrl { get; set; }
    public string? ImageUrl { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public Album? Album { get; set; }
}
