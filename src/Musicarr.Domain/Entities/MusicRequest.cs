namespace Musicarr.Domain.Entities;

public class MusicRequest
{
    public int Id { get; set; }
    public string Type { get; set; } = "album";
    public string Title { get; set; } = string.Empty;
    public string? ArtistName { get; set; }
    public string? DeezerAlbumId { get; set; }
    public string? MusicBrainzId { get; set; }
    public string Status { get; set; } = "Pending";
    public DateTime RequestedAt { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedAt { get; set; }
}
