using Musicarr.Application.DTOs;

namespace Musicarr.Application.Interfaces;

public interface IDiscoverService
{
    Task<List<DiscoverSectionDto>> GetDiscoverSectionsAsync();
    Task<List<ArtistDto>> GetRelatedArtistsAsync(string artistId);
}
