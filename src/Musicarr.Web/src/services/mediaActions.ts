import { api } from './api';

export interface AcquisitionPayload {
  musicBrainzId?: string | null;
  name: string;
  type: 'artist' | 'album';
  artistName?: string;
  albumTitle?: string;
}

export async function requestMusic(payload: AcquisitionPayload) {
  await api.post('/api/acquisition/request', {
    musicBrainzId: payload.musicBrainzId ?? null,
    name: payload.name,
    type: payload.type,
    artistName: payload.artistName,
    albumTitle: payload.albumTitle,
  });
}

export async function getPlaybackStreamUrl(jellyfinId: string): Promise<string> {
  const response = await api.get<{ streamUrl: string }>(`/api/playback/stream/${jellyfinId}`);
  return response.data.streamUrl;
}
