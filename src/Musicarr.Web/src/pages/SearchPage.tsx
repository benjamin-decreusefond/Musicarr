import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
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
  Paper,
  List,
  ListItemButton,
  ListItemText,
  Divider,
  Button,
} from '@mui/material';
import {
  Search as SearchIcon,
  Person as PersonIcon,
  Album as AlbumIcon,
  MusicNote as MusicNoteIcon,
} from '@mui/icons-material';
import { api } from '../services/api';

interface SearchResults {
  artists: Array<{ id: string; name: string; imageUrl?: string; availability: string }>;
  albums: Array<{ id: string; title: string; artistName?: string; imageUrl?: string; year?: number; availability: string }>;
  tracks: Array<{ id: string; title: string; artistName?: string; imageUrl?: string; availability: string }>;
}

const SHOW_MORE_STEP = 10;

export default function SearchPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [suggestions, setSuggestions] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [showMoreArtists, setShowMoreArtists] = useState(false);
  const [showMoreAlbums, setShowMoreAlbums] = useState(false);
  const [showMoreTracks, setShowMoreTracks] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced suggestion fetch while typing
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.length < 2) {
      setSuggestions(null);
      setShowSuggestions(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const response = await api.get(`/api/search?q=${encodeURIComponent(query)}`);
        setSuggestions(response.data);
        setShowSuggestions(true);
      } catch {
        // ignore suggestion errors
      }
    }, 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  const runFullSearch = useCallback(async (q: string) => {
    if (q.length < 2) return;
    setShowSuggestions(false);
    setLoading(true);
    setShowMoreArtists(false);
    setShowMoreAlbums(false);
    setShowMoreTracks(false);
    try {
      const response = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
      setResults(response.data);
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      runFullSearch(query);
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

  const topSuggestions = suggestions
    ? [
        ...(suggestions.artists.slice(0, 1).map(a => ({ type: 'artist' as const, id: a.id, label: a.name, sub: 'Artist' }))),
        ...(suggestions.albums.slice(0, 1).map(a => ({ type: 'album' as const, id: a.id, label: a.title, sub: a.artistName || 'Album' }))),
        ...(suggestions.tracks.slice(0, 1).map(t => ({ type: 'track' as const, id: t.id, label: t.title, sub: t.artistName || 'Track' }))),
      ]
    : [];

  const handleSuggestionClick = (item: typeof topSuggestions[0]) => {
    setShowSuggestions(false);
    if (item.type === 'artist') navigate(`/artist/${item.id}`);
    else if (item.type === 'album') navigate(`/album/${item.id}`);
    else runFullSearch(query);
  };

  return (
    <Box>
      <Box sx={{ position: 'relative', mb: 4 }}>
        <TextField
          fullWidth
          placeholder="Search for artists, albums, or tracks..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => suggestions && setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          inputRef={inputRef}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon />
              </InputAdornment>
            ),
            endAdornment: query.length >= 2 ? (
              <InputAdornment position="end">
                <Button size="small" variant="contained" onClick={() => runFullSearch(query)} sx={{ mr: -1 }}>
                  Search
                </Button>
              </InputAdornment>
            ) : undefined,
          }}
        />

        {/* Suggestions dropdown */}
        {showSuggestions && topSuggestions.length > 0 && (
          <Paper
            sx={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              zIndex: 1300,
              mt: 0.5,
              boxShadow: 3,
            }}
          >
            <List disablePadding>
              {topSuggestions.map((item, i) => (
                <Box key={`${item.type}-${item.id}`}>
                  {i > 0 && <Divider />}
                  <ListItemButton
                    onClick={() => handleSuggestionClick(item)}
                    sx={{ py: 1 }}
                  >
                    <Box sx={{ mr: 1.5, color: 'text.secondary' }}>
                      {item.type === 'artist' ? <PersonIcon fontSize="small" />
                        : item.type === 'album' ? <AlbumIcon fontSize="small" />
                        : <MusicNoteIcon fontSize="small" />}
                    </Box>
                    <ListItemText
                      primary={item.label}
                      secondary={item.sub}
                      primaryTypographyProps={{ variant: 'body2', fontWeight: 500 }}
                      secondaryTypographyProps={{ variant: 'caption' }}
                    />
                    <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                      {item.type}
                    </Typography>
                  </ListItemButton>
                </Box>
              ))}
              <Divider />
              <ListItemButton
                onClick={() => runFullSearch(query)}
                sx={{ py: 1, justifyContent: 'center' }}
              >
                <Typography variant="body2" color="primary">
                  See all results for "{query}"
                </Typography>
              </ListItemButton>
            </List>
          </Paper>
        )}
      </Box>

      {loading && <CircularProgress sx={{ display: 'block', mx: 'auto' }} />}

      {results && (
        <>
          {results.artists.length > 0 && (
            <>
              <Typography variant="h6" sx={{ mb: 2 }} fontWeight={600}>Artists</Typography>
              <Grid container spacing={2} sx={{ mb: 4 }}>
                {(showMoreArtists ? results.artists : results.artists.slice(0, 5)).map((artist) => (
                  <Grid item xs={6} sm={4} md={3} lg={3} key={artist.id}>
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
                        {getAvailabilityChip(artist.availability)}
                      </CardContent>
                    </Card>
                  </Grid>
                ))}
              </Grid>
              {!showMoreArtists && results.artists.length > 5 && (
                <Box sx={{ textAlign: 'center', mb: 3 }}>
                  <Button size="small" onClick={() => setShowMoreArtists(true)}>
                    Show more artists ({results.artists.length - 5} more)
                  </Button>
                </Box>
              )}
            </>
          )}

          {results.albums.length > 0 && (
            <>
              <Typography variant="h6" sx={{ mb: 2 }} fontWeight={600}>Albums</Typography>
              <Grid container spacing={2} sx={{ mb: 4 }}>
                {(showMoreAlbums ? results.albums : results.albums.slice(0, 6)).map((album) => (
                  <Grid item xs={6} sm={4} md={3} lg={3} key={album.id}>
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
                        <Typography variant="body2" fontWeight={600} sx={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{album.title}</Typography>
                        <Typography variant="caption" color="text.secondary">{album.artistName}</Typography>
                        <Box sx={{ mt: 1 }}>{getAvailabilityChip(album.availability)}</Box>
                      </CardContent>
                    </Card>
                  </Grid>
                ))}
              </Grid>
              {!showMoreAlbums && results.albums.length > 6 && (
                <Box sx={{ textAlign: 'center', mb: 3 }}>
                  <Button size="small" onClick={() => setShowMoreAlbums(true)}>
                    Show more albums ({results.albums.length - 6} more)
                  </Button>
                </Box>
              )}
            </>
          )}

          {results.tracks.length > 0 && (
            <>
              <Typography variant="h6" sx={{ mb: 2 }} fontWeight={600}>Tracks</Typography>
              {(showMoreTracks ? results.tracks : results.tracks.slice(0, SHOW_MORE_STEP)).map((track) => (
                <Box key={track.id} sx={{ display: 'flex', alignItems: 'center', p: 1, borderRadius: 1, '&:hover': { bgcolor: 'action.hover' }, gap: 1.5 }}>
                  {track.imageUrl ? (
                    <Box
                      component="img"
                      src={track.imageUrl}
                      alt={track.title}
                      sx={{ width: 40, height: 40, borderRadius: 1, objectFit: 'cover', flexShrink: 0 }}
                    />
                  ) : (
                    <Box sx={{ width: 40, height: 40, borderRadius: 1, bgcolor: 'action.hover', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <MusicNoteIcon fontSize="small" color="disabled" />
                    </Box>
                  )}
                  <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={600} noWrap>{track.title}</Typography>
                    <Typography variant="caption" color="text.secondary" noWrap>{track.artistName}</Typography>
                  </Box>
                  {getAvailabilityChip(track.availability)}
                </Box>
              ))}
              {!showMoreTracks && results.tracks.length > SHOW_MORE_STEP && (
                <Box sx={{ textAlign: 'center', mt: 1 }}>
                  <Button size="small" onClick={() => setShowMoreTracks(true)}>
                    Show more tracks ({results.tracks.length - SHOW_MORE_STEP} more)
                  </Button>
                </Box>
              )}
            </>
          )}
        </>
      )}
    </Box>
  );
}
