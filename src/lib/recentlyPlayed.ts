import type { TrackMeta } from "./types";

const KEY = "nb-recently-played-v1";
const MAX = 40;

export function getRecentlyPlayed(): TrackMeta[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is TrackMeta =>
        t && typeof t === "object" && typeof (t as TrackMeta).id === "string",
    );
  } catch {
    return [];
  }
}

export function pushRecentlyPlayed(track: TrackMeta) {
  if (!track?.id) return;
  const slim: TrackMeta = {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    coverUrl: track.coverUrl,
    durationMs: track.durationMs,
    source: track.source,
    path: track.path,
    streamUrl: track.streamUrl,
    qualityLabel: track.qualityLabel,
  };
  const prev = getRecentlyPlayed().filter((t) => t.id !== slim.id);
  const next = [slim, ...prev].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent("nb-recently-played"));
}

export function clearRecentlyPlayed() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent("nb-recently-played"));
}
