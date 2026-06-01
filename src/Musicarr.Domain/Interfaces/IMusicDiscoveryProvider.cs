using Musicarr.Domain.Entities;

namespace Musicarr.Domain.Interfaces;

public interface IMusicDiscoveryProvider
{
    string ProviderName { get; }
    Task<IEnumerable<Artist>> SearchArtistsAsync(string query);
    Task<IEnumerable<Album>> SearchAlbumsAsync(string query);
    Task<IEnumerable<Track>> SearchTracksAsync(string query);
    Task<IEnumerable<Artist>> GetSimilarArtistsAsync(string artistId);
    Task<IEnumerable<Album>> GetRecommendationsAsync(string? artistId = null, string? genre = null);
}
