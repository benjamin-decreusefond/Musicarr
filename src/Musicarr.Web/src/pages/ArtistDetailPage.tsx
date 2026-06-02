import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Alert,
  Avatar,
  Box,
  Card,
  CardContent,
  CardMedia,
  Chip,
  Grid,
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
  PlayArrow as PlayArrowIcon,
} from '@mui/icons-material';
import { api } from '../services/api';
import { getPlaybackStreamUrl, requestMusic } from '../services/mediaActions';
import HorizontalCarousel from '../components/HorizontalCarousel';

type Availability = 'Available' | 'Requested' | 'Downloading' | 'NotAvailable';

interface Track {
  id: string;
  title: string;
  artistName?: string;
  artistId?: string;
  albumTitle?: string;
  albumId?: string;
  jellyfinId?: string;
  availability: Availability;
}

interface ArtistDetail {
  id: string;
  name: string;
  imageUrl?: string;
  overview?: string;
  genres?: string[];
  musicBrainzId?: string;
  availability: Availability;
}

interface Album {
  id: string;
  title: string;
  artistName?: string;
  artistId?: string;
  imageUrl?: string;
  year?: number;
  musicBrainzId?: string;
  availability: Availability;
}

interface RelatedArtist {
  id: string;
  name: string;
  imageUrl?: string;
  availability: Availability;
}

export default function ArtistDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [artist, setArtist] = useState<ArtistDetail | null>(null);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [topTracks, setTopTracks] = useState<Track[]>([]);
  const [relatedArtists, setRelatedArtists] = useState<RelatedArtist[]>([]);
  const [loading, setLoading] = useState(true);
  const [albumRequestOverrides, setAlbumRequestOverrides] = useState<Record<string, Availability>>({});
  const [snackbar, setSnackbar] = useState<{ message: string; severity: 'success' | 'error' } | null>(null);

  useEffect(() => {
    if (!id) return;
    const fetchData = async () => {
      setLoading(true);
      try {
        const [artistRes, albumsRes, tracksRes] = await Promise.all([
          api.get<ArtistDetail>(`/api/catalog/artists/${id}`),
          api.get<Album[]>(`/api/catalog/albums?artistId=${id}`),
          api.get<Track[]>(`/api/catalog/tracks?artistId=${id}`),
        ]);
        setArtist(artistRes.data);
        setAlbums(albumsRes.data);
        setTopTracks(tracksRes.data);
      } catch (error) {
        console.error('Failed to fetch artist:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [id]);

  useEffect(() => {
    if (!id) return;
    api.get<RelatedArtist[]>(`/api/discover/related/${id}`)
      .then((res) => setRelatedArtists(res.data))
      .catch(() => {});
  }, [id]);

  const handleRequestAlbum = async (album: Album, event?: React.MouseEvent) => {
    event?.stopPropagation();
    try {
      await requestMusic({
        musicBrainzId: album.musicBrainzId,
        name: album.title,
        albumTitle: album.title,
        artistName: album.artistName,
        type: 'album',
      });
      setAlbumRequestOverrides((prev) => ({ ...prev, [album.id]: 'Requested' }));
      setSnackbar({ message: `${album.title} requested`, severity: 'success' });
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
          {loading ? <Skeleton width={200} /> : artist?.name}
        </Typography>
      </Box>

      {loading ? (
        <Box sx={{ display: 'flex', alignItems: 'center', mb: 4, gap: 3 }}>
          <Skeleton variant="circular" width={120} height={120} />
          <Box>
            <Skeleton width={300} height={28} />
            <Skeleton width={200} height={20} sx={{ mt: 1 }} />
          </Box>
        </Box>
      ) : artist && (
        <Box sx={{ display: 'flex', alignItems: 'center', mb: 4, gap: 3, flexWrap: 'wrap' }}>
          <Avatar src={artist.imageUrl || '/placeholder-artist.svg'} alt={artist.name} sx={{ width: 120, height: 120 }} />
          <Box>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mb: 1 }}>
              <Chip
                label={artist.availability === 'Available' ? 'In Library' : 'Not in Library'}
                color={artist.availability === 'Available' ? 'success' : 'default'}
                size="small"
              />
            </Box>
            {artist.overview && (
              <Typography variant="body1" color="text.secondary" sx={{ maxWidth: 600 }}>
                {artist.overview}
              </Typography>
            )}
            {artist.genres && artist.genres.length > 0 && (
              <Typography variant="caption" color="text.secondary">
                {artist.genres.join(' · ')}
              </Typography>
            )}
          </Box>
        </Box>
      )}

      {albums.length > 0 && (
        <>
          <Typography variant="h5" fontWeight={600} sx={{ mb: 2 }}>Albums</Typography>
          <Grid container spacing={2} sx={{ mb: 4 }}>
            {albums.map((album) => {
              const availability = albumRequestOverrides[album.id] ?? album.availability;
              return (
                <Grid item xs={6} sm={4} md={3} lg={2} key={album.id}>
                  <Card sx={{ cursor: 'pointer', height: '100%' }} onClick={() => navigate(`/album/${album.id}`)}>
                    <CardMedia component="img" height="160" image={album.imageUrl || '/placeholder-album.svg'} alt={album.title} sx={{ objectFit: 'cover' }} />
                    <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                      <Typography variant="body2" fontWeight={600} sx={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                        {album.title}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {album.year}
                      </Typography>
                      <Box sx={{ mt: 0.5, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <Chip
                          label={availability === 'Available' ? 'In Library' : availability === 'Requested' ? 'Requested' : 'Download'}
                          color={availability === 'Available' ? 'success' : availability === 'Requested' ? 'info' : 'default'}
                          size="small"
                        />
                        {availability !== 'Available' && availability !== 'Requested' && (
                          <IconButton
                            size="small"
                            onClick={(e) => { e.stopPropagation(); handleRequestAlbum(album, e); }}
                            aria-label={`Download ${album.title}`}
                          >
                            <DownloadIcon fontSize="small" />
                          </IconButton>
                        )}
                      </Box>
                    </CardContent>
                  </Card>
                </Grid>
              );
            })}
          </Grid>
        </>
      )}

      {topTracks.length > 0 && (
        <>
          <Typography variant="h5" fontWeight={600} sx={{ mb: 1 }}>Top Tracks</Typography>
          <List disablePadding>
            {topTracks.map((track) => (
              <ListItem key={track.id} sx={{ px: 1, borderRadius: 1, '&:hover': { bgcolor: 'action.hover' } }} secondaryAction={track.availability === 'Available' && track.jellyfinId ? (
                <IconButton edge="end" onClick={() => handlePlayTrack(track)}>
                  <PlayArrowIcon />
                </IconButton>
              ) : undefined}>
                <ListItemText
                  primary={track.title}
                  secondary={track.albumTitle}
                  primaryTypographyProps={{ variant: 'body2', fontWeight: 500 }}
                  secondaryTypographyProps={{
                    variant: 'caption',
                    sx: { cursor: track.albumId ? 'pointer' : 'default' },
                    onClick: () => track.albumId && navigate(`/album/${track.albumId}`),
                  }}
                />
              </ListItem>
            ))}
          </List>
        </>
      )}

      {relatedArtists.length > 0 && (
        <Box sx={{ mt: 4 }}>
          <HorizontalCarousel title="Similar Artists" itemCount={relatedArtists.length}>
            {relatedArtists.map((related) => (
              <Box
                key={related.id}
                sx={{ minWidth: 130, maxWidth: 130, cursor: 'pointer', flexShrink: 0, textAlign: 'center' }}
                onClick={() => navigate(`/artist/${related.id}`)}
              >
                <Box
                  component="img"
                  src={related.imageUrl || '/placeholder-artist.svg'}
                  alt={related.name}
                  sx={{ width: 100, height: 100, borderRadius: '50%', objectFit: 'cover', display: 'block', mx: 'auto' }}
                />
                <Typography variant="caption" fontWeight={600} noWrap display="block" sx={{ mt: 1 }}>
                  {related.name}
                </Typography>
                <Chip
                  label={related.availability === 'Available' ? 'In Library' : 'Not in Library'}
                  color={related.availability === 'Available' ? 'success' : 'default'}
                  size="small"
                />
              </Box>
            ))}
          </HorizontalCarousel>
        </Box>
      )}

      {!loading && albums.length === 0 && (
        <Typography color="text.secondary">No albums found for this artist.</Typography>
      )}

      <Snackbar open={!!snackbar} autoHideDuration={4000} onClose={() => setSnackbar(null)}>
        {snackbar ? <Alert severity={snackbar.severity} onClose={() => setSnackbar(null)}>{snackbar.message}</Alert> : <span />}
      </Snackbar>
    </Box>
  );
}
