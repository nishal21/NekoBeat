import type { TrackMeta } from "./types";

/** Session cache so Library reopen doesn't wait on SQLite round-trip. */
let cached: TrackMeta[] | null = null;

export function peekLibraryCache(): TrackMeta[] | null {
  return cached;
}

export function setLibraryCache(tracks: TrackMeta[]) {
  cached = tracks;
}

export function clearLibraryCache() {
  cached = null;
}
