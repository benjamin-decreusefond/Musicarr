import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Typography, Grid, Card, CardContent, CardMedia, Tabs, Tab, Skeleton } from '@mui/material';
import { api } from '../services/api';

interface Artist {
  id: string;
  name: string;
  imageUrl?: string;
}

interface Album {
  id: string;
  title: string;
  artistName?: string;
  imageUrl?: string;
  year?: number;
}

export default function LibraryPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState(0);
  const [artists, setArtists] = useState<Artist[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        if (tab === 0) {
          const res = await api.get('/api/catalog/artists');
          setArtists(res.data);
        } else {
          const res = await api.get('/api/catalog/albums');
          setAlbums(res.data);
        }
      } catch (error) {
        console.error('Failed to fetch library:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [tab]);

  return (
    <Box>
      <Typography variant="h4" gutterBottom fontWeight={700}>Your Library</Typography>

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 3 }}>
        <Tab label="Artists" />
        <Tab label="Albums" />
      </Tabs>

      <Grid container spacing={2}>
        {loading
          ? Array.from({ length: 8 }).map((_, i) => (
              <Grid item xs={6} sm={4} md={3} lg={2} key={i}>
                <Skeleton variant="rectangular" height={160} sx={{ borderRadius: 1 }} />
              </Grid>
            ))
          : tab === 0
          ? artists.map((artist) => (
              <Grid item xs={6} sm={4} md={3} lg={2} key={artist.id}>
                <Card
                  sx={{ textAlign: 'center', p: 2, cursor: 'pointer' }}
                  onClick={() => navigate(`/artist/${artist.id}`)}
                >
                  <CardMedia
                    component="img"
                    sx={{ width: 120, height: 120, borderRadius: '50%', mx: 'auto' }}
                    image={artist.imageUrl || '/placeholder-artist.svg'}
                    alt={artist.name}
                  />
                  <CardContent>
                    <Typography variant="body2" fontWeight={600}>{artist.name}</Typography>
                  </CardContent>
                </Card>
              </Grid>
            ))
          : albums.map((album) => (
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
                  />
                  <CardContent>
                    <Typography variant="body2" noWrap fontWeight={600}>{album.title}</Typography>
                    <Typography variant="caption" color="text.secondary">
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
