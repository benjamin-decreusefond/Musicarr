namespace Musicarr.Domain.Entities;

public class PlaylistTrack
{
    public Guid Id { get; set; }
    public Guid PlaylistId { get; set; }
    public Guid TrackId { get; set; }
    public int Order { get; set; }
    public DateTime AddedAt { get; set; } = DateTime.UtcNow;
    public Playlist? Playlist { get; set; }
    public Track? Track { get; set; }
}
