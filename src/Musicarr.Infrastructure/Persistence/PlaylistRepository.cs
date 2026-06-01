using Microsoft.EntityFrameworkCore;
using Musicarr.Domain.Entities;
using Musicarr.Domain.Interfaces;

namespace Musicarr.Infrastructure.Persistence;

public class PlaylistRepository : IPlaylistRepository
{
    private readonly MusicarrDbContext _context;

    public PlaylistRepository(MusicarrDbContext context)
    {
        _context = context;
    }

    public async Task<IEnumerable<Playlist>> GetByUserIdAsync(string userId)
    {
        return await _context.Playlists
            .Include(p => p.Tracks)
            .Where(p => p.UserId == userId)
            .OrderByDescending(p => p.UpdatedAt)
            .ToListAsync();
    }

    public async Task<Playlist?> GetByIdAsync(Guid id)
    {
        return await _context.Playlists
            .Include(p => p.Tracks)
            .FirstOrDefaultAsync(p => p.Id == id);
    }

    public async Task<Playlist> CreateAsync(Playlist playlist)
    {
        _context.Playlists.Add(playlist);
        await _context.SaveChangesAsync();
        return playlist;
    }

    public async Task<Playlist> UpdateAsync(Playlist playlist)
    {
        playlist.UpdatedAt = DateTime.UtcNow;
        _context.Playlists.Update(playlist);
        await _context.SaveChangesAsync();
        return playlist;
    }

    public async Task<bool> DeleteAsync(Guid id)
    {
        var playlist = await _context.Playlists.FindAsync(id);
        if (playlist == null) return false;
        _context.Playlists.Remove(playlist);
        await _context.SaveChangesAsync();
        return true;
    }
}
