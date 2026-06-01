namespace Musicarr.Infrastructure.Configuration;

public class JellyfinOptions
{
    public const string Section = "Jellyfin";
    public string BaseUrl { get; set; } = string.Empty;
    public string ApiKey { get; set; } = string.Empty;
}
