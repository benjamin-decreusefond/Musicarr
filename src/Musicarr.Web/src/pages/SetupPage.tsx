import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  TextField,
  Button,
  Typography,
  Alert,
  CircularProgress,
  Stepper,
  Step,
  StepLabel,
  MenuItem,
} from '@mui/material';
import { api } from '../services/api';

const steps = ['Welcome', 'Jellyfin', 'Lidarr', 'Finish'];

export default function SetupPage() {
  const navigate = useNavigate();
  const [activeStep, setActiveStep] = useState(0);
  const [checking, setChecking] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [jellyfinUrl, setJellyfinUrl] = useState('http://localhost:8096');
  const [jellyfinApiKey, setJellyfinApiKey] = useState('');
  const [lidarrUrl, setLidarrUrl] = useState('http://localhost:8686');
  const [lidarrApiKey, setLidarrApiKey] = useState('');
  const [lidarrRootFolder, setLidarrRootFolder] = useState('/music');
  const [provider, setProvider] = useState('MusicBrainz');

  // If already configured, redirect to login
  useEffect(() => {
    const check = async () => {
      try {
        const response = await api.get<{ isConfigured: boolean }>('/api/settings/status');
        if (response.data.isConfigured) {
          navigate('/login');
        }
      } catch {
        // Cannot reach API – stay on setup page
      } finally {
        setChecking(false);
      }
    };
    check();
  }, [navigate]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await api.put('/api/settings', {
        jellyfin: { baseUrl: jellyfinUrl, apiKey: jellyfinApiKey },
        lidarr: {
          baseUrl: lidarrUrl,
          apiKey: lidarrApiKey,
          rootFolderPath: lidarrRootFolder,
          qualityProfileId: 1,
          metadataProfileId: 1,
        },
        musicDiscovery: { provider },
      });
      setActiveStep(3);
    } catch {
      setError('Failed to save settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (checking) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="100vh">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        p: 2,
      }}
    >
      <Typography variant="h4" fontWeight={700} color="primary" mb={1}>
        Musicarr
      </Typography>
      <Typography variant="body1" color="text.secondary" mb={4}>
        Welcome! Let's get you set up.
      </Typography>

      <Card sx={{ width: '100%', maxWidth: 560 }}>
        <CardContent sx={{ p: 4 }}>
          <Stepper activeStep={activeStep} sx={{ mb: 4 }}>
            {steps.map((label) => (
              <Step key={label}>
                <StepLabel>{label}</StepLabel>
              </Step>
            ))}
          </Stepper>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
              {error}
            </Alert>
          )}

          {/* Step 0: Welcome */}
          {activeStep === 0 && (
            <Box>
              <Typography variant="h6" gutterBottom fontWeight={600}>
                Welcome to Musicarr
              </Typography>
              <Typography variant="body2" color="text.secondary" mb={3}>
                Musicarr connects your Jellyfin music library with Lidarr for automated music
                acquisition. This wizard will help you configure your connections.
              </Typography>
              <Typography variant="body2" color="text.secondary" mb={3}>
                You will need:
              </Typography>
              <Box component="ul" sx={{ pl: 2, color: 'text.secondary' }}>
                <li>
                  <Typography variant="body2">A running Jellyfin server with your music library</Typography>
                </li>
                <li>
                  <Typography variant="body2">A Jellyfin API key (Dashboard → Advanced → API Keys)</Typography>
                </li>
                <li>
                  <Typography variant="body2">Lidarr (optional, for music acquisition)</Typography>
                </li>
              </Box>
              <Button variant="contained" size="large" sx={{ mt: 3 }} onClick={() => setActiveStep(1)}>
                Get Started
              </Button>
            </Box>
          )}

          {/* Step 1: Jellyfin */}
          {activeStep === 1 && (
            <Box>
              <Typography variant="h6" gutterBottom fontWeight={600}>
                Jellyfin Connection
              </Typography>
              <Typography variant="body2" color="text.secondary" mb={3}>
                Enter your Jellyfin server details. An API key is required for Musicarr to access
                your music library.
              </Typography>
              <Box display="flex" flexDirection="column" gap={2}>
                <TextField
                  label="Server URL"
                  placeholder="http://localhost:8096"
                  value={jellyfinUrl}
                  onChange={(e) => setJellyfinUrl(e.target.value)}
                  fullWidth
                  required
                />
                <TextField
                  label="API Key"
                  type="password"
                  placeholder="Paste your Jellyfin API key"
                  value={jellyfinApiKey}
                  onChange={(e) => setJellyfinApiKey(e.target.value)}
                  fullWidth
                  required
                  helperText="Jellyfin → Dashboard → Advanced → API Keys → + Add"
                />
              </Box>
              <Box display="flex" gap={2} mt={3}>
                <Button variant="outlined" onClick={() => setActiveStep(0)}>
                  Back
                </Button>
                <Button
                  variant="contained"
                  onClick={() => setActiveStep(2)}
                  disabled={!jellyfinUrl || !jellyfinApiKey}
                >
                  Next
                </Button>
              </Box>
            </Box>
          )}

          {/* Step 2: Lidarr */}
          {activeStep === 2 && (
            <Box>
              <Typography variant="h6" gutterBottom fontWeight={600}>
                Lidarr Connection (Optional)
              </Typography>
              <Typography variant="body2" color="text.secondary" mb={3}>
                Connect Lidarr to enable requesting music downloads. Leave blank to skip.
              </Typography>
              <Box display="flex" flexDirection="column" gap={2}>
                <TextField
                  label="Server URL"
                  placeholder="http://localhost:8686"
                  value={lidarrUrl}
                  onChange={(e) => setLidarrUrl(e.target.value)}
                  fullWidth
                />
                <TextField
                  label="API Key"
                  type="password"
                  placeholder="Paste your Lidarr API key"
                  value={lidarrApiKey}
                  onChange={(e) => setLidarrApiKey(e.target.value)}
                  fullWidth
                  helperText="Lidarr → Settings → General → Security"
                />
                <TextField
                  label="Root Folder Path"
                  placeholder="/music"
                  value={lidarrRootFolder}
                  onChange={(e) => setLidarrRootFolder(e.target.value)}
                  fullWidth
                />
                <TextField
                  select
                  label="Music Discovery Provider"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  fullWidth
                >
                  <MenuItem value="MusicBrainz">MusicBrainz</MenuItem>
                </TextField>
              </Box>
              <Box display="flex" gap={2} mt={3}>
                <Button variant="outlined" onClick={() => setActiveStep(1)}>
                  Back
                </Button>
                <Button variant="contained" onClick={handleSave} disabled={saving}>
                  {saving ? <CircularProgress size={20} color="inherit" /> : 'Save & Finish'}
                </Button>
              </Box>
            </Box>
          )}

          {/* Step 3: Done */}
          {activeStep === 3 && (
            <Box textAlign="center">
              <Typography variant="h6" gutterBottom fontWeight={600}>
                Setup Complete! 🎉
              </Typography>
              <Typography variant="body2" color="text.secondary" mb={3}>
                Your configuration has been saved. You can now log in with your Jellyfin credentials
                and update settings anytime from the Settings page.
              </Typography>
              <Button variant="contained" size="large" onClick={() => navigate('/login')}>
                Go to Login
              </Button>
            </Box>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
