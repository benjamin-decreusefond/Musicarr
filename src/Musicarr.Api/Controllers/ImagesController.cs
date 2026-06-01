using Microsoft.AspNetCore.Mvc;
using Musicarr.Application.Interfaces;

namespace Musicarr.Api.Controllers;

[ApiController]
[Route("api/images")]
public class ImagesController : ControllerBase
{
    private readonly IConfigService _configService;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<ImagesController> _logger;

    public ImagesController(IConfigService configService, IHttpClientFactory httpClientFactory, ILogger<ImagesController> logger)
    {
        _configService = configService;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    [HttpGet("jellyfin/{itemId}")]
    public async Task<IActionResult> GetJellyfinImage(string itemId)
    {
        var settings = _configService.GetSettings();
        if (string.IsNullOrWhiteSpace(settings.Jellyfin.BaseUrl) || string.IsNullOrWhiteSpace(settings.Jellyfin.ApiKey))
            return NotFound();

        var url = $"{settings.Jellyfin.BaseUrl.TrimEnd('/')}/Items/{itemId}/Images/Primary";
        var client = _httpClientFactory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Emby-Token", settings.Jellyfin.ApiKey);

        try
        {
            var response = await client.GetAsync(url);
            if (!response.IsSuccessStatusCode)
                return NotFound();

            var contentType = response.Content.Headers.ContentType?.ToString() ?? "image/jpeg";
            var data = await response.Content.ReadAsByteArrayAsync();
            return File(data, contentType);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to proxy Jellyfin image for item {ItemId}", itemId);
            return NotFound();
        }
    }
}
