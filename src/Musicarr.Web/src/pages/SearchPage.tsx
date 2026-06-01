import { useState } from 'react';
import {
  Box,
  TextField,
  Typography,
  Grid,
  Card,
  CardContent,
  CardMedia,
  Chip,
  InputAdornment,
  CircularProgress,
} from '@mui/material';
import { Search as SearchIcon } from '@mui/icons-material';
import { api } from '../services/api';

interface SearchResults {
  artists: Array<{ id: string; name: string; imageUrl?: string; availability: string }>;
  albums: Array<{ id: string; title: string; artistName?: string; imageUrl?: string; year?: number; availability: string }>;
  tracks: Array<{ id: string; title: string; artistName?: string; availability: string }>;
}

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSearch = async (q: string) => {
    setQuery(q);
    if (q.length < 2) { setResults(null); return; }

    setLoading(true);
    try {
      const response = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
      setResults(response.data);
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setLoading(false);
    }
  };

  const getAvailabilityChip = (availability: string) => {
    const config: Record<string, { label: string; color: 'success' | 'warning' | 'info' | 'default' }> = {
      Available: { label: 'In Library', color: 'success' },
      Requested: { label: 'Requested', color: 'info' },
      Downloading: { label: 'Downloading', color: 'warning' },
      NotAvailable: { label: 'Not in Library', color: 'default' },
    };
    const c = config[availability] || config.NotAvailable;
    return <Chip label={c.label} color={c.color} size="small" />;
  };

  return (
    <Box>
      <TextField
        fullWidth
        placeholder="Search for artists, albums, or tracks..."
        value={query}
        onChange={(e) => handleSearch(e.target.value)}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon />
            </InputAdornment>
          ),
        }}
        sx={{ mb: 4 }}
      />

      {loading && <CircularProgress sx={{ display: 'block', mx: 'auto' }} />}

      {results && (
        <>
          {results.artists.length > 0 && (
            <>
              <Typography variant="h6" sx={{ mb: 2 }} fontWeight={600}>Artists</Typography>
              <Grid container spacing={2} sx={{ mb: 4 }}>
                {results.artists.map((artist) => (
                  <Grid item xs={6} sm={4} md={3} lg={3} key={artist.id}>
                    <Card sx={{ textAlign: 'center', p: 2 }}>
                      <CardMedia
                        component="img"
                        sx={{ width: 120, height: 120, borderRadius: '50%', mx: 'auto' }}
                        image={artist.imageUrl || '/placeholder-artist.svg'}
                        alt={artist.name}
                      />
                      <CardContent>
                        <Typography variant="body2" fontWeight={600}>{artist.name}</Typography>
                        {getAvailabilityChip(artist.availability)}
                      </CardContent>
                    </Card>
                  </Grid>
                ))}
              </Grid>
            </>
          )}

          {results.albums.length > 0 && (
            <>
              <Typography variant="h6" sx={{ mb: 2 }} fontWeight={600}>Albums</Typography>
              <Grid container spacing={2} sx={{ mb: 4 }}>
                {results.albums.map((album) => (
                  <Grid item xs={6} sm={4} md={3} lg={3} key={album.id}>
                    <Card>
                      <CardMedia
                        component="img"
                        height="160"
                        image={album.imageUrl || '/placeholder-album.svg'}
                        alt={album.title}
                      />
                      <CardContent>
                        <Typography variant="body2" fontWeight={600} sx={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{album.title}</Typography>
                        <Typography variant="caption" color="text.secondary">{album.artistName}</Typography>
                        <Box sx={{ mt: 1 }}>{getAvailabilityChip(album.availability)}</Box>
                      </CardContent>
                    </Card>
                  </Grid>
                ))}
              </Grid>
            </>
          )}

          {results.tracks.length > 0 && (
            <>
              <Typography variant="h6" sx={{ mb: 2 }} fontWeight={600}>Tracks</Typography>
              {results.tracks.map((track) => (
                <Box key={track.id} sx={{ display: 'flex', alignItems: 'center', p: 1, borderRadius: 1, '&:hover': { bgcolor: 'action.hover' } }}>
                  <Box sx={{ flexGrow: 1 }}>
                    <Typography variant="body2" fontWeight={600}>{track.title}</Typography>
                    <Typography variant="caption" color="text.secondary">{track.artistName}</Typography>
                  </Box>
                  {getAvailabilityChip(track.availability)}
                </Box>
              ))}
            </>
          )}
        </>
      )}
    </Box>
  );
}
