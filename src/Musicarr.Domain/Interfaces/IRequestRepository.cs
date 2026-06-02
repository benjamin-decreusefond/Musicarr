using Musicarr.Domain.Entities;

namespace Musicarr.Domain.Interfaces;

public interface IRequestRepository
{
    Task<IEnumerable<MusicRequest>> GetAllAsync();
    Task<MusicRequest?> GetByIdAsync(int id);
    Task<IEnumerable<MusicRequest>> GetActiveAsync();
    Task<MusicRequest> CreateAsync(MusicRequest request);
    Task<MusicRequest> UpdateAsync(MusicRequest request);
    Task<bool> DeleteAsync(int id);
}
