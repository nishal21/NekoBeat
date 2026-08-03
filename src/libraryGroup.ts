import type { TrackData } from './hooks';
import type { LibrarySort } from './prefs';

export type ArtistGroup = {
  name: string;
  tracks: TrackData[];
  artwork_url?: string;
};

export type AlbumGroup = {
  name: string;
  artist: string;
  tracks: TrackData[];
  artwork_url?: string;
};

export type GenreGroup = {
  name: string;
  tracks: TrackData[];
  artwork_url?: string;
};

function norm(s: string) {
  return (s || '').trim() || 'Unknown';
}

export function groupByArtist(tracks: TrackData[]): ArtistGroup[] {
  const map = new Map<string, TrackData[]>();
  for (const t of tracks) {
    const key = norm(t.artist);
    const list = map.get(key) || [];
    list.push(t);
    map.set(key, list);
  }
  return Array.from(map.entries())
    .map(([name, list]) => ({
      name,
      tracks: list,
      artwork_url: list.find((x) => x.artwork_url)?.artwork_url,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function groupByAlbum(tracks: TrackData[]): AlbumGroup[] {
  const map = new Map<string, TrackData[]>();
  for (const t of tracks) {
    const album = norm(t.album);
    const artist = norm(t.album_artist || t.artist);
    const key = `${album}\0${artist}`;
    const list = map.get(key) || [];
    list.push(t);
    map.set(key, list);
  }
  return Array.from(map.entries())
    .map(([key, list]) => {
      const [name, artist] = key.split('\0');
      return {
        name,
        artist,
        tracks: list,
        artwork_url: list.find((x) => x.artwork_url)?.artwork_url,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function findArtistTracks(tracks: TrackData[], artist: string): TrackData[] {
  const q = artist.trim().toLowerCase();
  return tracks.filter((t) => norm(t.artist).toLowerCase() === q);
}

export function findAlbumTracks(tracks: TrackData[], album: string, artist: string): TrackData[] {
  const a = album.trim().toLowerCase();
  const ar = artist.trim().toLowerCase();
  return tracks.filter(
    (t) => norm(t.album).toLowerCase() === a && norm(t.album_artist || t.artist).toLowerCase() === ar,
  );
}

export function groupByGenre(tracks: TrackData[]): GenreGroup[] {
  const map = new Map<string, TrackData[]>();
  for (const track of tracks) {
    const genres = (track.genre || 'Unknown Genre')
      .split(/[;,/]/)
      .map((genre) => genre.trim())
      .filter(Boolean);
    for (const genre of genres.length ? genres : ['Unknown Genre']) {
      const list = map.get(genre) || [];
      list.push(track);
      map.set(genre, list);
    }
  }
  return Array.from(map, ([name, list]) => ({
    name,
    tracks: list,
    artwork_url: list.find((track) => track.artwork_url)?.artwork_url,
  })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function findGenreTracks(tracks: TrackData[], genre: string): TrackData[] {
  const query = genre.trim().toLocaleLowerCase();
  return groupByGenre(tracks).find((group) => group.name.toLocaleLowerCase() === query)?.tracks || [];
}

export function sortLibraryTracks(tracks: TrackData[], sort: LibrarySort): TrackData[] {
  return [...tracks].sort((a, b) => {
    if (sort === 'date_added') return (b.date_added || 0) - (a.date_added || 0);
    if (sort === 'year') return (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title);
    if (sort === 'album_artist') {
      return (a.album_artist || a.artist).localeCompare(
        b.album_artist || b.artist,
        undefined,
        { sensitivity: 'base' },
      ) || a.album.localeCompare(b.album, undefined, { sensitivity: 'base' })
        || (a.disc_number || 0) - (b.disc_number || 0)
        || (a.track_number || 0) - (b.track_number || 0);
    }
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  });
}
