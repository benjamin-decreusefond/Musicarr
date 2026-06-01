namespace Musicarr.Api.Extensions;

public static class AuthExtensions
{
    public static string? GetToken(this HttpContext context)
    {
        var authHeader = context.Request.Headers["Authorization"].FirstOrDefault();
        if (string.IsNullOrEmpty(authHeader)) return null;
        
        return authHeader.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) 
            ? authHeader["Bearer ".Length..].Trim() 
            : authHeader;
    }

    public static string? GetUserId(this HttpContext context)
    {
        return context.Request.Headers["X-User-Id"].FirstOrDefault();
    }
}
