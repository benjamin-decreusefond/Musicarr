using Microsoft.Extensions.Logging;
using Musicarr.Application.DTOs;
using Musicarr.Application.Interfaces;
using Musicarr.Domain.Entities;
using Musicarr.Domain.Enums;
using Musicarr.Domain.Interfaces;

namespace Musicarr.Application.Services;

public class DiscoverService : IDiscoverService
{
    // Deezer genre IDs for popular genres
    private static readonly (int Id, string Name)[] Genres =
    [
        (132, "Pop"),
        (116, "Hip-Hop / Rap"),
        (152, "Rock"),
        (106, "Electro"),
        (165, "R&B"),
        (98, "Classical"),
    ];

    private readonly IDeezerProvider _deezerProvider;
    private readonly IJellyfinService _jellyfinService;
    private readonly ILogger<DiscoverService> _logger;

    public DiscoverService(
        IDeezerProvider deezerProvider,
        IJellyfinService jellyfinService,
        ILogger<DiscoverService> logger)
    {
        _deezerProvider = deezerProvider;
        _jellyfinService = jellyfinService;
        _logger = logger;
    }

    public async Task<List<DiscoverSectionDto>> GetDiscoverSectionsAsync()
    {
        var sections = new List<DiscoverSectionDto>();

        var albumLookup = await GetAlbumLookupAsync();
        var artistLookup = await GetArtistLookupAsync();

        // Trending now (chart artists)
        try
        {
            var chartArtists = await _deezerProvider.GetChartArtistsAsync();
            var artistDtos = chartArtists
                .Select(a => ToArtistDto(a, artistLookup.TryGetValue(Normalize(a.Name), out var local) ? local : null))
                .Take(12).ToList();
            if (artistDtos.Count > 0)
                sections.Add(new DiscoverSectionDto("trending", "Trending Artists", "artists", Artists: artistDtos));
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Failed to load chart artists"); }

        // New releases
        try
        {
            var newReleases = await _deezerProvider.GetNewReleasesAsync();
            var albumDtos = newReleases
                .Select(a => ToAlbumDto(a, albumLookup.TryGetValue(BuildKey(a.Title, a.ArtistName), out var local) ? local : null))
                .Take(12).ToList();
            if (albumDtos.Count > 0)
                sections.Add(new DiscoverSectionDto("new-releases", "New Releases", "albums", Albums: albumDtos));
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Failed to load new releases"); }

        // Genre rows
        var genreTasks = Genres.Select(async genre =>
        {
            try
            {
                var albums = await _deezerProvider.GetGenreAlbumsAsync(genre.Id);
                var dtos = albums
                    .Select(a => ToAlbumDto(a, albumLookup.TryGetValue(BuildKey(a.Title, a.ArtistName), out var local) ? local : null))
                    .Take(12).ToList();
                return dtos.Count > 0
                    ? new DiscoverSectionDto($"genre-{genre.Id}", genre.Name, "albums", Albums: dtos)
                    : null;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to load genre {Genre}", genre.Name);
                return null;
            }
        });

        var genreSections = await Task.WhenAll(genreTasks);
        sections.AddRange(genreSections.Where(s => s is not null)!);

        return sections;
    }

    public async Task<List<ArtistDto>> GetRelatedArtistsAsync(string artistId)
    {
        var artistLookup = await GetArtistLookupAsync();
        var related = await _deezerProvider.GetRelatedArtistsAsync(artistId);
        return related
            .Select(a => ToArtistDto(a, artistLookup.TryGetValue(Normalize(a.Name), out var local) ? local : null))
            .Take(10)
            .ToList();
    }

    private async Task<Dictionary<string, Album>> GetAlbumLookupAsync()
    {
        try
        {
            var albums = await _jellyfinService.GetAlbumsAsync();
            return albums
                .GroupBy(a => BuildKey(a.Title, a.ArtistName))
                .ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        }
        catch { return new Dictionary<string, Album>(); }
    }

    private async Task<Dictionary<string, Artist>> GetArtistLookupAsync()
    {
        try
        {
            var artists = await _jellyfinService.GetArtistsAsync();
            return artists
                .ToDictionary(a => Normalize(a.Name), a => a, StringComparer.Ordinal);
        }
        catch { return new Dictionary<string, Artist>(); }
    }

    private static ArtistDto ToArtistDto(Artist a, Artist? local) =>
        new(a.DeezerId ?? a.Id.ToString(), a.Name, a.MusicBrainzId, local?.JellyfinId, a.ImageUrl, a.Overview, a.Genres,
            local != null ? MediaAvailability.Available : MediaAvailability.NotAvailable);

    private static AlbumDto ToAlbumDto(Album a, Album? local) =>
        new(a.DeezerId ?? a.Id.ToString(), a.Title, a.ArtistName, a.DeezerArtistId, a.MusicBrainzId, local?.JellyfinId, a.ImageUrl, a.Year, a.Overview, a.Genres,
            local != null ? MediaAvailability.Available : MediaAvailability.NotAvailable);

    private static string BuildKey(string? title, string? artist) => $"{Normalize(artist)}|{Normalize(title)}";

    private static string Normalize(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        return new string(value.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());
    }
}
