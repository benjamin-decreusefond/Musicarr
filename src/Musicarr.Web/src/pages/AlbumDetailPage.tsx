import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Skeleton,
  Snackbar,
  Typography,
} from '@mui/material';
import {
  ArrowBack as ArrowBackIcon,
  Download as DownloadIcon,
  MusicNote as MusicNoteIcon,
  PlayArrow as PlayArrowIcon,
} from '@mui/icons-material';
import { api } from '../services/api';
import { getPlaybackStreamUrl, requestMusic } from '../services/mediaActions';

type Availability = 'Available' | 'Requested' | 'Downloading' | 'NotAvailable';

interface Track {
  id: string;
  title: string;
  artistName?: string;
  artistId?: string;
  albumTitle?: string;
  albumId?: string;
  jellyfinId?: string;
  trackNumber: number;
  durationTicks?: number;
  availability: Availability;
}

interface AlbumDetail {
  id: string;
  title: string;
  artistName?: string;
  artistId?: string;
  imageUrl?: string;
  year?: number;
  overview?: string;
  genres?: string[];
  musicBrainzId?: string;
  availability: Availability;
  tracks?: Track[];
}

function formatDuration(ticks?: number): string {
  if (!ticks) return '';
  const totalSeconds = Math.floor(ticks / 10_000_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export default function AlbumDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestState, setRequestState] = useState<Availability | null>(null);
  const [snackbar, setSnackbar] = useState<{ message: string; severity: 'success' | 'error' } | null>(null);

  useEffect(() => {
    if (!id) return;
    const fetchData = async () => {
      setLoading(true);
      try {
        const res = await api.get<AlbumDetail>(`/api/catalog/albums/${id}`);
        setAlbum(res.data);
        setRequestState(res.data.availability);
      } catch (error) {
        console.error('Failed to fetch album:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [id]);

  const handleRequestAlbum = async () => {
    if (!album) return;
    try {
      await requestMusic({
        musicBrainzId: album.musicBrainzId,
        name: album.title,
        albumTitle: album.title,
        artistName: album.artistName,
        type: 'album',
      });
      setRequestState('Requested');
      setSnackbar({ message: `${album.title} requested in Lidarr`, severity: 'success' });
    } catch (error) {
      console.error('Album request failed:', error);
      setSnackbar({ message: `Failed to request ${album.title}`, severity: 'error' });
    }
  };

  const handlePlayTrack = async (track: Track) => {
    if (!track.jellyfinId) return;
    try {
      const streamUrl = await getPlaybackStreamUrl(track.jellyfinId);
      window.open(streamUrl, '_blank', 'noopener,noreferrer');
    } catch (error) {
      console.error('Playback failed:', error);
      setSnackbar({ message: `Unable to start ${track.title}`, severity: 'error' });
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
        <IconButton onClick={() => navigate(-1)} sx={{ mr: 1 }}>
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h4" fontWeight={700}>
          {loading ? <Skeleton width={200} /> : album?.title}
        </Typography>
      </Box>

      {loading ? (
        <Box sx={{ display: 'flex', gap: 3, mb: 4, flexWrap: 'wrap' }}>
          <Skeleton variant="rectangular" width={200} height={200} sx={{ borderRadius: 2 }} />
          <Box>
            <Skeleton width={300} height={32} />
            <Skeleton width={200} height={24} sx={{ mt: 1 }} />
            <Skeleton width={150} height={20} sx={{ mt: 1 }} />
          </Box>
        </Box>
      ) : album && (
        <Box sx={{ display: 'flex', gap: 3, mb: 4, flexWrap: 'wrap' }}>
          <Box component="img" src={album.imageUrl || '/placeholder-album.svg'} alt={album.title} sx={{ width: 200, height: 200, objectFit: 'cover', borderRadius: 2 }} />
          <Box>
            <Typography variant="h5" fontWeight={700}>{album.title}</Typography>
            <Typography
              variant="subtitle1"
              color="text.secondary"
              sx={{ cursor: album.artistId ? 'pointer' : 'default', '&:hover': album.artistId ? { textDecoration: 'underline' } : undefined }}
              onClick={() => album.artistId && navigate(`/artist/${album.artistId}`)}
            >
              {album.artistName}
            </Typography>
            {album.year && <Typography variant="body2" color="text.secondary">{album.year}</Typography>}
            {album.genres && album.genres.length > 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                {album.genres.join(' · ')}
              </Typography>
            )}
            {album.overview && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1, maxWidth: 400 }}>
                {album.overview}
              </Typography>
            )}
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mt: 2 }}>
              <Chip label={requestState === 'Available' ? 'In Library' : requestState === 'Requested' ? 'Requested' : 'Not in Library'} color={requestState === 'Available' ? 'success' : requestState === 'Requested' ? 'info' : 'default'} size="small" />
              {requestState !== 'Available' && (
                <Button variant="contained" startIcon={<DownloadIcon />} onClick={handleRequestAlbum}>
                  {requestState === 'Requested' ? 'Requested' : 'Download Album'}
                </Button>
              )}
            </Box>
          </Box>
        </Box>
      )}

      {!loading && album?.tracks && album.tracks.length > 0 && (
        <>
          <Typography variant="h6" fontWeight={600} sx={{ mb: 1 }}>Tracks</Typography>
          <List disablePadding>
            {album.tracks
              .sort((a, b) => a.trackNumber - b.trackNumber)
              .map((track) => (
                <ListItem
                  key={track.id}
                  sx={{ borderRadius: 1, '&:hover': { bgcolor: 'action.hover' }, px: 1 }}
                  secondaryAction={track.availability === 'Available' && track.jellyfinId ? (
                    <IconButton edge="end" onClick={() => handlePlayTrack(track)}>
                      <PlayArrowIcon />
                    </IconButton>
                  ) : (
                    <Button size="small" startIcon={<DownloadIcon />} onClick={handleRequestAlbum}>
                      Request Album
                    </Button>
                  )}
                >
                  <Typography variant="body2" color="text.secondary" sx={{ minWidth: 28, mr: 1 }}>
                    {track.trackNumber || <MusicNoteIcon fontSize="small" />}
                  </Typography>
                  <ListItemText
                    primary={track.title}
                    secondary={track.artistName}
                    primaryTypographyProps={{ variant: 'body2', fontWeight: 500 }}
                    secondaryTypographyProps={{
                      variant: 'caption',
                      sx: { cursor: track.artistId ? 'pointer' : 'default' },
                      onClick: () => track.artistId && navigate(`/artist/${track.artistId}`),
                    }}
                  />
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mr: 2 }}>
                    {track.durationTicks && (
                      <Typography variant="caption" color="text.secondary">
                        {formatDuration(track.durationTicks)}
                      </Typography>
                    )}
                    {track.availability === 'Available' && <Chip label="In Library" color="success" size="small" />}
                  </Box>
                </ListItem>
              ))}
          </List>
        </>
      )}

      {!loading && (!album?.tracks || album.tracks.length === 0) && (
        <Typography color="text.secondary">No tracks found for this album.</Typography>
      )}

      <Snackbar open={!!snackbar} autoHideDuration={4000} onClose={() => setSnackbar(null)}>
        {snackbar ? <Alert severity={snackbar.severity} onClose={() => setSnackbar(null)}>{snackbar.message}</Alert> : <span />}
      </Snackbar>
    </Box>
  );
}
