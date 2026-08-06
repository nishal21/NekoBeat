import { isTauri as tauriRuntime } from "@tauri-apps/api/core";
import type { TrackMeta } from "./types";

/** True when running inside a Tauri webview (not plain browser preview). */
export function isTauri(): boolean {
  try {
    return tauriRuntime();
  } catch {
    return false;
  }
}

export type AlbumGroup = {
  key: string;
  album: string;
  artist: string;
  tracks: TrackMeta[];
  coverUrl?: string;
};

export function groupAlbums(tracks: TrackMeta[]): AlbumGroup[] {
  const map = new Map<string, AlbumGroup>();
  for (const t of tracks) {
    const album = t.album?.trim() || t.title;
    const artist = t.artist?.trim() || "Unknown";
    const key = `${album.toLowerCase()}::${artist.toLowerCase()}`;
    let g = map.get(key);
    if (!g) {
      g = { key, album, artist, tracks: [], coverUrl: t.coverUrl };
      map.set(key, g);
    }
    g.tracks.push(t);
    if (!g.coverUrl && t.coverUrl) g.coverUrl = t.coverUrl;
  }
  return [...map.values()].sort((a, b) => a.album.localeCompare(b.album));
}

export function hueFromKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}
