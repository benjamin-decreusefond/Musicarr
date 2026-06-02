import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CardMedia,
  Chip,
  CircularProgress,
  Divider,
  Grid,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Snackbar,
  TextField,
  Typography,
} from '@mui/material';
import {
  Album as AlbumIcon,
  Download as DownloadIcon,
  MusicNote as MusicNoteIcon,
  Person as PersonIcon,
  PlayArrow as PlayArrowIcon,
  Search as SearchIcon,
} from '@mui/icons-material';
import { api } from '../services/api';
import { getPlaybackStreamUrl, requestMusic } from '../services/mediaActions';
import HorizontalCarousel from '../components/HorizontalCarousel';

type Availability = 'Available' | 'Requested' | 'Downloading' | 'NotAvailable';

interface SearchArtist {
  id: string;
  name: string;
  imageUrl?: string;
  musicBrainzId?: string;
  availability: Availability;
}

interface SearchAlbum {
  id: string;
  title: string;
  artistName?: string;
  artistId?: string;
  imageUrl?: string;
  year?: number;
  musicBrainzId?: string;
  availability: Availability;
}

interface SearchTrack {
  id: string;
  title: string;
  artistName?: string;
  artistId?: string;
  albumTitle?: string;
  albumId?: string;
  imageUrl?: string;
  jellyfinId?: string;
  availability: Availability;
}

interface SearchResults {
  artists: SearchArtist[];
  albums: SearchAlbum[];
  tracks: SearchTrack[];
}

interface DiscoverSection {
  id: string;
  title: string;
  contentType: string;
  albums?: SearchAlbum[];
  artists?: SearchArtist[];
}

const SHOW_MORE_STEP = 10;
const SUGGESTION_DEBOUNCE_MS = 350;
const SUGGESTION_BLUR_DELAY_MS = 150;

export default function SearchPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [discoverSections, setDiscoverSections] = useState<DiscoverSection[]>([]);
  const [suggestions, setSuggestions] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [showMoreArtists, setShowMoreArtists] = useState(false);
  const [showMoreAlbums, setShowMoreAlbums] = useState(false);
  const [showMoreTracks, setShowMoreTracks] = useState(false);
  const [requestOverrides, setRequestOverrides] = useState<Record<string, Availability>>({});
  const [snackbar, setSnackbar] = useState<{ message: string; severity: 'success' | 'error' } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchDiscover = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get<DiscoverSection[]>('/api/discover');
      setDiscoverSections(response.data);
    } catch (error) {
      console.error('Failed to fetch discover sections:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      setSuggestions(null);
      setShowSuggestions(false);
      fetchDiscover();
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setSuggestions(null);
      setShowSuggestions(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const response = await api.get<SearchResults>(`/api/search?q=${encodeURIComponent(query.trim())}`);
        setSuggestions(response.data);
        setShowSuggestions(true);
      } catch {
        setSuggestions(null);
      }
    }, SUGGESTION_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [fetchDiscover, query]);

  const runFullSearch = useCallback(async (rawQuery: string) => {
    const normalizedQuery = rawQuery.trim();
    if (!normalizedQuery) {
      setResults(null);
      fetchDiscover();
      return;
    }

    if (normalizedQuery.length < 2) return;

    setShowSuggestions(false);
    setLoading(true);
    setShowMoreArtists(false);
    setShowMoreAlbums(false);
    setShowMoreTracks(false);
    try {
      const response = await api.get<SearchResults>(`/api/search?q=${encodeURIComponent(normalizedQuery)}`);
      setResults(response.data);
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setLoading(false);
    }
  }, [fetchDiscover]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      runFullSearch(query);
    }
  };

  const getAvailabilityChip = (availability: Availability) => {
    const config: Record<Availability, { label: string; color: 'success' | 'warning' | 'info' | 'default' }> = {
      Available: { label: 'In Library', color: 'success' },
      Requested: { label: 'Requested', color: 'info' },
      Downloading: { label: 'Downloading', color: 'warning' },
      NotAvailable: { label: 'Not in Library', color: 'default' },
    };
    const current = config[availability];
    return <Chip label={current.label} color={current.color} size="small" />;
  };

  const getAvailability = (key: string, availability: Availability) => requestOverrides[key] ?? availability;

  const topSuggestions = suggestions
    ? [
        ...(suggestions.artists.slice(0, 1).map((artist) => ({ type: 'artist' as const, id: artist.id, label: artist.name, sub: 'Artist', albumId: undefined }))),
        ...(suggestions.albums.slice(0, 1).map((album) => ({ type: 'album' as const, id: album.id, label: album.title, sub: album.artistName || 'Album', albumId: undefined }))),
        ...(suggestions.tracks.slice(0, 1).map((track) => ({ type: 'track' as const, id: track.id, label: track.title, sub: track.artistName || 'Track', albumId: track.albumId }))),
      ]
    : [];

  const handleSuggestionClick = (item: (typeof topSuggestions)[number]) => {
    setShowSuggestions(false);
    if (item.type === 'artist') navigate(`/artist/${item.id}`);
    else if (item.type === 'album') navigate(`/album/${item.id}`);
    else if (item.albumId) navigate(`/album/${item.albumId}`);
    else runFullSearch(query);
  };

  const handleRequestAlbum = async (album: SearchAlbum, event?: React.MouseEvent) => {
    event?.stopPropagation();
    try {
      await requestMusic({
        musicBrainzId: album.musicBrainzId,
        name: album.title,
        albumTitle: album.title,
        artistName: album.artistName,
        type: 'album',
      });
      setRequestOverrides((current) => ({ ...current, [`album:${album.id}`]: 'Requested' }));
      setSnackbar({ message: `${album.title} requested in Lidarr`, severity: 'success' });
    } catch (error) {
      console.error('Album request failed:', error);
      setSnackbar({ message: `Failed to request ${album.title}`, severity: 'error' });
    }
  };

  const handlePlayTrack = async (track: SearchTrack) => {
    if (!track.jellyfinId) return;
    try {
      const streamUrl = await getPlaybackStreamUrl(track.jellyfinId);
      window.open(streamUrl, '_blank', 'noopener,noreferrer');
    } catch (error) {
      console.error('Playback failed:', error);
      setSnackbar({ message: `Unable to start ${track.title}`, severity: 'error' });
    }
  };

  const renderArtistCards = (artists: SearchArtist[]) => (
    <Grid container spacing={2} sx={{ mb: 4 }}>
      {artists.map((artist) => {
        const availability = getAvailability(`artist:${artist.id}`, artist.availability);
        return (
          <Grid item xs={6} sm={4} md={3} lg={3} key={artist.id}>
            <Card sx={{ textAlign: 'center', p: 2, cursor: 'pointer', height: '100%' }} onClick={() => navigate(`/artist/${artist.id}`)}>
              <CardMedia
                component="img"
                sx={{ width: 120, height: 120, borderRadius: '50%', mx: 'auto' }}
                image={artist.imageUrl || '/placeholder-artist.svg'}
                alt={artist.name}
              />
              <CardContent>
                <Typography variant="body2" fontWeight={600}>{artist.name}</Typography>
                <Box sx={{ mt: 1, display: 'flex', justifyContent: 'center' }}>{getAvailabilityChip(availability)}</Box>
              </CardContent>
            </Card>
          </Grid>
        );
      })}
    </Grid>
  );

  const renderAlbumCards = (albums: SearchAlbum[]) => (
    <Grid container spacing={2} sx={{ mb: 4 }}>
      {albums.map((album) => {
        const availability = getAvailability(`album:${album.id}`, album.availability);
        return (
          <Grid item xs={6} sm={4} md={3} lg={3} key={album.id}>
            <Card sx={{ cursor: 'pointer', height: '100%' }} onClick={() => navigate(`/album/${album.id}`)}>
              <CardMedia component="img" height="160" image={album.imageUrl || '/placeholder-album.svg'} alt={album.title} />
              <CardContent>
                <Typography variant="body2" fontWeight={600} sx={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                  {album.title}
                </Typography>
                {album.artistName && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ cursor: album.artistId ? 'pointer' : 'default' }}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (album.artistId) navigate(`/artist/${album.artistId}`);
                    }}
                  >
                    {album.artistName}
                  </Typography>
                )}
                <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                  {getAvailabilityChip(availability)}
                  {availability !== 'Available' && (
                    <IconButton size="small" onClick={(event) => handleRequestAlbum(album, event)}>
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
  );

  const renderTracks = (tracks: SearchTrack[]) => (
    <>
      {tracks.map((track) => {
        const availability = getAvailability(`album:${track.albumId ?? track.id}`, track.availability);
        return (
          <Box
            key={track.id}
            sx={{ display: 'flex', alignItems: 'center', p: 1, borderRadius: 1, '&:hover': { bgcolor: 'action.hover' }, gap: 1.5 }}
          >
            {track.imageUrl ? (
              <Box
                component="img"
                src={track.imageUrl}
                alt={track.title}
                sx={{ width: 40, height: 40, borderRadius: 1, objectFit: 'cover', flexShrink: 0, cursor: track.albumId ? 'pointer' : 'default' }}
                onClick={() => track.albumId && navigate(`/album/${track.albumId}`)}
              />
            ) : (
              <Box sx={{ width: 40, height: 40, borderRadius: 1, bgcolor: 'action.hover', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <MusicNoteIcon fontSize="small" color="disabled" />
              </Box>
            )}
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography variant="body2" fontWeight={600} noWrap>{track.title}</Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                {track.artistName && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ cursor: track.artistId ? 'pointer' : 'default' }}
                    onClick={() => track.artistId && navigate(`/artist/${track.artistId}`)}
                  >
                    {track.artistName}
                  </Typography>
                )}
                {track.albumTitle && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ cursor: track.albumId ? 'pointer' : 'default' }}
                    onClick={() => track.albumId && navigate(`/album/${track.albumId}`)}
                  >
                    • {track.albumTitle}
                  </Typography>
                )}
              </Box>
            </Box>
            {getAvailabilityChip(availability)}
            {availability === 'Available' && track.jellyfinId && (
              <IconButton size="small" onClick={() => handlePlayTrack(track)}>
                <PlayArrowIcon fontSize="small" />
              </IconButton>
            )}
            {availability !== 'Available' && track.albumId && (
              <IconButton
                size="small"
                onClick={() => handleRequestAlbum({
                  id: track.albumId!,
                  title: track.albumTitle || track.title,
                  artistName: track.artistName,
                  artistId: track.artistId,
                  availability: 'NotAvailable',
                })}
              >
                <DownloadIcon fontSize="small" />
              </IconButton>
            )}
          </Box>
        );
      })}
    </>
  );

  const renderArtistCarouselCard = (artist: SearchArtist) => {
    const availability = getAvailability(`artist:${artist.id}`, artist.availability);
    return (
      <Box
        key={artist.id}
        sx={{ minWidth: 140, maxWidth: 140, cursor: 'pointer', flexShrink: 0 }}
        onClick={() => navigate(`/artist/${artist.id}`)}
      >
        <Box
          component="img"
          src={artist.imageUrl || '/placeholder-artist.svg'}
          alt={artist.name}
          sx={{ width: 140, height: 140, borderRadius: '50%', objectFit: 'cover', display: 'block' }}
        />
        <Box sx={{ mt: 1, textAlign: 'center' }}>
          <Typography variant="caption" fontWeight={600} noWrap display="block">{artist.name}</Typography>
          {getAvailabilityChip(availability)}
        </Box>
      </Box>
    );
  };

  const renderAlbumCarouselCard = (album: SearchAlbum) => {
    const availability = getAvailability(`album:${album.id}`, album.availability);
    return (
      <Box
        key={album.id}
        sx={{ minWidth: 150, maxWidth: 150, cursor: 'pointer', flexShrink: 0 }}
        onClick={() => navigate(`/album/${album.id}`)}
      >
        <Box
          component="img"
          src={album.imageUrl || '/placeholder-album.svg'}
          alt={album.title}
          sx={{ width: 150, height: 150, borderRadius: 2, objectFit: 'cover', display: 'block' }}
        />
        <Box sx={{ mt: 1 }}>
          <Typography variant="caption" fontWeight={600} noWrap display="block">{album.title}</Typography>
          {album.artistName && (
            <Typography variant="caption" color="text.secondary" noWrap display="block"
              onClick={(e) => { e.stopPropagation(); if (album.artistId) navigate(`/artist/${album.artistId}`); }}>
              {album.artistName}
            </Typography>
          )}
          <Box sx={{ mt: 0.5, display: 'flex', alignItems: 'center', gap: 0.5 }}>
            {getAvailabilityChip(availability)}
            {availability !== 'Available' && (
              <IconButton size="small" onClick={(e) => { e.stopPropagation(); handleRequestAlbum(album, e); }}>
                <DownloadIcon fontSize="small" />
              </IconButton>
            )}
          </Box>
        </Box>
      </Box>
    );
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
          onBlur={() => setTimeout(() => setShowSuggestions(false), SUGGESTION_BLUR_DELAY_MS)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon />
              </InputAdornment>
            ),
            endAdornment: query.trim().length >= 2 ? (
              <InputAdornment position="end">
                <Button size="small" variant="contained" onClick={() => runFullSearch(query)} sx={{ mr: -1 }}>
                  Search
                </Button>
              </InputAdornment>
            ) : undefined,
          }}
        />

        {showSuggestions && topSuggestions.length > 0 && (
          <Paper sx={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 1300, mt: 0.5, boxShadow: 3 }}>
            <List disablePadding>
              {topSuggestions.map((item, i) => (
                <Box key={`${item.type}-${item.id}`}>
                  {i > 0 && <Divider />}
                  <ListItemButton onClick={() => handleSuggestionClick(item)} sx={{ py: 1 }}>
                    <Box sx={{ mr: 1.5, color: 'text.secondary' }}>
                      {item.type === 'artist' ? <PersonIcon fontSize="small" /> : item.type === 'album' ? <AlbumIcon fontSize="small" /> : <MusicNoteIcon fontSize="small" />}
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
              <ListItemButton onClick={() => runFullSearch(query)} sx={{ py: 1, justifyContent: 'center' }}>
                <Typography variant="body2" color="primary">
                  See all results for "{query}"
                </Typography>
              </ListItemButton>
            </List>
          </Paper>
        )}
      </Box>

      {loading && <CircularProgress sx={{ display: 'block', mx: 'auto', mb: 3 }} />}

      {!query.trim() && discoverSections.length > 0 && (
        <>
          {discoverSections.map((section) => (
            <HorizontalCarousel key={section.id} title={section.title} itemCount={
              section.contentType === 'albums' ? (section.albums?.length ?? 0) : (section.artists?.length ?? 0)
            }>
              {section.contentType === 'albums'
                ? section.albums?.map(renderAlbumCarouselCard)
                : section.artists?.map(renderArtistCarouselCard)}
            </HorizontalCarousel>
          ))}
        </>
      )}

      {query.trim() && results && (
        <>
          {results.artists.length > 0 && (
            <>
              <Typography variant="h6" sx={{ mb: 2 }} fontWeight={600}>Artists</Typography>
              {renderArtistCards(showMoreArtists ? results.artists : results.artists.slice(0, 5))}
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
              {renderAlbumCards(showMoreAlbums ? results.albums : results.albums.slice(0, 6))}
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
              {renderTracks(showMoreTracks ? results.tracks : results.tracks.slice(0, SHOW_MORE_STEP))}
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

      <Snackbar open={!!snackbar} autoHideDuration={4000} onClose={() => setSnackbar(null)}>
        {snackbar ? <Alert severity={snackbar.severity} onClose={() => setSnackbar(null)}>{snackbar.message}</Alert> : <span />}
      </Snackbar>
    </Box>
  );
}
