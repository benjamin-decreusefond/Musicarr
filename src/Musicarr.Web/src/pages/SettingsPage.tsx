import { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Card,
  CardContent,
  TextField,
  Button,
  Alert,
  CircularProgress,
  Divider,
  MenuItem,
} from '@mui/material';
import { Save as SaveIcon } from '@mui/icons-material';
import { api } from '../services/api';

interface AppSettings {
  jellyfin: {
    baseUrl: string;
    apiKey: string;
  };
  lidarr: {
    baseUrl: string;
    apiKey: string;
    rootFolderPath: string;
    qualityProfileId: number;
    metadataProfileId: number;
  };
  musicDiscovery: {
    provider: string;
  };
}

const defaultSettings: AppSettings = {
  jellyfin: { baseUrl: '', apiKey: '' },
  lidarr: { baseUrl: '', apiKey: '', rootFolderPath: '/music', qualityProfileId: 1, metadataProfileId: 1 },
  musicDiscovery: { provider: 'MusicBrainz' },
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const response = await api.get<AppSettings>('/api/settings');
        setSettings(response.data);
      } catch {
        setError('Failed to load settings.');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSuccess(false);
    try {
      await api.put('/api/settings', settings);
      setSuccess(true);
    } catch {
      setError('Failed to save settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" mt={8}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box maxWidth={720}>
      <Typography variant="h4" gutterBottom fontWeight={700}>
        Settings
      </Typography>
      <Typography variant="body2" color="text.secondary" mb={3}>
        Configure your external service connections. Changes take effect immediately.
      </Typography>

      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess(false)}>
          Settings saved successfully.
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {/* Jellyfin */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom fontWeight={600}>
            Jellyfin
          </Typography>
          <Typography variant="body2" color="text.secondary" mb={2}>
            Connect to your Jellyfin media server for music streaming.
          </Typography>
          <Box display="flex" flexDirection="column" gap={2}>
            <TextField
              label="Server URL"
              placeholder="http://localhost:8096"
              value={settings.jellyfin.baseUrl}
              onChange={(e) =>
                setSettings((s) => ({ ...s, jellyfin: { ...s.jellyfin, baseUrl: e.target.value } }))
              }
              fullWidth
            />
            <TextField
              label="API Key"
              type="password"
              placeholder="Enter your Jellyfin API key"
              value={settings.jellyfin.apiKey}
              onChange={(e) =>
                setSettings((s) => ({ ...s, jellyfin: { ...s.jellyfin, apiKey: e.target.value } }))
              }
              fullWidth
              helperText="Find your API key in Jellyfin → Dashboard → Advanced → API Keys"
            />
          </Box>
        </CardContent>
      </Card>

      <Divider sx={{ mb: 3 }} />

      {/* Lidarr */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom fontWeight={600}>
            Lidarr
          </Typography>
          <Typography variant="body2" color="text.secondary" mb={2}>
            Connect to Lidarr for automated music acquisition (optional).
          </Typography>
          <Box display="flex" flexDirection="column" gap={2}>
            <TextField
              label="Server URL"
              placeholder="http://localhost:8686"
              value={settings.lidarr.baseUrl}
              onChange={(e) =>
                setSettings((s) => ({ ...s, lidarr: { ...s.lidarr, baseUrl: e.target.value } }))
              }
              fullWidth
            />
            <TextField
              label="API Key"
              type="password"
              placeholder="Enter your Lidarr API key"
              value={settings.lidarr.apiKey}
              onChange={(e) =>
                setSettings((s) => ({ ...s, lidarr: { ...s.lidarr, apiKey: e.target.value } }))
              }
              fullWidth
              helperText="Find your API key in Lidarr → Settings → General → Security"
            />
            <TextField
              label="Root Folder Path"
              placeholder="/music"
              value={settings.lidarr.rootFolderPath}
              onChange={(e) =>
                setSettings((s) => ({ ...s, lidarr: { ...s.lidarr, rootFolderPath: e.target.value } }))
              }
              fullWidth
            />
            <Box display="flex" gap={2}>
              <TextField
                label="Quality Profile ID"
                type="number"
                value={settings.lidarr.qualityProfileId}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    lidarr: { ...s.lidarr, qualityProfileId: parseInt(e.target.value, 10) || 1 },
                  }))
                }
                fullWidth
              />
              <TextField
                label="Metadata Profile ID"
                type="number"
                value={settings.lidarr.metadataProfileId}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    lidarr: { ...s.lidarr, metadataProfileId: parseInt(e.target.value, 10) || 1 },
                  }))
                }
                fullWidth
              />
            </Box>
          </Box>
        </CardContent>
      </Card>

      <Divider sx={{ mb: 3 }} />

      {/* Music Discovery */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom fontWeight={600}>
            Music Discovery
          </Typography>
          <Typography variant="body2" color="text.secondary" mb={2}>
            Configure the metadata provider used for music search and discovery.
          </Typography>
          <TextField
            select
            label="Provider"
            value={settings.musicDiscovery.provider}
            onChange={(e) =>
              setSettings((s) => ({ ...s, musicDiscovery: { provider: e.target.value } }))
            }
            fullWidth
          >
            <MenuItem value="MusicBrainz">MusicBrainz</MenuItem>
          </TextField>
        </CardContent>
      </Card>

      <Button
        variant="contained"
        size="large"
        startIcon={saving ? <CircularProgress size={18} color="inherit" /> : <SaveIcon />}
        onClick={handleSave}
        disabled={saving}
      >
        Save Settings
      </Button>
    </Box>
  );
}
