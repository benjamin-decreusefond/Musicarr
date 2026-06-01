using Musicarr.Application.Interfaces;
using Musicarr.Domain.Interfaces;
using Microsoft.Extensions.Logging;

namespace Musicarr.Application.Services;

public class PlaybackService : IPlaybackService
{
    private readonly IJellyfinService _jellyfinService;
    private readonly ILogger<PlaybackService> _logger;

    public PlaybackService(IJellyfinService jellyfinService, ILogger<PlaybackService> logger)
    {
        _jellyfinService = jellyfinService;
        _logger = logger;
    }

    public async Task<string?> GetStreamUrlAsync(string token, string jellyfinItemId)
    {
        _logger.LogDebug("Getting stream URL for item {ItemId}", jellyfinItemId);
        return await _jellyfinService.GetStreamUrlAsync(token, jellyfinItemId);
    }
}
