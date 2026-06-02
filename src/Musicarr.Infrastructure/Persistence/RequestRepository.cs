using Microsoft.EntityFrameworkCore;
using Musicarr.Domain.Entities;
using Musicarr.Domain.Interfaces;

namespace Musicarr.Infrastructure.Persistence;

public class RequestRepository : IRequestRepository
{
    private readonly MusicarrDbContext _context;

    public RequestRepository(MusicarrDbContext context)
    {
        _context = context;
    }

    public async Task<IEnumerable<MusicRequest>> GetAllAsync()
    {
        return await _context.MusicRequests
            .OrderByDescending(r => r.RequestedAt)
            .ToListAsync();
    }

    public async Task<MusicRequest?> GetByIdAsync(int id)
    {
        return await _context.MusicRequests.FindAsync(id);
    }

    public async Task<IEnumerable<MusicRequest>> GetActiveAsync()
    {
        return await _context.MusicRequests
            .Where(r => r.Status == "Sent" || r.Status == "Downloading")
            .ToListAsync();
    }

    public async Task<MusicRequest> CreateAsync(MusicRequest request)
    {
        _context.MusicRequests.Add(request);
        await _context.SaveChangesAsync();
        return request;
    }

    public async Task<MusicRequest> UpdateAsync(MusicRequest request)
    {
        _context.MusicRequests.Update(request);
        await _context.SaveChangesAsync();
        return request;
    }

    public async Task<bool> DeleteAsync(int id)
    {
        var request = await _context.MusicRequests.FindAsync(id);
        if (request is null)
            return false;

        _context.MusicRequests.Remove(request);
        await _context.SaveChangesAsync();
        return true;
    }
}
