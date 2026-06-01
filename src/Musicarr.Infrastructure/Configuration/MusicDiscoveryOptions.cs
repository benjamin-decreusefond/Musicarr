namespace Musicarr.Infrastructure.Configuration;

public class MusicDiscoveryOptions
{
    public const string Section = "MusicDiscovery";
    public string Provider { get; set; } = "Deezer";
    public string? ApiKey { get; set; }
    public string? BaseUrl { get; set; }
}
