using System.Text.Json;
using Microsoft.Extensions.Logging;
using Musicarr.Application.DTOs;
using Musicarr.Application.Interfaces;

namespace Musicarr.Infrastructure.Configuration;

public class ConfigFileService : IConfigService
{
    private readonly string _configFilePath;
    private readonly ILogger<ConfigFileService> _logger;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    public ConfigFileService(string configFilePath, ILogger<ConfigFileService> logger)
    {
        _configFilePath = configFilePath;
        _logger = logger;
    }

    public AppSettingsDto GetSettings()
    {
        if (!File.Exists(_configFilePath))
            return new AppSettingsDto();

        try
        {
            var json = File.ReadAllText(_configFilePath);
            return JsonSerializer.Deserialize<AppSettingsDto>(json, JsonOptions) ?? new AppSettingsDto();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to read config file at {Path}", _configFilePath);
            return new AppSettingsDto();
        }
    }

    public void SaveSettings(AppSettingsDto settings)
    {
        try
        {
            var directory = Path.GetDirectoryName(_configFilePath);
            if (!string.IsNullOrEmpty(directory))
                Directory.CreateDirectory(directory);

            var json = JsonSerializer.Serialize(settings, JsonOptions);
            File.WriteAllText(_configFilePath, json);
            _logger.LogInformation("Configuration saved to {Path}", _configFilePath);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to save config file at {Path}", _configFilePath);
            throw;
        }
    }

    public bool IsConfigured()
    {
        var settings = GetSettings();
        return !string.IsNullOrWhiteSpace(settings.Jellyfin.BaseUrl)
            && !string.IsNullOrWhiteSpace(settings.Jellyfin.ApiKey);
    }
}
