import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "./api";
import { isTauri } from "./libraryHelpers";
import type { TrackMeta } from "./types";

/** In-memory cover URLs — once resolved, never re-fetch for this session. */
const mem = new Map<string, string>();
/** Keys that failed to display — skip convertFileSrc and force resolveCover. */
const broken = new Set<string>();

type TrackCover = Pick<
  TrackMeta,
  "id" | "path" | "coverUrl" | "title" | "artist" | "album"
>;

type Job = {
  track: TrackCover;
  resolve: (url: string | null) => void;
};

const waitQ: Job[] = [];
let inflight = 0;
const MAX_INFLIGHT = 2;

function cacheKey(track: TrackCover) {
  return track.id || track.path || track.coverUrl || `${track.artist}|${track.title}`;
}

function isWebSafe(url: string | undefined | null): url is string {
  if (!url) return false;
  return (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("data:image/") ||
    url.startsWith("asset:") ||
    url.startsWith("blob:") ||
    url.startsWith("https://asset.localhost") ||
    url.startsWith("http://asset.localhost")
  );
}

function isLocalPath(url: string) {
  return (
    /^[a-zA-Z]:[\\/]/.test(url) ||
    url.startsWith("\\\\") ||
    url.startsWith("/") ||
    url.startsWith("file:")
  );
}

function toAssetSrc(path: string) {
  return convertFileSrc(path.replace(/^file:\/\//i, ""));
}

function pump() {
  while (inflight < MAX_INFLIGHT && waitQ.length) {
    const job = waitQ.shift()!;
    const key = cacheKey(job.track);
    const hit = mem.get(key);
    if (hit) {
      job.resolve(hit);
      continue;
    }
    inflight += 1;
    api
      .resolveCover(job.track as TrackMeta)
      .then((url) => {
        if (url && (url.startsWith("data:image/") || isWebSafe(url))) {
          if (!url.includes("image/svg")) {
            mem.set(key, url);
            broken.delete(key);
            job.resolve(url);
            return;
          }
        }
        job.resolve(null);
      })
      .catch(() => job.resolve(null))
      .finally(() => {
        inflight -= 1;
        pump();
      });
  }
}

function enqueueResolve(track: TrackCover): Promise<string | null> {
  const key = cacheKey(track);
  const hit = mem.get(key);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    waitQ.push({ track, resolve });
    pump();
  });
}

export function forgetCover(track: TrackCover) {
  const key = cacheKey(track);
  mem.delete(key);
  broken.add(key);
}

/**
 * Resolve a displayable cover URL; caches on hit.
 * Fast path: web URLs + convertFileSrc for local paths.
 * Slow path (queued, max 2): embedded-tag / network resolveCover — never stampede.
 */
export async function getCoverSrc(track: TrackCover): Promise<string | null> {
  const key = cacheKey(track);
  const hit = mem.get(key);
  if (hit) return hit;

  // Remote / data URLs — usable in <img> directly
  if (isWebSafe(track.coverUrl) && !track.coverUrl.includes("image/svg")) {
    mem.set(key, track.coverUrl);
    return track.coverUrl;
  }

  if (!isTauri()) return null;

  // Local cover file from library scan — asset protocol is instant (no base64 IPC).
  if (track.coverUrl && isLocalPath(track.coverUrl) && !broken.has(key)) {
    try {
      const src = toAssetSrc(track.coverUrl);
      mem.set(key, src);
      return src;
    } catch {
      /* fall through to resolveCover */
    }
  }

  // Only hit Rust when we have a real audio/cover path — never for bare title/artist
  // (that used to stampede iTunes/sidecar on every album tile and freeze Library).
  const canResolve =
    Boolean(track.path) ||
    Boolean(track.coverUrl && isLocalPath(track.coverUrl));

  if (!canResolve) return null;

  return enqueueResolve(track);
}

export function peekCoverSrc(track: TrackCover): string | null {
  return mem.get(cacheKey(track)) ?? null;
}
