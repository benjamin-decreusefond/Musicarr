using Musicarr.Application.DTOs;
using Musicarr.Domain.Enums;

namespace Musicarr.Application.Interfaces;

public interface IAcquisitionService
{
    Task<bool> RequestArtistAsync(AcquisitionRequestDto request);
    Task<bool> RequestAlbumAsync(AcquisitionRequestDto request);
    Task<AcquisitionStatus> GetStatusAsync(string musicBrainzId, string type);
}
