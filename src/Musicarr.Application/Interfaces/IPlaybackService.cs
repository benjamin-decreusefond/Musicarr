namespace Musicarr.Application.Interfaces;

public interface IPlaybackService
{
    Task<string?> GetStreamUrlAsync(string jellyfinItemId);
}
