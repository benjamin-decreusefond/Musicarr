using Musicarr.Application.DTOs;
using Musicarr.Application.Interfaces;
using Musicarr.Domain.Enums;
using Musicarr.Domain.Interfaces;
using Microsoft.Extensions.Logging;

namespace Musicarr.Application.Services;

public class AcquisitionService : IAcquisitionService
{
    private readonly ILidarrService _lidarrService;
    private readonly ILogger<AcquisitionService> _logger;

    public AcquisitionService(ILidarrService lidarrService, ILogger<AcquisitionService> logger)
    {
        _lidarrService = lidarrService;
        _logger = logger;
    }

    public async Task<bool> RequestArtistAsync(AcquisitionRequestDto request)
    {
        _logger.LogInformation("Requesting artist: {Name} ({MusicBrainzId})", request.Name, request.MusicBrainzId);
        return await _lidarrService.AddArtistAsync(request.MusicBrainzId, request.Name);
    }

    public async Task<bool> RequestAlbumAsync(AcquisitionRequestDto request)
    {
        _logger.LogInformation("Requesting album: {Name} ({MusicBrainzId})", request.Name, request.MusicBrainzId);
        return await _lidarrService.AddAlbumAsync(request.MusicBrainzId);
    }

    public async Task<AcquisitionStatus> GetStatusAsync(string musicBrainzId, string type)
    {
        return type.ToLowerInvariant() switch
        {
            "artist" => await _lidarrService.GetArtistStatusAsync(musicBrainzId),
            "album" => await _lidarrService.GetAlbumStatusAsync(musicBrainzId),
            _ => AcquisitionStatus.None
        };
    }
}
