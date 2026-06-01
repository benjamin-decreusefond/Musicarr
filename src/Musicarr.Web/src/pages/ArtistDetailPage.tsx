import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Grid,
  Card,
  CardContent,
  CardMedia,
  Skeleton,
  IconButton,
  Avatar,
} from '@mui/material';
import { ArrowBack as ArrowBackIcon } from '@mui/icons-material';
import { api } from '../services/api';

interface ArtistDetail {
  id: string;
  name: string;
  imageUrl?: string;
  overview?: string;
  genres?: string[];
}

interface Album {
  id: string;
  title: string;
  artistName?: string;
  imageUrl?: string;
  year?: number;
}

export default function ArtistDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [artist, setArtist] = useState<ArtistDetail | null>(null);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    const fetchData = async () => {
      setLoading(true);
      try {
        const [artistRes, albumsRes] = await Promise.all([
          api.get(`/api/catalog/artists/${id}`),
          api.get(`/api/catalog/albums?artistId=${id}`),
        ]);
        setArtist(artistRes.data);
        setAlbums(albumsRes.data);
      } catch (error) {
        console.error('Failed to fetch artist:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [id]);

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
          <Avatar
            src={artist.imageUrl || '/placeholder-artist.svg'}
            alt={artist.name}
            sx={{ width: 120, height: 120 }}
          />
          <Box>
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
          <Grid container spacing={2}>
            {albums.map((album) => (
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
                    <Typography
                      variant="body2"
                      fontWeight={600}
                      sx={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
                    >
                      {album.title}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {album.year}
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>
            ))}
          </Grid>
        </>
      )}

      {!loading && albums.length === 0 && (
        <Typography color="text.secondary">No albums found for this artist.</Typography>
      )}
    </Box>
  );
}
