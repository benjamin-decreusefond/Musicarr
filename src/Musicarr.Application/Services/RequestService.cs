using Microsoft.Extensions.Logging;
using Musicarr.Application.DTOs;
using Musicarr.Application.Interfaces;
using Musicarr.Domain.Entities;
using Musicarr.Domain.Enums;
using Musicarr.Domain.Interfaces;

namespace Musicarr.Application.Services;

public class RequestService : IRequestService
{
    private readonly IRequestRepository _repository;
    private readonly IAcquisitionService _acquisitionService;
    private readonly ILidarrService _lidarrService;
    private readonly ILogger<RequestService> _logger;

    public RequestService(
        IRequestRepository repository,
        IAcquisitionService acquisitionService,
        ILidarrService lidarrService,
        ILogger<RequestService> logger)
    {
        _repository = repository;
        _acquisitionService = acquisitionService;
        _lidarrService = lidarrService;
        _logger = logger;
    }

    public async Task<List<RequestDto>> GetRequestsAsync()
    {
        var requests = await _repository.GetAllAsync();
        return requests.Select(ToDto).ToList();
    }

    public async Task<RequestDto?> CreateRequestAsync(CreateRequestDto request)
    {
        var title = request.Type == "album"
            ? (request.AlbumTitle ?? request.Name)
            : request.Name;

        var musicRequest = new MusicRequest
        {
            Type = request.Type,
            Title = title,
            ArtistName = request.ArtistName,
            DeezerAlbumId = request.DeezerAlbumId,
            MusicBrainzId = request.MusicBrainzId,
            Status = "Pending",
            RequestedAt = DateTime.UtcNow,
        };

        musicRequest = await _repository.CreateAsync(musicRequest);

        var acquisitionRequest = new AcquisitionRequestDto(
            request.MusicBrainzId,
            request.Name,
            request.Type,
            request.ArtistName,
            request.AlbumTitle);

        bool submitted = request.Type switch
        {
            "album" => await _acquisitionService.RequestAlbumAsync(acquisitionRequest),
            _ => false
        };

        musicRequest.Status = submitted ? "Sent" : "Failed";
        musicRequest = await _repository.UpdateAsync(musicRequest);

        _logger.LogInformation("Created music request {Id} for {Type} '{Title}', status: {Status}",
            musicRequest.Id, musicRequest.Type, Sanitize(musicRequest.Title), musicRequest.Status);

        return ToDto(musicRequest);
    }

    public async Task<bool> CancelRequestAsync(int id)
    {
        var request = await _repository.GetByIdAsync(id);
        if (request is null)
            return false;

        if (request.Status != "Pending" && request.Status != "Sent")
            return false;

        return await _repository.DeleteAsync(id);
    }

    public async Task SyncStatusesAsync()
    {
        var activeRequests = await _repository.GetActiveAsync();

        foreach (var req in activeRequests)
        {
            if (string.IsNullOrWhiteSpace(req.MusicBrainzId))
                continue;

            try
            {
                var status = await _lidarrService.GetAlbumStatusAsync(req.MusicBrainzId);
                var newStatus = status switch
                {
                    AcquisitionStatus.Completed => "Available",
                    AcquisitionStatus.Downloading => "Downloading",
                    AcquisitionStatus.Importing => "Downloading",
                    AcquisitionStatus.Queued => "Downloading",
                    _ => req.Status
                };

                if (newStatus != req.Status)
                {
                    req.Status = newStatus;
                    if (newStatus == "Available")
                        req.CompletedAt = DateTime.UtcNow;
                    await _repository.UpdateAsync(req);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to sync status for request {Id}", req.Id);
            }
        }
    }

    private static RequestDto ToDto(MusicRequest r) =>
        new(r.Id, r.Type, r.Title, r.ArtistName, r.DeezerAlbumId, r.MusicBrainzId, r.Status, r.RequestedAt, r.CompletedAt);

    private static string Sanitize(string input) =>
        input.Replace("\n", string.Empty).Replace("\r", string.Empty).Replace("\t", string.Empty);
}
