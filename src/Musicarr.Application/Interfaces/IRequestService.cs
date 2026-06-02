using Musicarr.Application.DTOs;

namespace Musicarr.Application.Interfaces;

public interface IRequestService
{
    Task<List<RequestDto>> GetRequestsAsync();
    Task<RequestDto?> CreateRequestAsync(CreateRequestDto request);
    Task<bool> CancelRequestAsync(int id);
    Task SyncStatusesAsync();
}
