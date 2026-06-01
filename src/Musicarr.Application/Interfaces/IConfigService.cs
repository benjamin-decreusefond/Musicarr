using Musicarr.Application.DTOs;

namespace Musicarr.Application.Interfaces;

public interface IConfigService
{
    AppSettingsDto GetSettings();
    void SaveSettings(AppSettingsDto settings);
    bool IsConfigured();
}
