namespace Musicarr.Application.DTOs;

public class AppSettingsDto
{
    public JellyfinSettingsDto Jellyfin { get; set; } = new();
    public LidarrSettingsDto Lidarr { get; set; } = new();
    public MusicDiscoverySettingsDto MusicDiscovery { get; set; } = new();
}

public class JellyfinSettingsDto
{
    public string BaseUrl { get; set; } = string.Empty;
    public string ApiKey { get; set; } = string.Empty;
}

public class LidarrSettingsDto
{
    public string BaseUrl { get; set; } = string.Empty;
    public string ApiKey { get; set; } = string.Empty;
    public string RootFolderPath { get; set; } = "/music";
    public int QualityProfileId { get; set; } = 1;
    public int MetadataProfileId { get; set; } = 1;
}

public class MusicDiscoverySettingsDto
{
    public string Provider { get; set; } = "Deezer";
}
