namespace Musicarr.Domain.Enums;

public enum AcquisitionStatus
{
    None,
    Requested,
    Queued,
    Downloading,
    Importing,
    Completed,
    Failed
}
