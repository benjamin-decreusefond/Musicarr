namespace Musicarr.Application.Interfaces;

public interface IAdminUserService
{
    Task<bool> HasAdminUserAsync();
    Task<bool> CreateAdminUserAsync(string username, string password);
    Task<bool> ValidateCredentialsAsync(string username, string password);
}
