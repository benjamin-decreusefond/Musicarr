using System.Security.Cryptography;
using System.Text;
using Musicarr.Application.Common;
using Musicarr.Infrastructure;
using Musicarr.Api.Middleware;
using Musicarr.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Microsoft.OpenApi.Models;

var builder = WebApplication.CreateBuilder(args);

// Determine data directory and config file path
var dataDir = Environment.GetEnvironmentVariable("MUSICARR_DATA_DIR")
    ?? Path.Combine(AppContext.BaseDirectory, "data");
Directory.CreateDirectory(dataDir);
var configFilePath = Path.Combine(dataDir, "config.json");

// Load config.json as an additional configuration source (overrides appsettings)
builder.Configuration.AddJsonFile(configFilePath, optional: true, reloadOnChange: true);

// Ensure a persistent JWT secret exists in the data directory
var jwtSecretFile = Path.Combine(dataDir, "jwt-secret.key");
string jwtSecret;
if (File.Exists(jwtSecretFile))
{
    jwtSecret = File.ReadAllText(jwtSecretFile).Trim();
}
else
{
    jwtSecret = Convert.ToBase64String(RandomNumberGenerator.GetBytes(64));
    File.WriteAllText(jwtSecretFile, jwtSecret);
}
builder.Configuration["Jwt:Secret"] = jwtSecret;

// Add services
builder.Services.AddApplication();
builder.Services.AddInfrastructure(builder.Configuration, configFilePath);

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtSecret)),
            ValidateIssuer = false,
            ValidateAudience = false,
            ClockSkew = TimeSpan.Zero,
        };
    });

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new OpenApiInfo
    {
        Title = "Musicarr API",
        Version = "v1",
        Description = "Self-hosted music platform API combining Jellyfin, Lidarr, and music discovery"
    });
    c.AddSecurityDefinition("Bearer", new OpenApiSecurityScheme
    {
        Description = "Musicarr JWT authentication token",
        Name = "Authorization",
        In = ParameterLocation.Header,
        Type = SecuritySchemeType.ApiKey,
        Scheme = "Bearer"
    });
    c.AddSecurityRequirement(new OpenApiSecurityRequirement
    {
        {
            new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference { Type = ReferenceType.SecurityScheme, Id = "Bearer" }
            },
            Array.Empty<string>()
        }
    });
});

builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowFrontend", policy =>
    {
        policy.WithOrigins(builder.Configuration.GetValue<string>("Cors:Origins") ?? "http://localhost:5173")
            .AllowAnyMethod()
            .AllowAnyHeader()
            .AllowCredentials();
    });
});

builder.Services.AddHealthChecks();

var app = builder.Build();

// Initialise the database (create tables if they don't exist)
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<MusicarrDbContext>();
    db.Database.EnsureCreated();
}

// Configure pipeline
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI(c => c.SwaggerEndpoint("/swagger/v1/swagger.json", "Musicarr API v1"));
}

app.UseMiddleware<ExceptionHandlingMiddleware>();
app.UseCors("AllowFrontend");
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
app.MapHealthChecks("/health");
app.MapGet("/health/ready", () => Results.Ok(new { Status = "Ready" }));
app.MapGet("/health/live", () => Results.Ok(new { Status = "Alive" }));
app.UseStaticFiles();
app.MapFallbackToFile("index.html");

app.Run();
