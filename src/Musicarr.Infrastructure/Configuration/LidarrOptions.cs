namespace Musicarr.Infrastructure.Configuration;

public class LidarrOptions
{
    public const string Section = "Lidarr";
    public string BaseUrl { get; set; } = string.Empty;
    public string ApiKey { get; set; } = string.Empty;
    public string RootFolderPath { get; set; } = "/music";
    public int QualityProfileId { get; set; } = 1;
    public int MetadataProfileId { get; set; } = 1;
}
