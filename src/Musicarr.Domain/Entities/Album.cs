namespace Musicarr.Domain.Entities;

public class Album
{
    public Guid Id { get; set; }
    public string Title { get; set; } = string.Empty;
    public Guid ArtistId { get; set; }
    public string? ArtistName { get; set; }
    public string? DeezerId { get; set; }
    public string? DeezerArtistId { get; set; }
    public string? MusicBrainzId { get; set; }
    public string? JellyfinId { get; set; }
    public string? LidarrId { get; set; }
    public string? ImageUrl { get; set; }
    public int? Year { get; set; }
    public string? Overview { get; set; }
    public List<string> Genres { get; set; } = new();
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public Artist? Artist { get; set; }
    public ICollection<Track> Tracks { get; set; } = new List<Track>();
}
