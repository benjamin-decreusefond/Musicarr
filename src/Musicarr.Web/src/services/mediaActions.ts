import { api } from './api';

export interface AcquisitionPayload {
  musicBrainzId?: string | null;
  name: string;
  type: 'album';
  artistName?: string;
  albumTitle?: string;
  deezerAlbumId?: string;
}

export async function requestMusic(payload: AcquisitionPayload) {
  await api.post('/api/requests', {
    musicBrainzId: payload.musicBrainzId ?? null,
    name: payload.name,
    type: payload.type,
    artistName: payload.artistName,
    albumTitle: payload.albumTitle,
    deezerAlbumId: payload.deezerAlbumId ?? null,
  });
}

export async function getPlaybackStreamUrl(jellyfinId: string): Promise<string> {
  const response = await api.get<{ streamUrl: string }>(`/api/playback/stream/${jellyfinId}`);
  return response.data.streamUrl;
}

