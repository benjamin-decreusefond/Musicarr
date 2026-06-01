namespace Musicarr.Application.Interfaces;

public interface IDeezerImageService
{
    Task<string?> GetArtistImageUrlAsync(string artistName);
    Task<string?> GetAlbumImageUrlAsync(string albumTitle, string? artistName);
}
