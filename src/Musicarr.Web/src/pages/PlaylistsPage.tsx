import { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Grid,
  Card,
  CardContent,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  IconButton,
  Skeleton,
} from '@mui/material';
import { Add as AddIcon, Delete as DeleteIcon, QueueMusic as PlaylistIcon } from '@mui/icons-material';
import { api } from '../services/api';

interface Playlist {
  id: string;
  name: string;
  description?: string;
  trackCount: number;
}

export default function PlaylistsPage() {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const fetchPlaylists = async () => {
    try {
      const res = await api.get('/api/playlists');
      setPlaylists(res.data);
    } catch (error) {
      console.error('Failed to fetch playlists:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchPlaylists(); }, []);

  const handleCreate = async () => {
    try {
      await api.post('/api/playlists', { name: newName, description: newDesc });
      setDialogOpen(false);
      setNewName('');
      setNewDesc('');
      fetchPlaylists();
    } catch (error) {
      console.error('Failed to create playlist:', error);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/api/playlists/${id}`);
      fetchPlaylists();
    } catch (error) {
      console.error('Failed to delete playlist:', error);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Typography variant="h4" fontWeight={700}>Playlists</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setDialogOpen(true)}>
          New Playlist
        </Button>
      </Box>

      <Grid container spacing={2}>
        {loading
          ? Array.from({ length: 4 }).map((_, i) => (
              <Grid item xs={12} sm={6} md={4} key={i}>
                <Skeleton variant="rectangular" height={100} sx={{ borderRadius: 1 }} />
              </Grid>
            ))
          : playlists.map((playlist) => (
              <Grid item xs={12} sm={6} md={4} key={playlist.id}>
                <Card sx={{ display: 'flex', alignItems: 'center', p: 2 }}>
                  <PlaylistIcon sx={{ fontSize: 48, color: 'primary.main', mr: 2 }} />
                  <CardContent sx={{ flexGrow: 1, p: 0, '&:last-child': { pb: 0 } }}>
                    <Typography variant="body1" fontWeight={600}>{playlist.name}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {playlist.trackCount} tracks
                    </Typography>
                  </CardContent>
                  <IconButton onClick={() => handleDelete(playlist.id)} color="error" size="small">
                    <DeleteIcon />
                  </IconButton>
                </Card>
              </Grid>
            ))}
      </Grid>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)}>
        <DialogTitle>Create New Playlist</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            label="Playlist Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            margin="normal"
            autoFocus
          />
          <TextField
            fullWidth
            label="Description (optional)"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            margin="normal"
            multiline
            rows={2}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleCreate} disabled={!newName.trim()}>
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
