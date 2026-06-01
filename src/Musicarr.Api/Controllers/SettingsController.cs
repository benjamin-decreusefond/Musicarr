using Microsoft.AspNetCore.Mvc;
using Musicarr.Application.DTOs;
using Musicarr.Application.Interfaces;

namespace Musicarr.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class SettingsController : ControllerBase
{
    private readonly IConfigService _configService;
    private readonly IHttpClientFactory _httpClientFactory;

    public SettingsController(IConfigService configService, IHttpClientFactory httpClientFactory)
    {
        _configService = configService;
        _httpClientFactory = httpClientFactory;
    }

    [HttpGet]
    [ProducesResponseType(typeof(AppSettingsDto), StatusCodes.Status200OK)]
    public IActionResult GetSettings()
    {
        var settings = _configService.GetSettings();
        // Mask API keys in the response: return masked versions so the UI can display something
        return Ok(new AppSettingsDto
        {
            Jellyfin = new JellyfinSettingsDto
            {
                BaseUrl = settings.Jellyfin.BaseUrl,
                ApiKey = MaskApiKey(settings.Jellyfin.ApiKey),
            },
            Lidarr = new LidarrSettingsDto
            {
                BaseUrl = settings.Lidarr.BaseUrl,
                ApiKey = MaskApiKey(settings.Lidarr.ApiKey),
                RootFolderPath = settings.Lidarr.RootFolderPath,
                QualityProfileId = settings.Lidarr.QualityProfileId,
                MetadataProfileId = settings.Lidarr.MetadataProfileId,
            },
            MusicDiscovery = new MusicDiscoverySettingsDto
            {
                Provider = settings.MusicDiscovery.Provider,
            },
        });
    }

    [HttpPut]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public IActionResult UpdateSettings([FromBody] AppSettingsDto newSettings)
    {
        if (newSettings == null)
            return BadRequest(new { Message = "Settings payload is required" });

        // Load existing settings so we only overwrite non-masked values
        var existing = _configService.GetSettings();

        existing.Jellyfin.BaseUrl = newSettings.Jellyfin.BaseUrl ?? existing.Jellyfin.BaseUrl;
        if (!IsMasked(newSettings.Jellyfin.ApiKey))
            existing.Jellyfin.ApiKey = newSettings.Jellyfin.ApiKey ?? existing.Jellyfin.ApiKey;

        existing.Lidarr.BaseUrl = newSettings.Lidarr.BaseUrl ?? existing.Lidarr.BaseUrl;
        if (!IsMasked(newSettings.Lidarr.ApiKey))
            existing.Lidarr.ApiKey = newSettings.Lidarr.ApiKey ?? existing.Lidarr.ApiKey;
        existing.Lidarr.RootFolderPath = newSettings.Lidarr.RootFolderPath ?? existing.Lidarr.RootFolderPath;
        existing.Lidarr.QualityProfileId = newSettings.Lidarr.QualityProfileId;
        existing.Lidarr.MetadataProfileId = newSettings.Lidarr.MetadataProfileId;

        existing.MusicDiscovery.Provider = newSettings.MusicDiscovery.Provider ?? existing.MusicDiscovery.Provider;

        _configService.SaveSettings(existing);
        return Ok(new { Message = "Settings saved successfully" });
    }

    [HttpGet("status")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public IActionResult GetStatus()
    {
        // Jellyfin and Lidarr are optional integrations — the app is always considered configured
        return Ok(new { IsConfigured = true });
    }

    [HttpPost("test-jellyfin")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<IActionResult> TestJellyfin([FromBody] TestConnectionRequest? request = null)
    {
        var existing = _configService.GetSettings();
        var baseUrl = (request?.BaseUrl is { Length: > 0 } b ? b : existing.Jellyfin.BaseUrl).TrimEnd('/');
        var apiKey = request?.ApiKey is { Length: > 0 } k && !IsMasked(k) ? k : existing.Jellyfin.ApiKey;

        if (string.IsNullOrWhiteSpace(baseUrl) || string.IsNullOrWhiteSpace(apiKey))
            return Ok(new { Success = false, Message = "Jellyfin URL and API key are required." });

        try
        {
            var client = _httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(10);
            client.DefaultRequestHeaders.Add("X-Emby-Token", apiKey);
            var response = await client.GetAsync($"{baseUrl}/System/Info");
            if (response.IsSuccessStatusCode)
                return Ok(new { Success = true, Message = "Connected to Jellyfin successfully." });
            return Ok(new { Success = false, Message = $"Jellyfin returned HTTP {(int)response.StatusCode}." });
        }
        catch (Exception ex)
        {
            return Ok(new { Success = false, Message = $"Could not connect to Jellyfin: {ex.Message}" });
        }
    }

    [HttpPost("test-lidarr")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<IActionResult> TestLidarr([FromBody] TestConnectionRequest? request = null)
    {
        var existing = _configService.GetSettings();
        var baseUrl = (request?.BaseUrl is { Length: > 0 } b ? b : existing.Lidarr.BaseUrl).TrimEnd('/');
        var apiKey = request?.ApiKey is { Length: > 0 } k && !IsMasked(k) ? k : existing.Lidarr.ApiKey;

        if (string.IsNullOrWhiteSpace(baseUrl) || string.IsNullOrWhiteSpace(apiKey))
            return Ok(new { Success = false, Message = "Lidarr URL and API key are required." });

        try
        {
            var client = _httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(10);
            client.DefaultRequestHeaders.Add("X-Api-Key", apiKey);
            var response = await client.GetAsync($"{baseUrl}/api/v1/system/status");
            if (response.IsSuccessStatusCode)
                return Ok(new { Success = true, Message = "Connected to Lidarr successfully." });
            return Ok(new { Success = false, Message = $"Lidarr returned HTTP {(int)response.StatusCode}." });
        }
        catch (Exception ex)
        {
            return Ok(new { Success = false, Message = $"Could not connect to Lidarr: {ex.Message}" });
        }
    }

    private static string MaskApiKey(string? apiKey)
    {
        if (string.IsNullOrEmpty(apiKey))
            return string.Empty;
        if (apiKey.Length <= 4)
            return new string('*', apiKey.Length);
        return new string('*', apiKey.Length - 4) + apiKey[^4..];
    }

    private static bool IsMasked(string? value)
    {
        // Masked values always start with '*' (produced by MaskApiKey).
        // Real API keys from Jellyfin/Lidarr are alphanumeric and never start with '*'.
        return !string.IsNullOrEmpty(value) && value[0] == '*';
    }
}
