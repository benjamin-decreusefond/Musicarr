import { useState, useEffect, useCallback } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  Snackbar,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Cancel as CancelIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { api } from '../services/api';

interface MusicRequest {
  id: number;
  type: string;
  title: string;
  artistName?: string;
  status: string;
  requestedAt: string;
  completedAt?: string;
}

type StatusColor = 'default' | 'info' | 'warning' | 'success' | 'error';

function statusChip(status: string) {
  const map: Record<string, { label: string; color: StatusColor }> = {
    Pending: { label: 'Pending', color: 'default' },
    Sent: { label: 'Sent to Lidarr', color: 'info' },
    Downloading: { label: 'Downloading', color: 'warning' },
    Available: { label: 'Available', color: 'success' },
    Failed: { label: 'Failed', color: 'error' },
  };
  const cfg = map[status] ?? { label: status, color: 'default' as StatusColor };
  return <Chip label={cfg.label} color={cfg.color} size="small" />;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString();
}

export default function RequestsPage() {
  const [requests, setRequests] = useState<MusicRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [snackbar, setSnackbar] = useState<{ message: string; severity: 'success' | 'error' } | null>(null);

  const fetchRequests = useCallback(async () => {
    try {
      const res = await api.get<MusicRequest[]>('/api/requests');
      setRequests(res.data);
    } catch (error) {
      console.error('Failed to fetch requests:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await api.post('/api/requests/sync');
      await fetchRequests();
      setSnackbar({ message: 'Statuses synced', severity: 'success' });
    } catch (error) {
      console.error('Sync failed:', error);
      setSnackbar({ message: 'Failed to sync statuses', severity: 'error' });
    } finally {
      setSyncing(false);
    }
  };

  const handleCancel = async (id: number) => {
    try {
      await api.delete(`/api/requests/${id}`);
      setRequests((prev) => prev.filter((r) => r.id !== id));
      setSnackbar({ message: 'Request cancelled', severity: 'success' });
    } catch (error) {
      console.error('Cancel failed:', error);
      setSnackbar({ message: 'Failed to cancel request', severity: 'error' });
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Typography variant="h4" fontWeight={700}>Requests</Typography>
        <Button
          startIcon={syncing ? <CircularProgress size={16} /> : <RefreshIcon />}
          onClick={handleSync}
          disabled={syncing}
          variant="outlined"
          size="small"
        >
          Sync Status
        </Button>
      </Box>

      {loading ? (
        <CircularProgress sx={{ display: 'block', mx: 'auto', mt: 4 }} />
      ) : requests.length === 0 ? (
        <Typography color="text.secondary" sx={{ mt: 4, textAlign: 'center' }}>
          No requests yet. Browse albums and click the download button to request music.
        </Typography>
      ) : (
        <TableContainer component={Paper} sx={{ bgcolor: 'background.paper' }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Title</TableCell>
                <TableCell>Artist</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Requested</TableCell>
                <TableCell>Completed</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {requests.map((req) => (
                <TableRow key={req.id} hover>
                  <TableCell>
                    <Typography variant="body2" fontWeight={500}>{req.title}</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">{req.artistName ?? '—'}</Typography>
                  </TableCell>
                  <TableCell>
                    <Chip label={req.type} size="small" variant="outlined" />
                  </TableCell>
                  <TableCell>{statusChip(req.status)}</TableCell>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary">{formatDate(req.requestedAt)}</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary">
                      {req.completedAt ? formatDate(req.completedAt) : '—'}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    {(req.status === 'Pending' || req.status === 'Sent') && (
                      <Tooltip title="Cancel request">
                        <IconButton size="small" onClick={() => handleCancel(req.id)} color="error">
                          <CancelIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Snackbar open={!!snackbar} autoHideDuration={4000} onClose={() => setSnackbar(null)}>
        {snackbar ? <Alert severity={snackbar.severity} onClose={() => setSnackbar(null)}>{snackbar.message}</Alert> : <span />}
      </Snackbar>
    </Box>
  );
}
