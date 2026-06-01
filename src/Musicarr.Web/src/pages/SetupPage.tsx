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
} from '@mui/material';
import { api } from '../services/api';

export default function SetupPage() {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // If admin already exists, redirect to login
  useEffect(() => {
    const check = async () => {
      try {
        const response = await api.get<{ hasAdminUser: boolean }>('/api/setup/status');
        if (response.data.hasAdminUser) {
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setSaving(true);
    try {
      await api.post('/api/setup/create-admin', { username, password });
      navigate('/login');
    } catch (err: any) {
      const msg = err?.response?.data?.message || 'Failed to create admin account. Please try again.';
      setError(msg);
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
        Create your admin account to get started
      </Typography>

      <Card sx={{ width: '100%', maxWidth: 440 }}>
        <CardContent sx={{ p: 4 }}>
          <Typography variant="h5" gutterBottom fontWeight={600}>
            Create Admin Account
          </Typography>
          <Typography variant="body2" color="text.secondary" mb={3}>
            Set up your Musicarr admin credentials. You can configure Jellyfin and Lidarr
            connections later from the Settings page.
          </Typography>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
              {error}
            </Alert>
          )}

          <form onSubmit={handleSubmit}>
            <TextField
              fullWidth
              label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              margin="normal"
              required
              autoFocus
              autoComplete="username"
            />
            <TextField
              fullWidth
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              margin="normal"
              required
              helperText="Minimum 8 characters"
              autoComplete="new-password"
            />
            <TextField
              fullWidth
              label="Confirm Password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              margin="normal"
              required
              autoComplete="new-password"
            />
            <Button
              fullWidth
              type="submit"
              variant="contained"
              size="large"
              disabled={saving || !username || !password || !confirmPassword}
              sx={{ mt: 3 }}
            >
              {saving ? <CircularProgress size={24} /> : 'Create Account'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </Box>
  );
}
