using Microsoft.EntityFrameworkCore;
using Musicarr.Domain.Entities;

namespace Musicarr.Infrastructure.Persistence;

public class MusicarrDbContext : DbContext
{
    public MusicarrDbContext(DbContextOptions<MusicarrDbContext> options) : base(options) { }

    public DbSet<Playlist> Playlists => Set<Playlist>();
    public DbSet<PlaylistTrack> PlaylistTracks => Set<PlaylistTrack>();
    public DbSet<AdminUser> AdminUsers => Set<AdminUser>();
    public DbSet<MusicRequest> MusicRequests => Set<MusicRequest>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Playlist>(entity =>
        {
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Name).IsRequired().HasMaxLength(200);
            entity.Property(e => e.UserId).IsRequired();
            entity.HasMany(e => e.Tracks).WithOne(e => e.Playlist).HasForeignKey(e => e.PlaylistId);
        });

        modelBuilder.Entity<PlaylistTrack>(entity =>
        {
            entity.HasKey(e => e.Id);
            entity.HasIndex(e => new { e.PlaylistId, e.TrackId }).IsUnique();
        });

        modelBuilder.Entity<AdminUser>(entity =>
        {
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Username).IsRequired().HasMaxLength(100);
            entity.HasIndex(e => e.Username).IsUnique();
            entity.Property(e => e.PasswordHash).IsRequired();
        });

        modelBuilder.Entity<MusicRequest>(entity =>
        {
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Type).IsRequired().HasMaxLength(20);
            entity.Property(e => e.Title).IsRequired().HasMaxLength(500);
            entity.Property(e => e.ArtistName).HasMaxLength(500);
            entity.Property(e => e.Status).IsRequired().HasMaxLength(50);
        });
    }
}
