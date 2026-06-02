using Musicarr.Application.DTOs;

namespace Musicarr.Application.Interfaces;

public interface ISearchService
{
    Task<SearchResultDto> SearchAsync(string query);
    Task<SearchResultDto> GetSuggestionsAsync();
}
