using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Musicarr.Application.Interfaces;
using Musicarr.Domain.Entities;
using Musicarr.Infrastructure.Persistence;

namespace Musicarr.Infrastructure.Auth;

public class AdminUserService : IAdminUserService
{
    private readonly MusicarrDbContext _dbContext;
    private readonly ILogger<AdminUserService> _logger;

    private const int Iterations = 100_000;
    private const int SaltSize = 16;
    private const int HashSize = 32;

    public AdminUserService(MusicarrDbContext dbContext, ILogger<AdminUserService> logger)
    {
        _dbContext = dbContext;
        _logger = logger;
    }

    public async Task<bool> HasAdminUserAsync()
    {
        return await _dbContext.AdminUsers.AnyAsync();
    }

    public async Task<bool> CreateAdminUserAsync(string username, string password)
    {
        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password))
            return false;

        if (await _dbContext.AdminUsers.AnyAsync())
        {
            _logger.LogWarning("Attempt to create admin user when one already exists");
            return false;
        }

        var passwordHash = HashPassword(password);

        var adminUser = new AdminUser
        {
            Username = username.Trim(),
            PasswordHash = passwordHash,
            CreatedAt = DateTime.UtcNow,
        };

        _dbContext.AdminUsers.Add(adminUser);
        await _dbContext.SaveChangesAsync();
        _logger.LogInformation("Admin user '{Username}' created", SanitizeLogInput(username.Trim()));
        return true;
    }

    public async Task<bool> ValidateCredentialsAsync(string username, string password)
    {
        var user = await _dbContext.AdminUsers
            .FirstOrDefaultAsync(u => u.Username == username.Trim());

        if (user == null)
            return false;

        return VerifyPassword(password, user.PasswordHash);
    }

    private static string HashPassword(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltSize);
        var hash = Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(password),
            salt,
            Iterations,
            HashAlgorithmName.SHA256,
            HashSize);

        return $"{Convert.ToBase64String(salt)}:{Convert.ToBase64String(hash)}";
    }

    private static bool VerifyPassword(string password, string storedHash)
    {
        var parts = storedHash.Split(':');
        if (parts.Length != 2)
            return false;

        byte[] salt;
        byte[] expectedHash;

        try
        {
            salt = Convert.FromBase64String(parts[0]);
            expectedHash = Convert.FromBase64String(parts[1]);
        }
        catch (FormatException)
        {
            return false;
        }

        var actualHash = Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(password),
            salt,
            Iterations,
            HashAlgorithmName.SHA256,
            HashSize);

        return CryptographicOperations.FixedTimeEquals(actualHash, expectedHash);
    }

    private static string SanitizeLogInput(string input) =>
        input.Replace("\n", "").Replace("\r", "").Replace("\t", "");
}
