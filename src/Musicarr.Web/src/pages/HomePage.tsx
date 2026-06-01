import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Grid,
  Card,
  CardContent,
  CardMedia,
  Skeleton,
  Alert,
  Button,
} from '@mui/material';
import { Settings as SettingsIcon } from '@mui/icons-material';
import { api } from '../services/api';

interface Album {
  id: string;
  title: string;
  artistName?: string;
  imageUrl?: string;
  year?: number;
}

export default function HomePage() {
  const navigate = useNavigate();
  const [recentAlbums, setRecentAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await api.get('/api/catalog/albums');
        setRecentAlbums(response.data.slice(0, 12));
      } catch (error: any) {
        console.error('Failed to fetch albums:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const greeting = new Date().getHours() < 12
    ? 'Morning'
    : new Date().getHours() < 18
      ? 'Afternoon'
      : 'Evening';

  return (
    <Box>
      <Typography variant="h4" gutterBottom fontWeight={700}>
        Good {greeting}
      </Typography>

      {!loading && recentAlbums.length === 0 && (
        <Alert
          severity="info"
          sx={{ mt: 2, mb: 3 }}
          action={
            <Button
              color="inherit"
              size="small"
              startIcon={<SettingsIcon />}
              onClick={() => navigate('/settings')}
            >
              Settings
            </Button>
          }
        >
          Your library is empty. Configure your Jellyfin connection in Settings to see your music.
        </Alert>
      )}

      {(loading || recentAlbums.length > 0) && (
        <>
          <Typography variant="h5" sx={{ mt: 4, mb: 2 }} fontWeight={600}>
            Your Library
          </Typography>

          <Grid container spacing={2}>
            {loading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <Grid item xs={6} sm={4} md={3} lg={2} key={i}>
                    <Skeleton variant="rectangular" height={160} sx={{ borderRadius: 1 }} />
                    <Skeleton width="60%" sx={{ mt: 1 }} />
                    <Skeleton width="40%" />
                  </Grid>
                ))
              : recentAlbums.map((album) => (
                  <Grid item xs={6} sm={4} md={3} lg={2} key={album.id}>
                    <Card
                      sx={{ cursor: 'pointer', height: '100%' }}
                      onClick={() => navigate(`/album/${album.id}`)}
                    >
                      <CardMedia
                        component="img"
                        height="160"
                        image={album.imageUrl || '/placeholder-album.svg'}
                        alt={album.title}
                        sx={{ objectFit: 'cover' }}
                      />
                      <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                        <Typography variant="body2" noWrap fontWeight={600}>
                          {album.title}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" noWrap>
                          {album.artistName} {album.year && `• ${album.year}`}
                        </Typography>
                      </CardContent>
                    </Card>
                  </Grid>
                ))}
          </Grid>
        </>
      )}
    </Box>
  );
}
