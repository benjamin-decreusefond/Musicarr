using Musicarr.Domain.Entities;

namespace Musicarr.Domain.Interfaces;

public interface IPlaylistRepository
{
    Task<IEnumerable<Playlist>> GetByUserIdAsync(string userId);
    Task<Playlist?> GetByIdAsync(Guid id);
    Task<Playlist> CreateAsync(Playlist playlist);
    Task<Playlist> UpdateAsync(Playlist playlist);
    Task<bool> DeleteAsync(Guid id);
}
