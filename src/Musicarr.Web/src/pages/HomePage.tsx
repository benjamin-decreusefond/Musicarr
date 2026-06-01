import { useState, useEffect } from 'react';
import { Box, Typography, Grid, Card, CardContent, CardMedia, Skeleton } from '@mui/material';
import { api } from '../services/api';

interface Album {
  id: string;
  title: string;
  artistName?: string;
  imageUrl?: string;
  year?: number;
}

export default function HomePage() {
  const [recentAlbums, setRecentAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await api.get('/api/catalog/albums');
        setRecentAlbums(response.data.slice(0, 12));
      } catch (error) {
        console.error('Failed to fetch albums:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  return (
    <Box>
      <Typography variant="h4" gutterBottom fontWeight={700}>
        Good {new Date().getHours() < 12 ? 'Morning' : new Date().getHours() < 18 ? 'Afternoon' : 'Evening'}
      </Typography>

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
                <Card sx={{ cursor: 'pointer', height: '100%' }}>
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
    </Box>
  );
}
