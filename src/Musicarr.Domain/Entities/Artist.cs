namespace Musicarr.Domain.Entities;

public class Artist
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? DeezerId { get; set; }
    public string? MusicBrainzId { get; set; }
    public string? JellyfinId { get; set; }
    public string? LidarrId { get; set; }
    public string? ImageUrl { get; set; }
    public string? Overview { get; set; }
    public List<string> Genres { get; set; } = new();
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public ICollection<Album> Albums { get; set; } = new List<Album>();
}
