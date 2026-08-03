import { useState, useEffect, useRef, useCallback, memo } from "react";
import { createPortal } from "react-dom";
import { Play, Pause, SkipForward, SkipBack, Search, Home, Library, Settings, ChevronDown, Maximize2, Minimize2, ListMusic, Heart, LayoutGrid, List, Volume2, VolumeX, MonitorPlay, GripVertical, Repeat, ArrowUp, ArrowDown, Shuffle, Trash2, Gauge, Disc3, User } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useAudioPlayer, useLibrary, fetchAlbumArt, fillMissingLibraryCovers, ensureTrackCoverArt, coverSrcForUi, resolveCoverForWebView, localArtworkDataUrl, isLocalCoverPath, fetchLyrics, LyricsData, useAggregatorSearch, AggregatedTrack, useLikedLibrary, useEqualizer, usePortablePlaybackControls, PlaybackCapabilities, EQ_PRESETS, useAudioClock, getAudioClock, seedAudioClockDuration, isResumeGuarded, isRealArtworkUrl, isPlaceholderArt, pickStableCover, coversSameAsset, preloadCoverUrl, usePlayQueue, usePlaylists, QueueTrack, TrackData } from "./hooks";
// Used for interacting with system dialogs in Tauri
import { open } from "@tauri-apps/plugin-dialog";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import logoImg from "./assets/logo.png";
import { UpdateNotification, UpdateSettingsCard } from "./UpdateToast";
import type { AvailableUpdate } from "./updates";
import {
  loadShowAudioFormat, saveShowAudioFormat,
  loadNotificationLyrics, saveNotificationLyrics,
  loadCoverFallback, saveCoverFallback,
  loadLrcFromDirectory, saveLrcFromDirectory,
  loadExpandOnPlay, saveExpandOnPlay,
  loadLyricsAlign, saveLyricsAlign,
  loadLibrarySubTab, saveLibrarySubTab,
  loadLibrarySort, saveLibrarySort,
  loadRefreshAtStartup, saveRefreshAtStartup,
  loadPlaylistQueueMode, savePlaylistQueueMode,
  loadPlaybackRestore, savePlaybackRestore,
  loadWindowsTaskbarProgress, saveWindowsTaskbarProgress,
  loadLyricsSize, saveLyricsSize,
  loadAnimationIntensity, saveAnimationIntensity,
  type LibrarySubTab, type LibrarySort, type LyricsAlign,
  type PlaylistQueueMode, type LyricsSize, type AnimationIntensity,
} from "./prefs";
import { findArtistTracks, findAlbumTracks } from "./libraryGroup";
import { LibraryPanel } from "./LibraryPanel";

type RecentPlay = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  artwork_url: string;
  source?: string;
  stream_url?: string;
  filepath?: string;
};

type PersistedPlaybackState = {
  version: number;
  queue: QueueTrack[];
  currentIndex: number;
  loopEnabled: boolean;
  shuffleEnabled: boolean;
  currentTrack: QueueTrack | null;
  positionMs: number;
};

type AndroidPermissionEntry = {
  permission: string;
  label: string;
  applicable: boolean;
  granted: boolean;
};

type AndroidPermissionStatus = {
  apiLevel: number;
  audio: AndroidPermissionEntry;
  notifications: AndroidPermissionEntry;
};

function resolveTrackSource(id?: string, source?: string): string | undefined {
  const s = (source || '').toLowerCase();
  if (s && s !== 'external' && s !== 'unknown') return s;
  const key = id || '';
  if (key.startsWith('yt-')) return 'youtube';
  if (key.startsWith('sc-')) return 'soundcloud';
  if (key.startsWith('sp-')) return 'spotify';
  if (key.startsWith('file:') || /[\\/]/.test(key) || key.endsWith('.mp3') || key.endsWith('.flac') || key.endsWith('.wav') || key.endsWith('.webm') || key.endsWith('.m4a')) {
    return 'local';
  }
  return s || undefined;
}

function SourceHintBadge({ source, className = '' }: { source?: string; className?: string }) {
  if (!source) return null;
  const label =
    source === 'youtube' ? 'YT' :
    source === 'soundcloud' ? 'SC' :
    source === 'spotify' ? 'SP' :
    source === 'local' ? 'Local' :
    source.slice(0, 4).toUpperCase();
  const tone =
    source === 'youtube' ? 'bg-[var(--color-src-youtube)] text-white' :
    source === 'soundcloud' ? 'bg-[var(--color-src-soundcloud)] text-white' :
    source === 'spotify' ? 'bg-[var(--color-src-spotify)] text-black' :
    source === 'local' ? 'bg-white/90 text-black' :
    'bg-white/20 text-white';
  return (
    <span className={`absolute top-1.5 left-1.5 z-10 px-1.5 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wide shadow-lg pointer-events-none ${tone} ${className}`}>
      {label}
    </span>
  );
}

const loadRecentPlays = (): RecentPlay[] => {
  try {
    const list = JSON.parse(localStorage.getItem('nekobeat_recent_plays') || '[]') as RecentPlay[];
    if (!Array.isArray(list)) return [];
    return list.map((p) => ({
      ...p,
      artwork_url: durableArtUrl(p?.artwork_url),
    }));
  } catch {
    return [];
  }
};

/** Persist durable covers for Continue — https or app cover-cache paths (offline). */
function durableArtUrl(url?: string | null): string {
  const u = (url || '').trim();
  if (!u || u.includes('picsum')) return '';
  if (/^https?:\/\//i.test(u)) return u;
  // Local covers dir / embedded extracts — Home converts via coverSrcForUi on render
  if (/[/\\]covers[/\\]/i.test(u) || u.includes('remote_')) return u;
  if (u.startsWith('asset:') || u.includes('asset.localhost') || u.includes('tauri.localhost')) return u;
  return '';
}

/** WebView-safe cover for the now-playing UI (never raw /data/... or file:// paths). */
function playerCoverSrc(
  track?: { artwork_url?: string | null; local_artwork_path?: string | null; filepath?: string } | null,
  coverArt?: string | null,
): string {
  if (coverArt && !isPlaceholderArt(coverArt)) {
    if (
      coverArt.startsWith('data:') ||
      coverArt.startsWith('blob:') ||
      coverArt.startsWith('content:') ||
      /^https?:\/\//i.test(coverArt)
    ) {
      return coverArt;
    }
    const converted = coverSrcForUi(coverArt);
    if (converted) return converted;
  }
  const fromTrack = coverSrcForUi(
    track?.artwork_url,
    track?.local_artwork_path as string | null | undefined,
  );
  if (fromTrack) return fromTrack;
  return '';
}

/**
 * Cover <img> that does not blink: key by track only; preload URL upgrades;
 * never flash the logo while a real cover is already showing.
 */
function StableCoverImg({
  src,
  trackKey,
  sourcePath,
  className,
  alt = '',
  draggable = false,
}: {
  src?: string | null;
  trackKey?: string | null;
  /** Original FS path when src is convertFileSrc — used to recover via data URL on load error. */
  sourcePath?: string | null;
  className?: string;
  alt?: string;
  draggable?: boolean;
}) {
  const [shown, setShown] = useState<string>(src && !isPlaceholderArt(src) ? src : '');
  const trackRef = useRef(trackKey);
  const shownRef = useRef(shown);
  const recoveringRef = useRef(false);
  shownRef.current = shown;

  useEffect(() => {
    const next = (src || '').trim();
    const trackChanged = trackRef.current !== trackKey;
    trackRef.current = trackKey;
    recoveringRef.current = false;

    if (!next || isPlaceholderArt(next)) {
      if (trackChanged && !shownRef.current) setShown('');
      return;
    }

    if (shownRef.current && coversSameAsset(shownRef.current, next)) return;
    if (shownRef.current === next) return;

    let cancelled = false;
    const apply = (url: string) => {
      if (cancelled) return;
      shownRef.current = url;
      setShown(url);
    };

    if (!shownRef.current || trackChanged || isPlaceholderArt(shownRef.current)) {
      if (trackChanged || !shownRef.current) {
        apply(next);
      } else {
        void preloadCoverUrl(next).then((ok) => {
          if (ok) apply(next);
          else if (sourcePath && isLocalCoverPath(sourcePath)) {
            void localArtworkDataUrl(sourcePath).then((data) => {
              if (data) apply(data);
            });
          }
        });
      }
      return () => {
        cancelled = true;
      };
    }

    void preloadCoverUrl(next).then((ok) => {
      if (ok) apply(next);
      else if (sourcePath && isLocalCoverPath(sourcePath)) {
        void localArtworkDataUrl(sourcePath).then((data) => {
          if (data) apply(data);
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [src, trackKey, sourcePath]);

  if (!shown) {
    return <div className={className} style={{ background: 'rgba(24,24,27,0.9)' }} aria-hidden />;
  }

  return (
    <img
      src={shown}
      className={className}
      alt={alt}
      draggable={draggable}
      onError={() => {
        if (recoveringRef.current) return;
        recoveringRef.current = true;
        const path =
          (sourcePath && isLocalCoverPath(sourcePath) ? sourcePath : '') ||
          (isLocalCoverPath(src) ? src! : '');
        if (!path) return;
        void localArtworkDataUrl(path).then((data) => {
          if (data) {
            shownRef.current = data;
            setShown(data);
          }
        });
      }}
    />
  );
}

/** Media3 notification/lock-screen art: https or file:// only (asset: / blob: won't load natively). */
function nativeAndroidArtworkUrl(
  artworkUrl?: string | null,
  localArtworkPath?: string | null,
  coverArt?: string | null,
): string {
  const candidates = [localArtworkPath, artworkUrl, coverArt];
  for (const raw of candidates) {
    const u = (raw || '').trim();
    if (!u || u.includes('picsum')) continue;
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('file:')) return u;
    // Absolute filesystem paths from library cover cache / Folder.jpg
    if (u.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(u)) {
      const normalized = u.replace(/\\/g, '/');
      return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
    }
  }
  return '';
}

const placeholderArt = (_seed?: string) => logoImg;

/** Set player cover without logo thrash — keep previous if next is missing/placeholder. */
function nextPlayerCover(
  prev: string | null,
  artwork?: string | null,
  local?: string | null,
): string | null {
  const next = coverSrcForUi(artwork, local);
  if (next && !isPlaceholderArt(next)) return pickStableCover(prev, next) || next;
  if (prev && !isPlaceholderArt(prev) && isRealArtworkUrl(prev)) return prev;
  return prev;
}

// Provide a stable time formatter outside of renders
const formatTime = (ms: number) => {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const stripExtension = (title: string) => {
  return title.replace(/\.(mp3|flac|wav|m4a|mp4|ogg|opus|aac|wma|aiff|aif|wv|ape|alac|webm|dsf|dff)$/i, '');
};

/** Format chip: FLAC • 1012 kbps • 44.1 kHz • Stereo */
function audioFormatLabel(t: {
  format?: string | null;
  bitrate_kbps?: number | null;
  sample_rate_hz?: number | null;
  channels?: number | null;
  filepath?: string;
}): string {
  const parts: string[] = [];
  const fmt =
    (t.format && t.format.trim()) ||
    (t.filepath ? t.filepath.split('.').pop()?.toUpperCase() : '') ||
    '';
  if (fmt) parts.push(fmt);
  if (t.bitrate_kbps && t.bitrate_kbps > 0) parts.push(`${t.bitrate_kbps} kbps`);
  if (t.sample_rate_hz && t.sample_rate_hz > 0) {
    parts.push(`${(t.sample_rate_hz / 1000).toFixed(t.sample_rate_hz % 1000 === 0 ? 0 : 1)} kHz`);
  }
  if (t.channels === 1) parts.push('Mono');
  else if (t.channels === 2) parts.push('Stereo');
  else if (t.channels && t.channels > 2) parts.push(`${t.channels}ch`);
  return parts.join(' • ');
}

function tracksToQueue(tracks: TrackData[]): QueueTrack[] {
  return tracks.map((t) => ({
    id: t.filepath,
    title: t.title,
    artist: t.artist,
    album: t.album || 'Local',
    duration_ms: t.duration_ms || 0,
    artwork_url: t.artwork_url || '',
    source: t.source || 'local',
    stream_url: t.filepath,
    playbackContext: 'queue' as const,
    local_lyrics: t.local_lyrics,
    format: t.format,
    bitrate_kbps: t.bitrate_kbps,
    sample_rate_hz: t.sample_rate_hz,
    channels: t.channels,
    genre: t.genre,
    track_number: t.track_number,
    disc_number: t.disc_number,
    year: t.year,
    date_added: t.date_added,
  }));
}

function isLocalQueueTrack(t: { source?: string; stream_url?: string; id?: string }): boolean {
  const src = (t.source || '').toLowerCase();
  if (src === 'local') return true;
  const path = t.stream_url || t.id || '';
  if (!path || /^https?:\/\//i.test(path) || path.startsWith('yt-') || path.startsWith('sc-') || path.startsWith('sp-')) return false;
  return /[\\/]/.test(path) || path.startsWith('file:') || path.startsWith('content:');
}

/** Stable key for like state — local library tracks use filepath, not id. */
function trackLikeKey(track: any, fallbackPath?: string | null): string {
  return (
    (track?.id && String(track.id).trim()) ||
    (track?.stream_url && String(track.stream_url).trim()) ||
    (track?.filepath && String(track.filepath).trim()) ||
    (fallbackPath && String(fallbackPath).trim()) ||
    ''
  );
}

/** Seek from click/pointer position on a track element. */
function seekPercentFromClientX(el: HTMLElement, clientX: number): number {
  const bounds = el.getBoundingClientRect();
  if (bounds.width <= 0) return 0;
  return Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
}

type SeekHandler = (e: { currentTarget: HTMLElement; clientX: number }) => void;

const ProgressBar = memo(({ durationMs, onSeek, compact = false }: { durationMs: number | undefined, onSeek: SeekHandler, compact?: boolean }) => {
  const { positionMs, durationMs: clockDur } = useAudioClock();
  // Live GST duration only for the bar — metadata often is full-track while file is a short match/preview
  const dur = clockDur > 0 ? clockDur : (durationMs && durationMs > 0 ? durationMs : 0);
  const percentage = dur > 0 ? Math.min(1, Math.max(0, positionMs / dur)) : 0;
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const lastSeekAt = useRef(0);
  const [dragPct, setDragPct] = useState<number | null>(null);
  const displayPct = dragPct !== null ? dragPct : percentage;

  const pctFromX = (clientX: number) => {
    if (!trackRef.current) return 0;
    return seekPercentFromClientX(trackRef.current, clientX);
  };

  const applySeek = (clientX: number, force = false) => {
    if (!trackRef.current) return;
    const now = performance.now();
    if (!force && now - lastSeekAt.current < 40) return;
    lastSeekAt.current = now;
    onSeek({ currentTarget: trackRef.current, clientX });
  };

  return (
    <div className={`w-full flex items-center select-none ${compact ? 'gap-2' : 'gap-2 sm:gap-3'}`}>
      <span className={`text-neutral-500 tabular-nums text-right shrink-0 ${compact ? 'text-[10px] w-8' : 'text-[10px] sm:text-xs w-8 sm:w-9'}`}>
        {formatTime(dragPct !== null && dur > 0 ? dragPct * dur : positionMs)}
      </span>
      <div
        ref={trackRef}
        className={`relative flex-1 flex items-center touch-none cursor-pointer group ${compact ? 'h-5' : 'h-10 sm:h-8'}`}
        onPointerDown={(e) => {
          dragging.current = true;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const p = pctFromX(e.clientX);
          setDragPct(p);
          applySeek(e.clientX, true);
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          setDragPct(pctFromX(e.clientX));
          applySeek(e.clientX);
        }}
        onPointerUp={(e) => {
          if (dragging.current) applySeek(e.clientX, true);
          dragging.current = false;
          setDragPct(null);
          try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        }}
        onPointerCancel={(e) => {
          dragging.current = false;
          setDragPct(null);
          try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        }}
        onLostPointerCapture={() => { dragging.current = false; setDragPct(null); }}
        role="slider"
        tabIndex={0}
        aria-label="Seek track"
        aria-valuemin={0}
        aria-valuemax={dur || 100}
        aria-valuenow={positionMs}
        onKeyDown={(e) => {
          if (!dur || !trackRef.current) return;
          const rect = trackRef.current.getBoundingClientRect();
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault();
            onSeek({ currentTarget: trackRef.current, clientX: rect.left + (displayPct + 0.05) * rect.width });
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault();
            onSeek({ currentTarget: trackRef.current, clientX: rect.left + (displayPct - 0.05) * rect.width });
          }
        }}
      >
        <div className={`absolute inset-x-0 bg-white/10 rounded-full overflow-hidden shadow-inner transition-[height] ${compact ? 'h-1.5 group-hover:h-2 group-active:h-2' : 'h-1.5 sm:h-2 group-active:h-2.5'}`}>
          <div
            className="absolute inset-y-0 left-0 bg-gradient-to-r from-white/80 to-[var(--color-neon-yellow)] shadow-[0_0_15px_rgba(219,255,0,0.8)]"
            style={{ width: `${displayPct * 100}%` }}
          />
        </div>
        <div
          className={`absolute top-1/2 rounded-full bg-[var(--color-neon-yellow)] border-2 border-black/50 shadow-[0_0_10px_rgba(219,255,0,0.9)] pointer-events-none z-10 ${
            compact ? 'w-3 h-3' : 'w-3.5 h-3.5 sm:w-3.5 sm:h-3.5'
          }`}
          style={{ left: `${displayPct * 100}%`, transform: 'translate(-50%, -50%)' }}
        />
      </div>
      <span className={`text-neutral-500 tabular-nums shrink-0 ${compact ? 'text-[10px] w-8' : 'text-[10px] sm:text-xs w-8 sm:w-9'}`}>
        {dur > 0 ? formatTime(dur) : "-:--"}
      </span>
    </div>
  );
});

/** Thin progress strip for mobile mini-player — visual hint + seek */
const MobileProgressHint = memo(({ durationMs, onSeek }: { durationMs: number | undefined; onSeek: SeekHandler }) => {
  const { positionMs, durationMs: clockDur } = useAudioClock();
  const dur = clockDur > 0 ? clockDur : (durationMs && durationMs > 0 ? durationMs : 0);
  const percentage = dur > 0 ? Math.min(1, Math.max(0, positionMs / dur)) : 0;
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [dragPct, setDragPct] = useState<number | null>(null);
  const displayPct = dragPct !== null ? dragPct : percentage;

  const pctFromX = (clientX: number) => {
    if (!trackRef.current) return 0;
    return seekPercentFromClientX(trackRef.current, clientX);
  };

  return (
    <div
      ref={trackRef}
      className="w-full h-3 flex items-start touch-none cursor-pointer"
      onPointerDown={(e) => {
        e.stopPropagation();
        dragging.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const p = pctFromX(e.clientX);
        setDragPct(p);
        onSeek({ currentTarget: trackRef.current!, clientX: e.clientX });
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        setDragPct(pctFromX(e.clientX));
        onSeek({ currentTarget: trackRef.current!, clientX: e.clientX });
      }}
      onPointerUp={(e) => {
        if (dragging.current) onSeek({ currentTarget: trackRef.current!, clientX: e.clientX });
        dragging.current = false;
        setDragPct(null);
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      }}
      onPointerCancel={() => { dragging.current = false; setDragPct(null); }}
      role="slider"
      tabIndex={0}
      aria-label="Track progress"
      aria-valuemin={0}
      aria-valuemax={dur || 100}
      aria-valuenow={positionMs}
    >
      <div className="w-full h-[3px] bg-white/15 overflow-hidden">
        <div
          className="h-full bg-[var(--color-neon-yellow)] shadow-[0_0_10px_rgba(219,255,0,0.75)] transition-[width] duration-100 ease-linear"
          style={{ width: `${displayPct * 100}%` }}
        />
      </div>
    </div>
  );
});

const ExpandedProgressBar = memo(({ durationMs, onSeek }: { durationMs: number | undefined, onSeek: SeekHandler }) => {
  const { positionMs, durationMs: clockDur } = useAudioClock();
  const dur = (clockDur > 0) ? clockDur : (durationMs && durationMs > 0 ? durationMs : 0);
  const percentage = dur > 0 ? Math.min(1, Math.max(0, positionMs / dur)) : 0;
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const lastSeekAt = useRef(0);
  const [dragPct, setDragPct] = useState<number | null>(null);
  const displayPct = dragPct !== null ? dragPct : percentage;

  const pctFromX = (clientX: number) => {
    if (!trackRef.current) return 0;
    return seekPercentFromClientX(trackRef.current, clientX);
  };

  const applySeek = (clientX: number, force = false) => {
    if (!trackRef.current) return;
    const now = performance.now();
    if (!force && now - lastSeekAt.current < 40) return;
    lastSeekAt.current = now;
    onSeek({ currentTarget: trackRef.current, clientX });
  };

  return (
    <div className="w-full flex items-center gap-2.5 sm:gap-3 select-none">
      <span className="text-[11px] sm:text-xs text-[var(--color-neon-yellow)] font-sans tabular-nums w-9 sm:w-10 text-right shrink-0">
        {formatTime(dragPct !== null && dur > 0 ? dragPct * dur : positionMs)}
      </span>
      <div
        ref={trackRef}
        className="relative flex-1 h-11 sm:h-10 flex items-center touch-none cursor-pointer group"
        onPointerDown={(e) => {
          dragging.current = true;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setDragPct(pctFromX(e.clientX));
          applySeek(e.clientX, true);
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          setDragPct(pctFromX(e.clientX));
          applySeek(e.clientX);
        }}
        onPointerUp={(e) => {
          if (dragging.current) applySeek(e.clientX, true);
          dragging.current = false;
          setDragPct(null);
          try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        }}
        onPointerCancel={() => { dragging.current = false; setDragPct(null); }}
        role="slider"
        tabIndex={0}
        aria-label="Seek track"
        aria-valuemin={0}
        aria-valuemax={dur || 100}
        aria-valuenow={positionMs}
      >
        <div className="absolute inset-x-0 h-2 bg-white/10 rounded-full overflow-hidden shadow-inner group-active:h-2.5 transition-[height]">
          <div
            className="absolute inset-y-0 left-0 bg-gradient-to-r from-white/80 to-[var(--color-neon-yellow)] shadow-[0_0_15px_rgba(219,255,0,0.8)]"
            style={{ width: `${displayPct * 100}%` }}
          />
        </div>
        <div
          className="absolute top-1/2 w-4 h-4 rounded-full bg-[var(--color-neon-yellow)] border-2 border-black/40 shadow-[0_0_12px_rgba(219,255,0,0.9)] pointer-events-none z-10"
          style={{ left: `${displayPct * 100}%`, transform: 'translate(-50%, -50%)' }}
        />
      </div>
      <span className="text-[11px] sm:text-xs text-neutral-500 font-sans tabular-nums w-9 sm:w-10 shrink-0">
        {dur > 0 ? formatTime(dur) : "-:--"}
      </span>
    </div>
  );
});

/** Volume: vertical flyout (portaled — not clipped by player overflow) or inline for expanded view. */
const VolumeControl = memo(({ volume, onChange, alwaysShow = false }: { volume: number, onChange: (v: number) => void, alwaysShow?: boolean }) => {
  const [open, setOpen] = useState(false);
  const [flyoutPos, setFlyoutPos] = useState<{ left: number; bottom: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volSpring = { type: "spring" as const, stiffness: 420, damping: 32, mass: 0.6 };

  const clearClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleClose = () => {
    clearClose();
    closeTimer.current = setTimeout(() => setOpen(false), 160);
  };

  const updateFlyoutPos = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setFlyoutPos({
      left: r.left + r.width / 2,
      bottom: window.innerHeight - r.top + 8,
    });
  }, []);

  useEffect(() => {
    if (!open || alwaysShow) return;
    updateFlyoutPos();
    const onMove = () => updateFlyoutPos();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, alwaysShow, updateFlyoutPos]);

  useEffect(() => () => clearClose(), []);

  const VolumeIcon = (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={volume === 0 ? "mute" : "vol"}
        initial={{ opacity: 0, scale: 0.65, y: 4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.65, y: -4 }}
        transition={{ duration: 0.14, ease: "easeOut" }}
        className="inline-flex"
      >
        {volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
      </motion.span>
    </AnimatePresence>
  );

  if (alwaysShow) {
    return (
      <div className="flex items-center gap-2 w-full max-w-[240px]">
        <motion.button
          type="button"
          whileTap={{ scale: 0.88 }}
          className="text-neutral-300 hover:text-white transition-colors p-2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full hover:bg-white/5 shrink-0"
          onClick={() => onChange(volume === 0 ? 0.7 : 0)}
          aria-label={volume === 0 ? "Unmute" : "Mute"}
        >
          {VolumeIcon}
        </motion.button>
        <div className="relative flex-1 h-10 flex items-center group">
          <div className="absolute inset-x-0 h-1.5 bg-white/10 rounded-full overflow-hidden pointer-events-none group-active:h-2 transition-[height]">
            <motion.div
              className="h-full origin-left rounded-full bg-[var(--color-neon-yellow)] shadow-[0_0_10px_rgba(219,255,0,0.55)]"
              style={{ width: "100%" }}
              animate={{ scaleX: Math.max(0, Math.min(1, volume)) }}
              transition={volSpring}
            />
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            aria-label="Volume"
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer touch-manipulation z-10"
          />
        </div>
      </div>
    );
  }

  const flyout = createPortal(
    <AnimatePresence>
      {open && flyoutPos && (
        <motion.div
          key="vol-flyout"
          initial={{ opacity: 0, y: 10, scale: 0.92, x: "-50%" }}
          animate={{ opacity: 1, y: 0, scale: 1, x: "-50%" }}
          exit={{ opacity: 0, y: 8, scale: 0.95, x: "-50%" }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="fixed z-[200] flex flex-col items-center justify-center w-14 h-44 bg-zinc-900/95 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl py-3 pointer-events-auto"
          style={{
            left: flyoutPos.left,
            bottom: flyoutPos.bottom,
          }}
          onMouseEnter={() => {
            clearClose();
            setOpen(true);
          }}
          onMouseLeave={scheduleClose}
        >
          <div className="relative w-10 h-36 flex items-center justify-center">
            <div className="relative w-1.5 h-full bg-white/10 rounded-full overflow-hidden pointer-events-none">
              <motion.div
                className="absolute bottom-0 w-full bg-[var(--color-neon-yellow)] rounded-full shadow-[0_0_10px_rgba(219,255,0,0.5)]"
                animate={{ height: `${Math.max(0, Math.min(1, volume)) * 100}%` }}
                transition={volSpring}
              />
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(e) => onChange(parseFloat(e.target.value))}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer orientation-vertical z-10 touch-manipulation"
              aria-label="Volume"
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );

  return (
    <div
      ref={wrapRef}
      className="relative flex items-center justify-center"
      onMouseEnter={() => {
        clearClose();
        updateFlyoutPos();
        setOpen(true);
      }}
      onMouseLeave={scheduleClose}
    >
      {flyout}
      <motion.button
        type="button"
        whileTap={{ scale: 0.88 }}
        className="text-neutral-400 hover:text-white transition-colors p-2 min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-white/5 rounded-full"
        onClick={() => {
          if (open) onChange(volume === 0 ? 0.7 : 0);
          else {
            updateFlyoutPos();
            setOpen(true);
          }
        }}
        aria-label={volume === 0 ? "Unmute" : "Volume"}
        aria-expanded={open}
      >
        {VolumeIcon}
      </motion.button>
    </div>
  );
});

const SettingsToggle = memo(({ title, desc, value, onChange }: { title: string; desc: string; value: boolean; onChange: (v: boolean) => void }) => (
  <button
    type="button"
    onClick={() => onChange(!value)}
    className={`flex items-center justify-between gap-3 p-4 min-h-[64px] rounded-2xl transition-all border text-left w-full ${
      value
        ? 'bg-white/10 border-[var(--color-neon-yellow)] shadow-[0_0_15px_-5px_rgba(219,255,0,0.3)]'
        : 'bg-black/20 border-white/5 hover:bg-white/5'
    }`}
  >
    <div className="min-w-0">
      <span className="font-bold text-white block">{title}</span>
      <span className="text-xs text-[var(--color-ink-muted)]">{desc}</span>
    </div>
    <div className={`w-12 h-6 rounded-full transition-colors relative shrink-0 ${value ? 'bg-[var(--color-neon-yellow)]' : 'bg-neutral-800'}`}>
      <div className={`absolute top-1 w-4 h-4 rounded-full transition-all ${value ? 'left-7 bg-black' : 'left-1 bg-neutral-400'}`} />
    </div>
  </button>
));

const LyricsDisplay = memo(({ parsedLyrics, hasPlainLyrics, plainLyricsText, lyricsOffsetMs, onOffsetChange, onUploadLyrics, onActiveLineChange, align = 'left', size = 'medium', lyricsSource }: { parsedLyrics: { timeMs: number, text: string }[], hasPlainLyrics: boolean, plainLyricsText?: string, lyricsOffsetMs: number, onOffsetChange: (offset: number) => void, onUploadLyrics?: () => void, onActiveLineChange?: (line: string, index: number, context: string) => void, align?: LyricsAlign, size?: LyricsSize, lyricsSource?: string }) => {
  const { positionMs } = useAudioClock();
  const lastNotifiedLyricRef = useRef(-1);
  let activeLyricIndex = -1;
  const adjustedPositionMs = positionMs - lyricsOffsetMs;
  for (let i = 0; i < parsedLyrics.length; i++) {
    if (adjustedPositionMs >= parsedLyrics[i].timeMs) {
      activeLyricIndex = i;
    } else {
      break;
    }
  }

  useEffect(() => {
    lastNotifiedLyricRef.current = -1;
  }, [parsedLyrics]);

  // Smoothly scroll the active lyric into the center of the mask
  useEffect(() => {
    if (activeLyricIndex >= 0 && parsedLyrics.length > 0) {
      const activeLine = document.getElementById(`lyric-${activeLyricIndex}`);
      if (activeLine) {
        activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      if (activeLyricIndex !== lastNotifiedLyricRef.current) {
        lastNotifiedLyricRef.current = activeLyricIndex;
    // ±2 lines around the active lyric for the notification BigText view
    const from = Math.max(0, activeLyricIndex - 2);
    const to = Math.min(parsedLyrics.length, activeLyricIndex + 3);
        const context = parsedLyrics
          .slice(from, to)
          .map((item, offset) => {
            const index = from + offset;
            return index === activeLyricIndex ? `▶ ${item.text}` : item.text;
          })
          .join('\n');
        onActiveLineChange?.(parsedLyrics[activeLyricIndex].text, activeLyricIndex, context);
      }
    }
  }, [activeLyricIndex, parsedLyrics, onActiveLineChange]);

  return (
    <div
      className="lyrics-container no-scrollbar h-full min-h-0 w-full py-[30vh] md:py-[40vh] px-4 md:px-8 overflow-y-auto scroll-smooth group/lyrics"
      id="lyrics-scroll-root"
      style={{
        maskImage: "linear-gradient(to bottom, transparent 0%, black 20%, black 80%, transparent 100%)",
        WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 20%, black 80%, transparent 100%)"
      }}
    >
      {/* Control Bar */}
      <div className="fixed top-8 right-8 z-50 flex items-center gap-2 transition-opacity group-hover/lyrics:opacity-100 opacity-20 hover:opacity-100">
        {lyricsSource && (
          <span
            className="hidden sm:inline-flex bg-black/40 backdrop-blur-xl rounded-full px-3 py-2 border border-white/10 text-[10px] font-black uppercase tracking-widest text-[var(--color-neon-yellow)]"
            title={`Lyrics source: ${lyricsSource}`}
          >
            {lyricsSource === 'cache' ? 'Offline lyrics' : lyricsSource}
          </span>
        )}
        {onUploadLyrics && (
           <button 
             onClick={onUploadLyrics}
             className="flex items-center gap-2 bg-black/40 backdrop-blur-xl rounded-full px-4 py-2 border border-white/10 shadow-2xl text-xs font-bold text-white hover:text-[var(--color-neon-yellow)] hover:bg-white/10 transition-all"
             title="Upload Lyrics (.lrc, .srt, .vtt)"
           >
             <ListMusic size={14} />
             <span>Upload</span>
           </button>
        )}
        {parsedLyrics.length > 0 && (
          <div className="flex items-center gap-4 bg-black/40 backdrop-blur-xl rounded-full px-4 py-2 border border-white/10 shadow-2xl">
            <button onClick={() => onOffsetChange(lyricsOffsetMs - 500)} className="text-white hover:text-[var(--color-neon-yellow)] font-bold w-6 h-6 flex items-center justify-center bg-white/10 rounded-full" title="Advance lyrics (-0.5s)">-</button>
            <span className="text-xs font-mono text-white font-bold w-12 text-center" title="Current Lyrics Offset">{lyricsOffsetMs > 0 ? '+' : ''}{(lyricsOffsetMs / 1000).toFixed(1)}s</span>
            <button onClick={() => onOffsetChange(lyricsOffsetMs + 500)} className="text-white hover:text-[var(--color-neon-yellow)] font-bold w-6 h-6 flex items-center justify-center bg-white/10 rounded-full" title="Delay lyrics (+0.5s)">+</button>
          </div>
        )}
      </div>

      {parsedLyrics.length > 0 ? (
        <div className={`flex flex-col gap-6 md:gap-10 ${align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : 'text-left'}`}>
          {parsedLyrics.map((line, ix) => {
            const isActive = ix === activeLyricIndex;
            const origin = align === 'center' ? 'origin-center' : align === 'right' ? 'origin-right' : 'origin-left';

            return (
              <div
                key={ix}
                id={`lyric-${ix}`}
                className={`px-2 py-1 transition-all duration-500 ease-out ${origin} will-change-[transform,opacity]
                  ${isActive ? 'scale-105 opacity-100' : 'scale-100 opacity-20'}`}
              >
                <p className={`${size === 'small' ? 'text-xl md:text-4xl' : size === 'large' ? 'text-3xl md:text-6xl' : 'text-2xl md:text-5xl'} font-lyrics font-black tracking-tight leading-tight transition-colors duration-500
                  ${isActive ? 'liquid-neon-text' : 'text-white'}`}>
                  {line.text}
                </p>
              </div>
            );
          })}
        </div>
      ) : hasPlainLyrics && plainLyricsText ? (
        <div className={`flex flex-col gap-4 py-8 ${align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : 'text-left'}`}>
          <p className="text-sm font-bold text-[var(--color-neon-yellow)] tracking-widest uppercase mb-4 opacity-80">Unsynchronized Lyrics</p>
          {plainLyricsText.split('\n').map((line, ix) => (
            <div key={ix} className="px-2 py-1">
              <p className={`${size === 'small' ? 'text-xl md:text-3xl' : size === 'large' ? 'text-3xl md:text-5xl' : 'text-2xl md:text-4xl'} font-lyrics font-bold tracking-tight leading-tight text-white/80`}>
                {line || "\u00A0"}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <div className="h-full flex items-center justify-center text-2xl md:text-3xl font-display font-bold text-white/30 text-center px-8">
          <p>No lyrics found for this track.</p>
        </div>
      )}
    </div>
  );
});

const ViewToggle = memo(({ viewMode, onChange }: { viewMode: 'grid' | 'list', onChange: (mode: 'grid' | 'list') => void }) => {
  return (
    <div className="inline-flex items-center gap-1 bg-white/5 p-1 rounded-xl border border-white/10 shrink-0 h-11">
      <button
        type="button"
        onClick={() => onChange('grid')}
        className={`p-2 md:p-1.5 min-w-[40px] h-9 md:min-w-0 md:h-auto rounded-lg transition-all flex items-center justify-center ${viewMode === 'grid' ? 'bg-[var(--color-neon-yellow)] text-black' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}
        title="Grid View"
        aria-label="Grid view"
        aria-pressed={viewMode === 'grid'}
      >
        <LayoutGrid size={18} />
      </button>
      <button
        type="button"
        onClick={() => onChange('list')}
        className={`p-2 md:p-1.5 min-w-[40px] h-9 md:min-w-0 md:h-auto rounded-lg transition-all flex items-center justify-center ${viewMode === 'list' ? 'bg-[var(--color-neon-yellow)] text-black' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}
        title="List View"
        aria-label="List view"
        aria-pressed={viewMode === 'list'}
      >
        <List size={18} />
      </button>
    </div>
  );
});

interface NewsTrack {
  title: string;
  artist: string;
  artwork_url: string;
  url: string;
  release_date: string;
  source?: string;
  country?: string;
}

const NEWS_COUNTRY_OPTIONS: { code: string; label: string }[] = [
  { code: "auto", label: "Auto (system locale)" },
  { code: "in", label: "India (JioSaavn + local charts)" },
  { code: "us", label: "United States" },
  { code: "gb", label: "United Kingdom" },
  { code: "jp", label: "Japan" },
  { code: "kr", label: "South Korea" },
  { code: "de", label: "Germany" },
  { code: "fr", label: "France" },
  { code: "br", label: "Brazil" },
  { code: "ca", label: "Canada" },
  { code: "au", label: "Australia" },
  { code: "mx", label: "Mexico" },
  { code: "es", label: "Spain" },
  { code: "it", label: "Italy" },
  { code: "id", label: "Indonesia" },
  { code: "ph", label: "Philippines" },
];

function localeNewsCountry(): string {
  try {
    // Timezone is more reliable than Windows UI language (often en-US in India)
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    if (/Kolkat|Calcutta|Asia\/Kolkata/i.test(tz)) return "in";
    if (tz === "Asia/Tokyo") return "jp";
    if (tz === "Asia/Seoul") return "kr";
    if (tz === "America/Sao_Paulo") return "br";
    if (tz === "Europe/London") return "gb";
    if (tz.startsWith("America/") && /New_York|Chicago|Denver|Los_Angeles|Phoenix/.test(tz)) return "us";

    const loc =
      Intl.DateTimeFormat().resolvedOptions().locale ||
      (typeof navigator !== "undefined" ? navigator.language : "") ||
      "en-US";
    const parts = loc.replace(/_/g, "-").split("-");
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p.length === 2 && /^[A-Za-z]{2}$/.test(p)) return p.toLowerCase();
    }
  } catch {
    /* ignore */
  }
  return "us";
}

/** Settings override → system locale/timezone → us */
function resolveNewsCountry(): string {
  const saved = localStorage.getItem("nekobeat_news_country");
  if (saved && saved !== "auto" && /^[a-z]{2}$/.test(saved)) return saved;
  return localeNewsCountry();
}

function newsSourceBadge(track: NewsTrack): string {
  if (track.source === "jiosaavn") return "IN";
  if (track.source === "apple") {
    return (track.country || "??").toUpperCase();
  }
  if (track.source === "lastfm") return "LFM";
  return "";
}

const Equalizer = memo(() => {
  const { gains, updateGain, applyPreset, resetGains } = useEqualizer();
  const bands = [
    { label: '31', sub: 'Bass' },
    { label: '62', sub: 'Bass' },
    { label: '125', sub: 'Low' },
    { label: '250', sub: 'Mid' },
    { label: '500', sub: 'Mid' },
    { label: '1k', sub: 'Mid' },
    { label: '2k', sub: 'High' },
    { label: '4k', sub: 'Treble' },
    { label: '8k', sub: 'Treble' },
    { label: '16k', sub: 'Air' },
  ];

  const activePreset = Object.entries(EQ_PRESETS).find(
    ([, presetGains]) => presetGains.length === gains.length && presetGains.every((v, i) => v === gains[i])
  )?.[0] ?? null;

  const gainToFillPct = (gain: number) => Math.max(0, Math.min(100, ((gain + 24) / 36) * 100));

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 sm:gap-4">
        <div className="min-w-0">
          <p className="section-kicker mb-1.5">DSP</p>
          <h3 className="text-lg sm:text-xl font-display font-bold text-white tracking-tight flex items-center gap-2">
            <Volume2 size={20} className="text-[var(--color-neon-yellow)] shrink-0" />
            10-band equalizer
          </h3>
          <p className="text-sm text-[var(--color-ink-muted)] mt-1">
            Drag bands while a track plays — changes apply live.
          </p>
        </div>
        <button
          type="button"
          onClick={resetGains}
          className="self-start sm:self-auto px-3.5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border border-white/10 bg-white/5 text-neutral-300 hover:text-white hover:border-white/25 active:scale-95 transition-all min-h-[44px]"
        >
          Reset flat
        </button>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="EQ presets">
        {Object.entries(EQ_PRESETS).map(([name, presetGains]) => {
          const isActive = activePreset === name;
          return (
            <button
              key={name}
              type="button"
              onClick={() => applyPreset(presetGains)}
              className={`px-3.5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all border whitespace-nowrap active:scale-95 min-h-[40px] ${
                isActive
                  ? 'bg-[var(--color-neon-yellow)] text-black border-[var(--color-neon-yellow)] shadow-[0_0_18px_rgba(219,255,0,0.28)]'
                  : 'bg-white/5 text-neutral-400 border-white/5 hover:border-white/20 hover:text-white'
              }`}
            >
              {name}
            </button>
          );
        })}
      </div>

      <div className="relative rounded-2xl border border-white/10 bg-black/25 px-2 py-4 sm:px-3 sm:py-5 md:px-4">
        <div className="pointer-events-none absolute left-1 top-4 bottom-16 hidden sm:flex flex-col justify-between text-[9px] font-bold text-neutral-600 tabular-nums select-none pl-0.5">
          <span>+12</span>
          <span>0</span>
          <span>−24</span>
        </div>

        <div className="eq-bands sm:pl-6">
          {bands.map((band, i) => (
            <div key={band.label} className="eq-band">
              <div className="eq-slider-slot">
                <div className="eq-slider-fill" style={{ height: `${gainToFillPct(gains[i])}%` }} />
                <input
                  type="range"
                  className="eq-slider"
                  min={-24}
                  max={12}
                  step={0.5}
                  value={gains[i]}
                  aria-label={`${band.label}Hz ${band.sub}`}
                  onChange={(e) => updateGain(i, parseFloat(e.target.value))}
                />
              </div>
              <div className="text-center leading-tight px-0.5">
                <p className="text-[10px] sm:text-[11px] font-black text-white tracking-wide">{band.label}</p>
                <p className="text-[8px] sm:text-[9px] text-neutral-500 uppercase font-bold">{band.sub}</p>
                <p className={`text-[10px] sm:text-[11px] font-bold mt-0.5 tabular-nums ${gains[i] === 0 ? 'text-neutral-600' : 'text-[var(--color-neon-yellow)]'}`}>
                  {gains[i] > 0 ? `+${gains[i]}` : gains[i]}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

type PortablePlaybackControlsProps = {
  capabilities: PlaybackCapabilities;
  playbackRate: number;
  replayGainMode: 'off' | 'track' | 'album';
  replayGainPreamp: number;
  onPlaybackRateChange: (value: number) => Promise<void>;
  onReplayGainModeChange: (value: 'off' | 'track' | 'album') => void;
  onReplayGainPreampChange: (value: number) => void;
};

const PortablePlaybackControls = memo(({
  capabilities,
  playbackRate,
  replayGainMode,
  replayGainPreamp,
  onPlaybackRateChange,
  onReplayGainModeChange,
  onReplayGainPreampChange,
}: PortablePlaybackControlsProps) => (
  <div className="space-y-6">
    <div>
      <p className="section-kicker mb-1.5">Portable playback</p>
      <h3 className="text-lg sm:text-xl font-display font-bold text-white tracking-tight flex items-center gap-2">
        <Gauge size={20} className="text-[var(--color-neon-yellow)]" />
        Speed & loudness
      </h3>
      <p className="text-sm text-[var(--color-ink-muted)] mt-1">
        Global controls backed by the native GStreamer player.
      </p>
    </div>

    {capabilities.playback_rate && (
      <fieldset className="space-y-3">
        <legend className="sr-only">Playback speed</legend>
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm font-bold text-white">Playback speed</span>
          <output className="text-sm font-black tabular-nums text-[var(--color-neon-yellow)]">
            {playbackRate.toFixed(2)}×
          </output>
        </div>
        <input
          type="range"
          min={capabilities.min_playback_rate}
          max={capabilities.max_playback_rate}
          step={0.05}
          value={playbackRate}
          aria-label="Playback speed"
          onChange={(event) => { void onPlaybackRateChange(Number(event.target.value)); }}
          className="w-full accent-[var(--color-neon-yellow)]"
        />
        <div className="flex flex-wrap gap-2">
          {[0.75, 1, 1.25, 1.5, 2].map((rate) => (
            <button
              key={rate}
              type="button"
              onClick={() => { void onPlaybackRateChange(rate); }}
              aria-pressed={Math.abs(playbackRate - rate) < 0.001}
              className={`px-3 py-2 min-h-[40px] rounded-xl text-xs font-bold border transition-colors ${
                Math.abs(playbackRate - rate) < 0.001
                  ? 'bg-[var(--color-neon-yellow)] border-[var(--color-neon-yellow)] text-black'
                  : 'bg-white/5 border-white/10 text-neutral-300 hover:border-white/25'
              }`}
            >
              {rate}×
            </button>
          ))}
        </div>
      </fieldset>
    )}

    {capabilities.replay_gain && (
      <fieldset className="space-y-4">
        <legend className="sr-only">ReplayGain</legend>
        <div>
          <span className="text-sm font-bold text-white">ReplayGain</span>
          <p className="text-xs text-[var(--color-ink-muted)] mt-1">
            Uses stored tags when present. Album mode falls back to track gain; clipping protection is always applied.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2" role="group" aria-label="ReplayGain mode">
          {(['off', 'track', 'album'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={replayGainMode === mode}
              onClick={() => onReplayGainModeChange(mode)}
              className={`capitalize px-3 py-2.5 min-h-[44px] rounded-xl text-xs font-bold border transition-colors ${
                replayGainMode === mode
                  ? 'bg-[var(--color-neon-yellow)] border-[var(--color-neon-yellow)] text-black'
                  : 'bg-white/5 border-white/10 text-neutral-300 hover:border-white/25'
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
        <label className="block space-y-2">
          <span className="flex items-center justify-between gap-4 text-sm font-bold text-white">
            Preamp
            <output className="text-xs tabular-nums text-[var(--color-neon-yellow)]">
              {replayGainPreamp > 0 ? '+' : ''}{replayGainPreamp.toFixed(1)} dB
            </output>
          </span>
          <input
            type="range"
            min={-12}
            max={12}
            step={0.5}
            value={replayGainPreamp}
            disabled={replayGainMode === 'off'}
            onChange={(event) => onReplayGainPreampChange(Number(event.target.value))}
            className="w-full accent-[var(--color-neon-yellow)] disabled:opacity-40"
          />
        </label>
        <p className="text-[11px] text-[var(--color-ink-faint)]">
          Safe volume-domain normalization
          {capabilities.replay_gain_filter_available
            ? ' · rgvolume/rglimiter detected, but live graph mutation is intentionally avoided'
            : ' · rgvolume/rglimiter unavailable'}
        </p>
      </fieldset>
    )}
  </div>
));

function App() {
  const [externalTrack, setExternalTrack] = useState<any | null>(null);
  const [isMiniplayerMode, setIsMiniplayerMode] = useState(false);
  const previousWindowSize = useRef<{ width: number, height: number, x: number, y: number } | null>(null);
  const silentAudioRef = useRef<HTMLAudioElement | null>(null);

  const toggleMiniplayerMode = async () => {
    try {
      const appWindow = getCurrentWindow();
      if (!isMiniplayerMode) {
        // Switching TO miniplayer
        const size = await appWindow.outerSize();
        const position = await appWindow.outerPosition();
        const factor = await appWindow.scaleFactor();
        
        const logicalSize = size.toLogical(factor);
        const logicalPos = position.toLogical(factor);
        
        previousWindowSize.current = { 
          width: logicalSize.width, 
          height: logicalSize.height,
          x: logicalPos.x,
          y: logicalPos.y
        };
        
        // Order matters for some window managers
        await appWindow.setDecorations(false);
        await appWindow.setAlwaysOnTop(true);
        await appWindow.setSize(new LogicalSize(400, 150));
        setIsMiniplayerMode(true);
      } else {
        // Switching FROM miniplayer
        await appWindow.setDecorations(true);
        await appWindow.setAlwaysOnTop(false);
        if (previousWindowSize.current) {
          await appWindow.setSize(new LogicalSize(previousWindowSize.current.width, previousWindowSize.current.height));
          await appWindow.setPosition(new LogicalPosition(previousWindowSize.current.x, previousWindowSize.current.y));
        } else {
          // Fallback to a sane default size if no previous state
          await appWindow.setSize(new LogicalSize(1200, 800));
        }
        setIsMiniplayerMode(false);
      }
    } catch (e) {
      console.error("Failed to toggle miniplayer:", e);
      // Recover chrome if toggle failed mid-way
      try {
        const appWindow = getCurrentWindow();
        await appWindow.setDecorations(true);
        await appWindow.setAlwaysOnTop(false);
      } catch { /* ignore */ }
      setIsMiniplayerMode(false);
    }
  };

  // Recover if a previous session left the window borderless / tiny
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const appWindow = getCurrentWindow();
        await appWindow.setDecorations(true);
        await appWindow.setAlwaysOnTop(false);
        const size = await appWindow.outerSize();
        const factor = await appWindow.scaleFactor();
        const logical = size.toLogical(factor);
        // Stuck miniplayer size from a crashed session
        if (logical.height < 220 || logical.width < 480) {
          await appWindow.setSize(new LogicalSize(1200, 800));
        }
        if (!cancelled) setIsMiniplayerMode(false);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // References for global media keys
  const onTogglePlayRef = useRef<any>(null);
  const onNextRef = useRef<any>(null);
  const onPrevRef = useRef<any>(null);
  const seekPlaybackRef = useRef<(positionMs: number) => void>(() => {});

  const [showMobileLyrics, setShowMobileLyrics] = useState(false);
  const [videoMode, setVideoMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('nekobeat_video_mode');
    return saved ? JSON.parse(saved) : false;
  });

  const {
    tracks, isScanning, scanDirectory, importAudioFiles, scanDeviceMusic, refreshLibrary,
    clearLibrary, loadCachedTracks, reindexLibrary, patchTrack,
    settings: librarySettings, setMinFileSize, removeDirectory,
  } = useLibrary();
  const [runtimePlatform, setRuntimePlatform] = useState('');
  const [isMobileOs, setIsMobileOs] = useState(false);
  const [isAndroidOs, setIsAndroidOs] = useState(false);
  const usesNativeAndroidMediaSession = isAndroidOs || /Android/i.test(navigator.userAgent || '');
  const { results: searchResults, isLoading: isSearching, isLoadingMore, hasMore, search: performSearch, loadMore, sourceErrors, error: searchError } = useAggregatorSearch();
  const { likedTracks, isLiking, toggleLike } = useLikedLibrary();
  const playQueue = usePlayQueue();
  const playlistStore = usePlaylists();
  const [playlistTracks, setPlaylistTracks] = useState<TrackData[]>([]);
  const [playbackStateLoaded, setPlaybackStateLoaded] = useState(false);
  const restoredPositionRef = useRef(0);
  const restoredTrackRef = useRef<QueueTrack | null>(null);
  const prefetchedIdsRef = useRef<Set<string>>(new Set());
  const playRequestRef = useRef(0);
  const [queueDragFrom, setQueueDragFrom] = useState<number | null>(null);
  const [queueDragOver, setQueueDragOver] = useState<number | null>(null);

  useEffect(() => {
    if (!playQueue.showQueue) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') playQueue.setShowQueue(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playQueue.showQueue, playQueue.setShowQueue]);

  const handleNextTrackRef = useRef<(() => void) | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);

  // Infinite scroll: auto-load more when sentinel becomes visible
  useEffect(() => {
    const el = loadMoreSentinelRef.current;
    if (!el || !hasMore || isLoadingMore) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) loadMore(); },
      { rootMargin: '600px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [searchResults.length, hasMore, isLoadingMore]);

  // Audio player state and actions
  const {
    isPlaying,
    isBuffering,
    currentTrackPath,
    durationMs,
    volume,
    playTrack,
    streamExternalAudio,
    togglePause,
    pausePlayback,
    resumePlayback,
    seek,
    setVolume,
    playNext,
    playPrev
  } = useAudioPlayer(() => tracks, () => {
    if (handleNextTrackRef.current) handleNextTrackRef.current();
  }, likedTracks);

  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const pausePlaybackRef = useRef(pausePlayback);
  pausePlaybackRef.current = pausePlayback;
  seekPlaybackRef.current = (positionMs: number) => { void seek(positionMs); };

  const [coverArt, setCoverArt] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [lyricsOffsetMs, setLyricsOffsetMs] = useState(0);
  const [lyricsData, setLyricsData] = useState<LyricsData | null>(null);
  const [parsedLyrics, setParsedLyrics] = useState<{ timeMs: number, text: string }[]>([]);
  const [lyricsReadyFor, setLyricsReadyFor] = useState<string | null>(null);
  const [nowPlayingLyric, setNowPlayingLyric] = useState('');
  const [searchQuery, setSearchQuery] = useState("");
  const [searchSource, setSearchSource] = useState<'all' | 'youtube' | 'soundcloud' | 'spotify' | 'bandcamp' | 'vk' | 'yandex'>('all');
  const [activeSources, setActiveSources] = useState({
    youtube: true,
    soundcloud: true,
    spotify: true
  });
  const [activeTab, setActiveTab] = useState<'listen' | 'browse' | 'library' | 'settings' | 'liked'>('listen');
  const [recentPlays, setRecentPlays] = useState<RecentPlay[]>(loadRecentPlays);
  const [hifiReadyIds, setHifiReadyIds] = useState<Record<string, boolean>>({});
  const [browseNews, setBrowseNews] = useState<NewsTrack[]>([]);
  const [pendingAutoplayQuery, setPendingAutoplayQuery] = useState<string | null>(null);
  const [autoLoopLiked, setAutoLoopLiked] = useState<boolean>(() => {
    const saved = localStorage.getItem('nekobeat_auto_loop_liked');
    return saved ? JSON.parse(saved) : false;
  });
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    const saved = localStorage.getItem('nekobeat_view_mode');
    return (saved as 'grid' | 'list') || 'grid';
  });
  const [librarySubTab, setLibrarySubTab] = useState<LibrarySubTab>(() => loadLibrarySubTab());
  const [librarySort, setLibrarySort] = useState<LibrarySort>(() => loadLibrarySort());
  const [libraryFocus, setLibraryFocus] = useState<
    | null
    | { kind: 'artist'; name: string }
    | { kind: 'album'; name: string; artist: string }
    | { kind: 'genre'; name: string }
    | { kind: 'playlist'; id: number; name: string; isHistory: boolean }
  >(null);
  const [showAudioFormat, setShowAudioFormat] = useState(() => loadShowAudioFormat());
  const [notificationLyrics, setNotificationLyrics] = useState(() => loadNotificationLyrics());
  const [coverFallback, setCoverFallback] = useState(() => loadCoverFallback());
  const [lrcFromDirectory, setLrcFromDirectory] = useState(() => loadLrcFromDirectory());
  const [expandOnPlay, setExpandOnPlay] = useState(() => loadExpandOnPlay());
  const [lyricsAlign, setLyricsAlign] = useState<LyricsAlign>(() => loadLyricsAlign());
  const [refreshAtStartup, setRefreshAtStartup] = useState(() => loadRefreshAtStartup());
  const [playlistQueueMode, setPlaylistQueueMode] = useState<PlaylistQueueMode>(() => loadPlaylistQueueMode());
  const [playbackRestore, setPlaybackRestore] = useState(() => loadPlaybackRestore());
  const [windowsTaskbarProgress, setWindowsTaskbarProgress] = useState(() => loadWindowsTaskbarProgress());
  const [lyricsSize, setLyricsSize] = useState<LyricsSize>(() => loadLyricsSize());
  const [animationIntensity, setAnimationIntensity] = useState<AnimationIntensity>(() => loadAnimationIntensity());
  const [androidPermissions, setAndroidPermissions] = useState<AndroidPermissionStatus | null>(null);
  const [permissionRequesting, setPermissionRequesting] = useState<string | null>(null);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [streamError, setStreamError] = useState<{ message: string, trackTitle?: string, trackArtist?: string, source?: string, previewUrl?: string } | null>(null);
  const [updateCheckNonce, setUpdateCheckNonce] = useState(0);
  const [updateForce, setUpdateForce] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [updateChecking, setUpdateChecking] = useState(false);

  // Backfill album art for every library song missing a cover (not only visible cards).
  const coverFillAttemptedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!coverFallback || tracks.length === 0 || isScanning) return;
    const missing = tracks.filter(
      (t) =>
        t.filepath &&
        (!t.source || t.source === 'local') &&
        !isRealArtworkUrl(t.artwork_url) &&
        !coverFillAttemptedRef.current.has(t.filepath),
    );
    if (missing.length === 0) return;
    for (const t of missing) coverFillAttemptedRef.current.add(t.filepath);
    void fillMissingLibraryCovers(missing, (filepath, url) => {
      // Store durable path/url; UI converts via coverSrcForUi — never flash placeholders
      if (url && !isPlaceholderArt(url)) patchTrack(filepath, { artwork_url: url });
    });
  }, [tracks, isScanning, coverFallback, patchTrack]);
  const [updateUpToDate, setUpdateUpToDate] = useState(false);
  const [updateErr, setUpdateErr] = useState<string | undefined>();
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null);
  // Android is intentionally a private, local-library player. Desktop keeps online discovery.
  const androidOnlineEnabled = !isAndroidOs;

  useEffect(() => {
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then(setAppVersion)
      .catch(() => setAppVersion(""));
  }, []);

  useEffect(() => {
    localStorage.setItem('nekobeat_auto_loop_liked', JSON.stringify(autoLoopLiked));
  }, [autoLoopLiked]);

  useEffect(() => {
    localStorage.setItem('nekobeat_view_mode', viewMode);
  }, [viewMode]);
  useEffect(() => { saveLibrarySubTab(librarySubTab); }, [librarySubTab]);
  useEffect(() => { saveLibrarySort(librarySort); }, [librarySort]);
  useEffect(() => { saveShowAudioFormat(showAudioFormat); }, [showAudioFormat]);
  useEffect(() => { saveNotificationLyrics(notificationLyrics); }, [notificationLyrics]);
  useEffect(() => { saveCoverFallback(coverFallback); }, [coverFallback]);
  useEffect(() => { saveLrcFromDirectory(lrcFromDirectory); }, [lrcFromDirectory]);
  useEffect(() => { saveExpandOnPlay(expandOnPlay); }, [expandOnPlay]);
  useEffect(() => { saveLyricsAlign(lyricsAlign); }, [lyricsAlign]);
  useEffect(() => { saveRefreshAtStartup(refreshAtStartup); }, [refreshAtStartup]);
  useEffect(() => { savePlaylistQueueMode(playlistQueueMode); }, [playlistQueueMode]);
  useEffect(() => { savePlaybackRestore(playbackRestore); }, [playbackRestore]);
  useEffect(() => { saveWindowsTaskbarProgress(windowsTaskbarProgress); }, [windowsTaskbarProgress]);
  useEffect(() => { saveLyricsSize(lyricsSize); }, [lyricsSize]);
  useEffect(() => { saveAnimationIntensity(animationIntensity); }, [animationIntensity]);

  useEffect(() => {
    document.documentElement.dataset.animationIntensity = animationIntensity;
    return () => { delete document.documentElement.dataset.animationIntensity; };
  }, [animationIntensity]);

  useEffect(() => {
    if (!refreshAtStartup) return;
    void reindexLibrary().catch((error) => console.warn('Startup library refresh failed:', error));
  }, []); // startup preference is intentionally sampled once

  useEffect(() => {
    localStorage.setItem('nekobeat_video_mode', JSON.stringify(videoMode));
  }, [videoMode]);

  // Spotty HiFi ready toast/badge
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ id?: string }>('spotify-hifi-ready', (event) => {
      const id = event.payload?.id;
      if (id) setHifiReadyIds(prev => ({ ...prev, [id]: true }));
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Single music news fetch (Listen home + Browse idle strip) — regional Apple + global Last.fm
  const [browseNewsLoading, setBrowseNewsLoading] = useState(true);
  const [newsCountryPref, setNewsCountryPref] = useState(
    () => localStorage.getItem("nekobeat_news_country") || "auto"
  );
  const [newsCountry, setNewsCountry] = useState(() => resolveNewsCountry());

  const applyNewsCountryPref = useCallback((pref: string) => {
    if (pref === "auto") {
      localStorage.removeItem("nekobeat_news_country");
      setNewsCountryPref("auto");
      setNewsCountry(localeNewsCountry());
    } else {
      localStorage.setItem("nekobeat_news_country", pref);
      setNewsCountryPref(pref);
      setNewsCountry(pref);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setBrowseNewsLoading(true);
    invoke<NewsTrack[]>("get_music_news", { country: newsCountry })
      .then((data) => {
        if (!cancelled) {
          setBrowseNews(data);
          setBrowseNewsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setBrowseNewsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [newsCountry]);

  // Extract YouTube video ID from the current track (if applicable)
  const getYouTubeVideoId = (track: any): string | null => {
    if (!track) return null;
    if (track.source === 'youtube' && track.id) {
      return track.id.replace('yt-', '');
    }
    return null;
  };

  const currentTrack = tracks.find(t => t.filepath === currentTrackPath);

  // Prefer externalTrack for liked/search playback so library path collisions can't show the wrong title
  let playerTrack = externalTrack || currentTrack;
  const playerLikeKey = trackLikeKey(playerTrack, currentTrackPath);
  const playerIsLiked = !!(playerLikeKey && likedTracks.some((t) => t.id === playerLikeKey));
  const playerIsLiking = !!(playerLikeKey && isLiking[playerLikeKey]);
  const portablePlayback = usePortablePlaybackControls(playerTrack);
  // Single WebView-safe cover for mini / expanded / desktop chrome (desktop + Android)
  const uiCover = playerCoverSrc(playerTrack as any, coverArt);
  const coverSourcePath =
    (playerTrack as any)?.local_artwork_path ||
    (isLocalCoverPath(playerTrack?.artwork_url) ? playerTrack?.artwork_url : undefined) ||
    (isLocalCoverPath(coverArt) ? coverArt : undefined) ||
    undefined;

  // Persist recent plays + push current track into Continue row
  useEffect(() => {
    if (!playerTrack || !isPlaying) return;
    const likedHit = likedTracks.find((t) => t.id === (playerTrack.id || ''));
    const art =
      durableArtUrl(playerTrack.artwork_url) ||
      durableArtUrl(likedHit?.artwork_url) ||
      durableArtUrl(coverArt) ||
      // Keep converted local cover paths so Home Continues work offline after cache
      (playerTrack.artwork_url && /[/\\]covers[/\\]/i.test(playerTrack.artwork_url)
        ? playerTrack.artwork_url
        : '');
    const entry: RecentPlay = {
      id: playerTrack.id || playerTrack.filepath || '',
      title: playerTrack.title || 'Unknown',
      artist: playerTrack.artist || 'Unknown',
      artwork_url: art,
      source: resolveTrackSource(playerTrack.id || playerTrack.filepath, (playerTrack as any).source),
      stream_url: (playerTrack as any).stream_url,
      filepath: playerTrack.filepath,
    };
    if (!entry.id) return;
    setRecentPlays(prev => {
      const next = [entry, ...prev.filter(p => p.id !== entry.id)].slice(0, 12);
      localStorage.setItem('nekobeat_recent_plays', JSON.stringify(next));
      return next;
    });
  }, [playerTrack?.id, playerTrack?.filepath, playerTrack?.artwork_url, isPlaying, likedTracks, coverArt]);

  // Per-track lyrics offset persistence
  const handleLyricsOffsetChange = useCallback((offset: number) => {
    setLyricsOffsetMs(offset);
    const key = playerTrack?.id || playerTrack?.filepath || currentTrackPath;
    if (key) {
      try {
        const stored = JSON.parse(localStorage.getItem('nekobeat_lyrics_offsets') || '{}');
        stored[key] = offset;
        localStorage.setItem('nekobeat_lyrics_offsets', JSON.stringify(stored));
      } catch { }
    }
  }, [playerTrack?.id, playerTrack?.filepath, currentTrackPath]);

  // Sync active track to Discord Rich Presence
  useEffect(() => {
    const syncDiscord = async () => {
      if (!isPlaying || !playerTrack) {
        await invoke('clear_discord_activity').catch(() => { });
        return;
      }

      const payload = {
        title: stripExtension(playerTrack.title),
        artist: playerTrack.artist,
        durationMs: (playerTrack.duration_ms && playerTrack.duration_ms > 0) ? playerTrack.duration_ms : (durationMs || 0),
        artworkUrl: playerTrack.artwork_url || coverArt || null
      };

      await invoke('set_discord_activity', payload).catch(e => {
        console.warn("Discord RPC failed or not connected", e);
      });
    };

    syncDiscord();
  }, [isPlaying, playerTrack, durationMs]);

  // Cover fallback is handled by the multi-source fetchAlbumArt path below (iTunes → Deezer → Last.fm).

  // Trigger search when query or source changes (skip empty mount debounce)
  useEffect(() => {
    if (!searchQuery.trim()) return;
    const timer = setTimeout(() => {
      performSearch(searchQuery, searchSource);
    }, 500);
    return () => clearTimeout(timer);
  }, [searchQuery, searchSource]);

  // Auto-play first strong search hit when coming from Listen "Play"
  useEffect(() => {
    if (!pendingAutoplayQuery || isSearching || searchResults.length === 0) return;
    if (searchQuery.trim() !== pendingAutoplayQuery.trim()) return;
    // Prefer Spotify / YouTube over geo-snipped SoundCloud for Listen CTA
    const track =
      searchResults.find((t) => t.source === 'spotify') ||
      searchResults.find((t) => t.source === 'youtube') ||
      searchResults.find((t) => t.source === 'soundcloud' && !String(t.album || '').includes('SNIP')) ||
      searchResults[0];
    setPendingAutoplayQuery(null);
    const list: QueueTrack[] = searchResults.map((t) => ({
      ...t,
      stream_url: t.stream_url || (
        t.source === 'youtube' ? `https://www.youtube.com/watch?v=${t.id.replace('yt-', '')}` :
          t.source === 'soundcloud' ? `https://api-v2.soundcloud.com/tracks/${t.id.replace('sc-', '')}` :
            t.source === 'spotify' ? `https://open.spotify.com/track/${t.id.replace('sp-', '')}` :
              t.id
      ),
      playbackContext: 'search',
    }));
    playQueue.playFromList(list, track.id);
    const url = track.stream_url || (
      track.source === 'youtube' ? `https://www.youtube.com/watch?v=${track.id.replace('yt-', '')}` :
        track.source === 'soundcloud' ? `https://api-v2.soundcloud.com/tracks/${track.id.replace('sc-', '')}` :
          track.source === 'spotify' ? `https://open.spotify.com/track/${track.id.replace('sp-', '')}` :
            track.id
    );
    handleStreamExternalAudio({
      id: track.id,
      source: track.source,
      filepath: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album || track.source,
      duration_ms: track.duration_ms,
      artwork_url: track.artwork_url,
      stream_url: track.stream_url || url,
    }, 'search', { skipQueueRebuild: true });
    setCoverArt((prev) => nextPlayerCover(prev, track.artwork_url));
  }, [pendingAutoplayQuery, isSearching, searchResults, searchQuery]);

  // Surface GStreamer / stream errors in the existing toast
  useEffect(() => {
    const onErr = (ev: Event) => {
      const detail = (ev as CustomEvent<string>).detail;
      if (!detail) return;
      setStreamError({
        message: detail,
        trackTitle: externalTrack?.title,
        trackArtist: externalTrack?.artist,
        source: externalTrack?.source,
      });
      setTimeout(() => setStreamError(null), 10000);
    };
    window.addEventListener('nekobeat-audio-error', onErr);
    return () => window.removeEventListener('nekobeat-audio-error', onErr);
  }, [externalTrack?.title, externalTrack?.artist, externalTrack?.source]);

  // Parse LRC format
  const parseLrc = (lrc: string) => {
    const lines = lrc.split('\n');
    const result: { timeMs: number, text: string }[] = [];
    // Supports [m:ss], [mm:ss.xx], [mm:ss:xxx], multiple timestamps per line,
    // metadata tags, and [offset:+/-ms] (same practical set as mature LRC parsers).
    const timeReg = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    const offsetMatch = lrc.match(/\[offset:([+-]?\d+)\]/i);
    const fileOffsetMs = offsetMatch ? Number.parseInt(offsetMatch[1], 10) || 0 : 0;

    for (const rawLine of lines) {
      const timestamps = Array.from(rawLine.matchAll(timeReg));
      if (!timestamps.length) continue;
      const text = rawLine.replace(timeReg, '').trim();
      if (!text) continue;

      for (const match of timestamps) {
        const minutes = Number.parseInt(match[1], 10);
        const seconds = Number.parseInt(match[2], 10);
        if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds > 59) continue;
        const fraction = match[3] || '';
        const milliseconds =
          fraction.length === 1 ? Number.parseInt(fraction, 10) * 100 :
          fraction.length === 2 ? Number.parseInt(fraction, 10) * 10 :
          fraction.length === 3 ? Number.parseInt(fraction, 10) : 0;
        const timeMs = Math.max(0, minutes * 60_000 + seconds * 1000 + milliseconds + fileOffsetMs);
        result.push({ timeMs, text });
      }
    }

    result.sort((a, b) => a.timeMs - b.timeMs);
    return result.filter((line, index) =>
      index === 0 ||
      line.timeMs !== result[index - 1].timeMs ||
      line.text !== result[index - 1].text
    );
  };

  // Helper to get playback URL for an external track
  const getTrackPlaybackUrl = (track: any) => {
    return track.stream_url || (
      track.source === 'youtube' ? `https://www.youtube.com/watch?v=${track.id.replace('yt-', '')}` :
        track.source === 'soundcloud' ? `https://api-v2.soundcloud.com/tracks/${track.id.replace('sc-', '')}` :
          track.source === 'spotify' ? `https://open.spotify.com/track/${track.id.replace('sp-', '')}` :
            track.id
    );
  };

  const toExternalQueueTrack = (
    track: AggregatedTrack,
    context: 'search' | 'liked',
  ): QueueTrack => ({
    ...track,
    stream_url: getTrackPlaybackUrl(track),
    playbackContext: context,
  });

  /** Warm yt-dlp / SC disk cache for upcoming queue tracks while current song plays. */
  const prefetchUpNext = useCallback((count = 2) => {
    const loop =
      autoLoopLiked &&
      (externalTrack?.playbackContext === 'liked' || playQueue.current?.playbackContext === 'liked');
    const upcoming = playQueue.getUpcoming(!!loop).slice(0, count).map((r) => r.track);
    for (const t of upcoming) {
      const id = t.id || getTrackPlaybackUrl(t);
      if (!id || prefetchedIdsRef.current.has(id)) continue;
      // Skip pure local files
      if (t.local_audio_path) continue;
      prefetchedIdsRef.current.add(id);
      const url = getTrackPlaybackUrl(t);
      if (!url || url.startsWith('file:') || (!url.includes('http') && !url.includes('spotify') && !url.includes('youtube') && !url.includes('soundcloud'))) {
        continue;
      }
      console.log('Prefetch next:', t.title, url);
      invoke('prefetch_external_audio', {
        url,
        title: t.title || null,
        artist: t.artist || null,
        durationMs: t.duration_ms && t.duration_ms > 0 ? Math.floor(t.duration_ms) : null,
      }).catch((e) => {
        console.warn('Prefetch failed:', t.title, e);
        prefetchedIdsRef.current.delete(id);
      });
    }
  }, [playQueue.getUpcoming, playQueue.current, autoLoopLiked, externalTrack?.playbackContext]);

  // After play starts, prefetch next 1–2 so Skip is instant (cache hit)
  useEffect(() => {
    if (!isPlaying || !externalTrack?.id) return;
    const t = window.setTimeout(() => prefetchUpNext(2), 800);
    return () => clearTimeout(t);
  }, [isPlaying, externalTrack?.id, playQueue.currentIndex, prefetchUpNext]);

  const handleStreamExternalAudio = async (
    track: any,
    context: 'search' | 'liked' = 'search',
    opts?: { skipQueueRebuild?: boolean; resumePositionMs?: number },
  ) => {
    if (!opts?.resumePositionMs) {
      restoredTrackRef.current = null;
      restoredPositionRef.current = 0;
    }
    const requestId = ++playRequestRef.current;

    // Build / refresh play queue from current context
    if (!opts?.skipQueueRebuild) {
      if (context === 'liked' && likedTracks.length > 0) {
        const list: QueueTrack[] = likedTracks.map((t: any) => ({
          id: t.id,
          title: t.title,
          artist: t.artist,
          album: t.album || '',
          duration_ms: t.duration_ms || 0,
          artwork_url: coverSrcForUi(t.artwork_url, t.local_artwork_path) || t.artwork_url || '',
          source: t.source || 'external',
          stream_url: getTrackPlaybackUrl(t),
          local_audio_path: t.local_audio_path,
          local_artwork_path: t.local_artwork_path,
          local_lyrics: t.local_lyrics,
          playbackContext: 'liked',
        }));
        playQueue.playFromList(list, track.id);
      } else if (searchResults.length > 0) {
        const list: QueueTrack[] = searchResults.map((t) => ({
          ...t,
          stream_url: getTrackPlaybackUrl(t),
          playbackContext: 'search',
        }));
        playQueue.playFromList(list, track.id);
      } else {
        playQueue.replaceQueue([{
          id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album || '',
          duration_ms: track.duration_ms || 0,
          artwork_url: track.artwork_url || '',
          source: track.source || 'external',
          stream_url: getTrackPlaybackUrl(track),
          playbackContext: context,
        }], 0);
      }
    }

    // Set UI metadata immediately so the player shows the clicked song
    const likedMeta = context === 'liked' && track.id
      ? likedTracks.find((t) => t.id === track.id)
      : undefined;
    const displayArt =
      coverSrcForUi(
        track.artwork_url || likedMeta?.artwork_url,
        (track.artwork_url || likedMeta?.artwork_url || '').startsWith('http')
          ? undefined
          : (track.local_artwork_path || likedMeta?.local_artwork_path),
      ) || placeholderArt(track.title);
    const baseMeta = {
      ...track,
      title: track.title || 'Unknown Title',
      artist: track.artist || 'Unknown Artist',
      artwork_url: displayArt,
      album: track.album || '',
      duration_ms: track.duration_ms || 0,
      source: track.source || 'external',
      playbackContext: context,
      local_lyrics: track.local_lyrics || likedMeta?.local_lyrics,
      local_artwork_path: track.local_artwork_path || likedMeta?.local_artwork_path,
      local_audio_path: track.local_audio_path || likedMeta?.local_audio_path,
    };

    // For liked tracks, check if we have a local download first
    let localPath = track.local_audio_path;
    
    // If no local_audio_path in metadata, check disk cache
    if (context === 'liked' && !localPath && track.id) {
      try {
        const cached = await invoke<string | null>('check_liked_cache', { trackId: track.id });
        if (requestId !== playRequestRef.current) return;
        if (cached) {
          localPath = cached;
          console.log("Offline: Found cached file on disk:", cached);
        }
      } catch (e) {
        console.error("Failed to check liked cache:", e);
      }
    }

    if (requestId !== playRequestRef.current) return;

    // Prefer local liked file whenever we have one (offline / instant).
    // Missing or broken files fall through to resolve with title+artist.
    if (context === 'liked' && localPath) {
      setExternalTrack({
        ...baseMeta,
        stream_url: localPath,
        local_audio_path: localPath,
      });
      setCoverArt((prev) => {
        if (displayArt && !isPlaceholderArt(displayArt)) {
          return pickStableCover(prev, displayArt) || displayArt;
        }
        return prev;
      });
      try {
        await playTrack(localPath, track.id);
        if (requestId !== playRequestRef.current) return;
        if (opts?.resumePositionMs && opts.resumePositionMs > 0) {
          await seek(opts.resumePositionMs);
        }
        setStreamError(null);
        return;
      } catch (e) {
        console.error("Failed to play local liked track, falling back to stream:", e);
        if (requestId !== playRequestRef.current) return;
        if (isAndroidOs && !androidOnlineEnabled) {
          setStreamError({
            message:
              'That offline file is missing. Re-scan Library, or enable Android online playback in Settings when all device checks pass.',
            trackTitle: track.title,
            trackArtist: track.artist,
            source: track.source,
          });
          setTimeout(() => setStreamError(null), 10000);
          return;
        }
        setStreamError({
          message: `Offline file missing for "${track.title}". Re-download from Liked or stream again.`,
          trackTitle: track.title,
          trackArtist: track.artist,
          source: track.source,
        });
      }
    }

    // Android online resolve is allowed only after local capability checks and explicit opt-in.
    if (isAndroidOs && !androidOnlineEnabled) {
      setStreamError({
        message:
          'Android online playback is off. Open Settings to review device checks; Library playback remains available.',
        trackTitle: track.title,
        trackArtist: track.artist,
        source: track.source,
      });
      setTimeout(() => setStreamError(null), 10000);
      return;
    }

    // Reconstruct a proper source URL from the track ID if stream_url is missing or stale
    let playbackUrl = track.stream_url || track.id;
    if (context === 'liked' || !playbackUrl.startsWith('http')) {
      const id = track.id || '';
      if (track.source === 'youtube' || id.startsWith('yt-')) {
        playbackUrl = `https://www.youtube.com/watch?v=${id.replace('yt-', '')}`;
      } else if (track.source === 'soundcloud' || id.startsWith('sc-')) {
        playbackUrl = `https://api-v2.soundcloud.com/tracks/${id.replace('sc-', '')}`;
      } else if (track.source === 'spotify' || id.startsWith('sp-')) {
        playbackUrl = `https://open.spotify.com/track/${id.replace('sp-', '')}`;
      }
    }
    if (requestId !== playRequestRef.current) return;
    setExternalTrack({
      ...baseMeta,
      stream_url: playbackUrl,
    });
    setCoverArt((prev) => {
      if (displayArt && !isPlaceholderArt(displayArt)) {
        return pickStableCover(prev, displayArt) || displayArt;
      }
      return prev;
    });
    const resolvedUrl = await streamExternalAudio(
      playbackUrl,
      track.source,
      track.id,
      track.title,
      track.artist,
      track.duration_ms,
    );
    if (requestId !== playRequestRef.current) return;
    if (resolvedUrl) {
      if (requestId !== playRequestRef.current) return;
      if (opts?.resumePositionMs && opts.resumePositionMs > 0) {
        await seek(opts.resumePositionMs);
      }
      const isPreview = resolvedUrl.startsWith('PREVIEW:');
      const actualUrl = isPreview ? resolvedUrl.replace('PREVIEW:', '') : resolvedUrl;
      setExternalTrack((prev: any) => {
        if (requestId !== playRequestRef.current) return prev;
        return prev ? { ...prev, stream_url: actualUrl } : null;
      });
      
      if (isPreview) {
        const trackTitle = track.title || 'Unknown Track';
        const trackArtist = track.artist || 'Unknown Artist';
        seedAudioClockDuration(30_000);
        setStreamError({
          message: `"${trackTitle}" is blocked on SoundCloud — only a 30-second preview is available.`,
          trackTitle,
          trackArtist,
          source: track.source,
          previewUrl: actualUrl
        });
        setTimeout(() => setStreamError(null), 15000);
      } else if (
        track.source === 'soundcloud' &&
        (actualUrl.includes('yt_audio') || actualUrl.includes('youtube') ||
          (actualUrl.startsWith('file:') && !actualUrl.includes('sc_audio')))
      ) {
        setStreamError({
          message: `SoundCloud restricted "${track.title}". Playing the full track via YouTube.`,
          trackTitle: track.title,
          trackArtist: track.artist,
          source: 'youtube',
        });
        setTimeout(() => setStreamError(null), 8000);
      } else {
        setStreamError(null);
      }
      // Kick prefetch as soon as current resolve finished (don't wait for isPlaying)
      window.setTimeout(() => prefetchUpNext(2), 400);
    } else {
      // Stream completely failed
      const trackTitle = track.title || 'Unknown Track';
      const trackArtist = track.artist || 'Unknown Artist';
      setStreamError({
        message: track.source === 'soundcloud' 
          ? `"${trackTitle}" could not be played from SoundCloud (or YouTube fallback).`
          : track.source === 'spotify'
            ? `Failed to play "${trackTitle}". Trying YouTube match failed — check network, or play a YouTube result instead.`
            : `Failed to stream "${trackTitle}". Check network and try again.`,
        trackTitle,
        trackArtist,
        source: track.source
      });
      setTimeout(() => setStreamError(null), 12000);
    }
  };

  // Clear externalTrack when playing a local track
  const handlePlayLocalTrack = async (
    filepath: string,
    opts?: { rebuildQueue?: boolean; resumePositionMs?: number },
  ) => {
    if (!opts?.resumePositionMs) {
      restoredTrackRef.current = null;
      restoredPositionRef.current = 0;
    }
    const requestId = ++playRequestRef.current;
    setExternalTrack(null);
    if (opts?.rebuildQueue !== false && tracks.length > 0) {
      const list = tracksToQueue(tracks);
      playQueue.playFromList(list, filepath);
    }
    const libTrack = tracks.find((t) => t.filepath === filepath);
    if (libTrack) {
      setCoverArt((prev) => nextPlayerCover(prev, libTrack.artwork_url));
    }
    // Always try to fill cover when the user plays a song that still has the logo placeholder
    if (coverFallback && libTrack && !isRealArtworkUrl(libTrack.artwork_url)) {
      void ensureTrackCoverArt(libTrack, (url, stored) => {
        if (url) setCoverArt((prev) => pickStableCover(prev, url) || url);
        if (stored) patchTrack(filepath, { artwork_url: stored });
      });
    }
    try {
      await playTrack(filepath);
      if (requestId !== playRequestRef.current) return;
      if (opts?.resumePositionMs && opts.resumePositionMs > 0) {
        await seek(opts.resumePositionMs);
      }
      setStreamError(null);
      void invoke('append_history', { filepath })
        .then(() => playlistStore.refresh())
        .catch((error) => console.warn('History update failed:', error));
    } catch (e) {
      if (requestId !== playRequestRef.current) return;
      const msg = String(e).replace(/^Error:\s*/i, '');
      setStreamError({
        message: msg.includes('content:')
          ? 'Could not play local file — re-import with Add songs, or Scan device music.'
          : (msg || 'Could not play local file. Check it still exists and audio permission is granted.'),
      });
      setTimeout(() => setStreamError(null), 10000);
    }
  };

  const handlePlayLibraryAll = (shuffle = false) => {
    handlePlayTrackList(tracks, shuffle);
  };

  const handlePlayTrackList = (list: TrackData[], shuffle = false, startPath?: string) => {
    if (!list.length) return;
    let queue = tracksToQueue(list);
    if (shuffle) {
      queue = [...queue].sort(() => Math.random() - 0.5);
    }
    let idx = 0;
    if (startPath) {
      const found = queue.findIndex((t) => t.id === startPath);
      idx = found >= 0 ? found : 0;
    }
    if (playlistQueueMode === 'append' && playQueue.queue.length > 0) {
      playQueue.appendQueue(queue);
      return;
    }
    playQueue.replaceQueue(queue, idx, { shuffle });
    void handlePlayLocalTrack(queue[idx].id, { rebuildQueue: false });
  };

  const openPlaylist = async (playlist: { id: number; name: string; is_history: boolean }) => {
    const rows = await playlistStore.getTracks(playlist.id);
    setPlaylistTracks(rows);
    setLibraryFocus({ kind: 'playlist', id: playlist.id, name: playlist.name, isHistory: playlist.is_history });
  };

  const removePlaylistTrack = async (playlistId: number, filepath: string) => {
    await playlistStore.removeTrack(playlistId, filepath);
    setPlaylistTracks(await playlistStore.getTracks(playlistId));
  };

  const openArtistPage = (artist: string) => {
    const name = (artist || '').trim();
    if (!name) return;
    const localHits = findArtistTracks(tracks, name);
    if (localHits.length > 0) {
      setLibraryFocus({ kind: 'artist', name: localHits[0].artist || name });
      setLibrarySubTab('artists');
      setActiveTab('library');
      setIsExpanded(false);
      return;
    }
    if (androidOnlineEnabled) {
      setPendingAutoplayQuery(null);
      setSearchQuery(name);
      setSearchSource('all');
      setActiveTab('browse');
      setIsExpanded(false);
      return;
    }
    setActiveTab('library');
    setIsExpanded(false);
  };

  const openAlbumPage = (album: string, artist: string) => {
    const a = (album || '').trim();
    const ar = (artist || '').trim();
    if (!a) return;
    const hits = findAlbumTracks(tracks, a, ar);
    if (hits.length > 0) {
      setLibraryFocus({ kind: 'album', name: hits[0].album || a, artist: hits[0].artist || ar });
      setLibrarySubTab('albums');
      setActiveTab('library');
      setIsExpanded(false);
    }
  };

  // Unified next/prev — prefer explicit play queue (local Play All uses file paths)
  const handleNextTrack = () => {
    const next = playQueue.advance(autoLoopLiked && externalTrack?.playbackContext === 'liked');
    if (next) {
      if (isLocalQueueTrack(next)) {
        void handlePlayLocalTrack(next.stream_url || next.id, { rebuildQueue: false });
        setCoverArt((prev) => nextPlayerCover(prev, next.artwork_url, (next as any).local_artwork_path));
        return;
      }
      handleStreamExternalAudio(
        { ...next, stream_url: next.stream_url || getTrackPlaybackUrl(next) },
        next.playbackContext === 'liked' ? 'liked' : 'search',
        { skipQueueRebuild: true },
      );
      setCoverArt((prev) => nextPlayerCover(prev, next.artwork_url, (next as any).local_artwork_path));
      return;
    }
    if (externalTrack) {
      const isLikedContext = externalTrack.playbackContext === 'liked';
      const playlist = isLikedContext ? likedTracks : searchResults;
      
      if (playlist.length > 0) {
        const currentIdx = playlist.findIndex((t: any) => t.id === externalTrack.id);
        const nextIdx = currentIdx + 1;
        if (nextIdx < playlist.length) {
          const n: any = playlist[nextIdx];
          handleStreamExternalAudio({...n, stream_url: getTrackPlaybackUrl(n)}, externalTrack.playbackContext);
          setCoverArt((prev) => nextPlayerCover(prev, n.artwork_url, n.local_artwork_path));
        } else if (autoLoopLiked && isLikedContext && playlist.length > 1) {
          const first: any = playlist[0];
          handleStreamExternalAudio({...first, stream_url: getTrackPlaybackUrl(first)}, 'liked');
          setCoverArt((prev) => nextPlayerCover(prev, first.artwork_url, first.local_artwork_path));
        }
      } else {
        playNext(tracks);
      }
    } else {
      playNext(tracks);
    }
  };

  useEffect(() => {
    handleNextTrackRef.current = handleNextTrack;
  });

  const handlePrevTrack = () => {
    const prev = playQueue.retreat();
    if (prev) {
      if (isLocalQueueTrack(prev)) {
        void handlePlayLocalTrack(prev.stream_url || prev.id, { rebuildQueue: false });
        setCoverArt((p) => nextPlayerCover(p, prev.artwork_url, (prev as any).local_artwork_path));
        return;
      }
      handleStreamExternalAudio(
        { ...prev, stream_url: prev.stream_url || getTrackPlaybackUrl(prev) },
        prev.playbackContext === 'liked' ? 'liked' : 'search',
        { skipQueueRebuild: true },
      );
      setCoverArt((p) => nextPlayerCover(p, prev.artwork_url, (prev as any).local_artwork_path));
      return;
    }
    if (externalTrack) {
      const isLikedContext = externalTrack.playbackContext === 'liked';
      const playlist = isLikedContext ? likedTracks : searchResults;
      
      if (playlist.length > 0) {
        const currentIdx = playlist.findIndex((t: any) => t.id === externalTrack.id);
        const prevIdx = currentIdx - 1;
        if (prevIdx >= 0) {
          const p: any = playlist[prevIdx];
          handleStreamExternalAudio({...p, stream_url: getTrackPlaybackUrl(p)}, externalTrack.playbackContext);
          setCoverArt((cur) => nextPlayerCover(cur, p.artwork_url, p.local_artwork_path));
        }
      } else {
        playPrev(tracks);
      }
    } else {
      playPrev(tracks);
    }
  };

  const resumeRestoredTrack = async () => {
    const track = restoredTrackRef.current;
    if (!track) {
      await resumePlayback();
      return;
    }
    const positionMs = restoredPositionRef.current;
    restoredTrackRef.current = null;
    restoredPositionRef.current = 0;
    if (isLocalQueueTrack(track)) {
      await handlePlayLocalTrack(track.stream_url || track.id, {
        rebuildQueue: false,
        resumePositionMs: positionMs,
      });
    } else {
      await handleStreamExternalAudio(
        { ...track, stream_url: track.stream_url || getTrackPlaybackUrl(track) },
        track.playbackContext === 'liked' ? 'liked' : 'search',
        { skipQueueRebuild: true, resumePositionMs: positionMs },
      );
    }
  };

  const handleTogglePlayback = () => {
    if (!isPlayingRef.current && restoredTrackRef.current) {
      void resumeRestoredTrack();
      return;
    }
    void togglePause();
  };

  onNextRef.current = handleNextTrack;
  onPrevRef.current = handlePrevTrack;
  onTogglePlayRef.current = handleTogglePlayback;

  // Native Android MediaSession actions arrive through MainActivity's durable WebView bridge.
  // Every action is explicit so a duplicated platform callback cannot invert play/pause state.
  useEffect(() => {
    if (!isAndroidOs) return;
    const nativeWindow = window as any;
    const handleNativeMediaAction = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: string; positionMs?: number }>).detail;
      switch (detail?.action) {
        case 'play':
          if (!isPlayingRef.current) onTogglePlayRef.current?.();
          break;
        case 'pause':
        case 'stop':
          if (isPlayingRef.current && !isResumeGuarded()) pausePlaybackRef.current();
          break;
        case 'previous':
          onPrevRef.current?.();
          break;
        case 'next':
        case 'ended':
          onNextRef.current?.();
          break;
        case 'seek_to':
          if (typeof detail.positionMs === 'number') {
            const duration = getAudioClock().durationMs;
            const target = Math.max(0, detail.positionMs);
            seekPlaybackRef.current(duration > 0 ? Math.min(target, duration) : target);
          }
          break;
      }
    };

    window.addEventListener('nekobeat-native-media-action', handleNativeMediaAction);
    nativeWindow.__nekobeatNativeMediaReady = true;
    const queued = Array.isArray(nativeWindow.__nekobeatNativeMediaQueue)
      ? nativeWindow.__nekobeatNativeMediaQueue.splice(0)
      : [];
    queued.forEach((detail: unknown) => {
      handleNativeMediaAction(new CustomEvent('nekobeat-native-media-action', { detail }));
    });

    return () => {
      nativeWindow.__nekobeatNativeMediaReady = false;
      window.removeEventListener('nekobeat-native-media-action', handleNativeMediaAction);
    };
  }, [isAndroidOs]);

  // Hydrate queue metadata without starting audio. The first explicit Play resumes it.
  useEffect(() => {
    if (!playbackRestore) {
      setPlaybackStateLoaded(true);
      return;
    }
    let cancelled = false;
    invoke<PersistedPlaybackState>('load_playback_state')
      .then((state) => {
        if (cancelled) return;
        const queue = Array.isArray(state.queue) ? state.queue : [];
        playQueue.restoreQueue(queue, state.currentIndex, state.shuffleEnabled);
        setAutoLoopLiked(!!state.loopEnabled);
        const restored = state.currentTrack || queue[state.currentIndex] || null;
        if (restored) {
          restoredTrackRef.current = restored;
          restoredPositionRef.current = Math.max(0, state.positionMs || 0);
          setExternalTrack({
            ...restored,
            filepath: restored.id,
            playbackContext: restored.playbackContext || 'queue',
          });
          setCoverArt((prev) =>
            nextPlayerCover(prev, restored.artwork_url, (restored as any).local_artwork_path),
          );
          seedAudioClockDuration(restored.duration_ms || 0);
        }
      })
      .catch((error) => console.warn('Playback state restore failed:', error))
      .finally(() => {
        if (!cancelled) setPlaybackStateLoaded(true);
      });
    return () => { cancelled = true; };
  }, []); // restore exactly once

  const persistPlaybackState = useCallback(() => {
    if (!playbackStateLoaded || !playbackRestore) return;
    const current = playQueue.current || (playerTrack as QueueTrack | null);
    const state: PersistedPlaybackState = {
      version: 1,
      queue: playQueue.queue,
      currentIndex: playQueue.currentIndex,
      loopEnabled: autoLoopLiked,
      shuffleEnabled: playQueue.shuffleEnabled,
      currentTrack: current || null,
      positionMs: Math.max(0, Math.floor(getAudioClock().positionMs)),
    };
    invoke('save_playback_state', { state }).catch((error) => {
      console.warn('Playback state save failed:', error);
    });
  }, [
    playbackStateLoaded,
    playbackRestore,
    playQueue.queue,
    playQueue.currentIndex,
    playQueue.current,
    playQueue.shuffleEnabled,
    autoLoopLiked,
    playerTrack?.id,
    playerTrack?.filepath,
  ]);

  // Debounce structural changes and checkpoint the playback clock every five seconds.
  useEffect(() => {
    if (!playbackStateLoaded) return;
    const timeout = window.setTimeout(persistPlaybackState, 750);
    const interval = window.setInterval(persistPlaybackState, 5000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [playbackStateLoaded, persistPlaybackState]);

  const handleUploadLyrics = async () => {
    if (!playerTrack) return;
    try {
      const selected = await open({
        multiple: false,
        filters: [{
          name: 'Lyrics',
          extensions: ['lrc', 'srt', 'vtt', 'txt']
        }]
      });

      if (selected && typeof selected === 'string') {
        const content = await invoke<string>('read_text_file', { path: selected });
        
        // Update backend
        await invoke('update_track_lyrics', { 
            trackId: playerTrack.id || '', 
            filepath: playerTrack.filepath || null,
            lyrics: content 
        });
        
        // Process for immediate UI update
        let finalLyrics = content;
        if (content.includes('-->')) {
           finalLyrics = await invoke<string>('convert_srt_vtt_to_lrc', { content });
        }
        
        const isSynced = finalLyrics.trim().startsWith('[');
        if (isSynced) {
            setParsedLyrics(parseLrc(finalLyrics));
            setLyricsData({ syncedLyrics: finalLyrics });
        } else {
            setParsedLyrics([]);
            setLyricsData({ plainLyrics: finalLyrics });
        }
        
        // Update the current playerTrack object in memory so it reflects the change if we re-render
        if (playerTrack) {
           (playerTrack as any).local_lyrics = finalLyrics;
        }
      }
    } catch (e) {
      console.error("Failed to upload lyrics:", e);
    }
  };

  useEffect(() => {
    let stale = false;
    if (playerTrack) {
      const trackKey = playerTrack.id || playerTrack.filepath || currentTrackPath || null;
      setLyricsReadyFor(null);

      const localArt = (playerTrack as any).local_artwork_path as string | undefined;
      const remoteArt = playerTrack.artwork_url;
      const displayArt = coverSrcForUi(remoteArt, localArt);
      const hasArt = !!(displayArt && (
        isRealArtworkUrl(remoteArt) ||
        isRealArtworkUrl(localArt) ||
        (isRealArtworkUrl(displayArt) && !isPlaceholderArt(displayArt))
      ));

      // Never flash logo while a fetch is in flight — only upgrade covers, never thrash.
      setCoverArt((prev) => {
        if (hasArt && displayArt) {
          return pickStableCover(prev, displayArt) || displayArt;
        }
        if (prev && isRealArtworkUrl(prev) && !isPlaceholderArt(prev)) return prev;
        return prev;
      });

      // Local FS covers work in Media3 as file:// but often fail in WebView —
      // resolve to data: URLs so in-app art matches lock screen / notification.
      void resolveCoverForWebView(remoteArt, localArt).then((url) => {
        if (stale || !url) return;
        setCoverArt((prev) => pickStableCover(prev, url) || url);
      });

      // Online cover lookup when nothing usable is on the track yet
      if (!hasArt && coverFallback) {
        void ensureTrackCoverArt(
          {
            title: playerTrack.title,
            artist: playerTrack.artist,
            album: playerTrack.album,
            artwork_url: playerTrack.artwork_url,
            filepath: playerTrack.filepath || currentTrackPath || undefined,
          },
          (url, stored) => {
            if (stale || !url) return;
            setCoverArt((prev) => pickStableCover(prev, url) || url);
            const fp = playerTrack.filepath || currentTrackPath;
            if (fp && stored && (!playerTrack.source || playerTrack.source === 'local')) {
              patchTrack(fp, { artwork_url: stored });
            }
          },
        );
      }

      // Seed progress duration from metadata so the thumb can move before the engine reports length
      if (playerTrack.duration_ms && playerTrack.duration_ms > 0) {
        seedAudioClockDuration(playerTrack.duration_ms);
      } else if (durationMs > 0) {
        seedAudioClockDuration(durationMs);
      }

      // Prefer synced local lyrics immediately; plain text still allows an online synced fetch
      const localLyrics = playerTrack.local_lyrics as string | undefined;
      const localIsSynced = !!(localLyrics && localLyrics.trim().startsWith('['));
      if (localIsSynced && localLyrics) {
        setParsedLyrics(parseLrc(localLyrics));
        setLyricsData({ syncedLyrics: localLyrics, source: 'local' });
        setLyricsReadyFor(trackKey);
        // Keep a durable on-disk copy for offline reopen
        const seedKey =
          (playerTrack as any).id ||
          playerTrack.filepath ||
          currentTrackPath ||
          `${playerTrack.title}|${playerTrack.artist}`;
        if (seedKey) {
          invoke('save_lyrics_cache', { cacheKey: seedKey, lyrics: localLyrics }).catch(() => {});
        }
      } else if (localLyrics && !localIsSynced) {
        setParsedLyrics([]);
        setLyricsData({ plainLyrics: localLyrics, source: 'local' });
        setLyricsReadyFor(trackKey);
      } else {
        setLyricsData(null);
        setParsedLyrics([]);
        setLyricsReadyFor(null);
      }

      let savedOffset = 0;
      if (trackKey) {
        try {
          const stored = JSON.parse(localStorage.getItem('nekobeat_lyrics_offsets') || '{}');
          if (typeof stored[trackKey] === 'number') savedOffset = stored[trackKey];
        } catch { }
      }
      setLyricsOffsetMs(savedOffset);

      // Always resolve when missing synced lyrics (cache → sidecar → online)
      if (!localIsSynced) {
        let spotifyId = undefined;
        if (playerTrack.source === 'spotify' || (playerTrack as any).id?.startsWith('sp-')) {
          let rawId = String((playerTrack as any).id || '').replace('sp-', '');
          const match = rawId.match(/track\/([a-zA-Z0-9]+)/);
          if (match) {
            spotifyId = match[1];
          } else {
            spotifyId = rawId || undefined;
          }
        }

        const isLocal = !playerTrack.source || playerTrack.source === 'local';
        const fp = isLocal ? (playerTrack.filepath || currentTrackPath || null) : null;
        const cacheKey =
          (playerTrack as any).id ||
          playerTrack.filepath ||
          (playerTrack as any).stream_url ||
          currentTrackPath ||
          `${playerTrack.title}|${playerTrack.artist}`;

        fetchLyrics(
          playerTrack.title,
          playerTrack.artist,
          playerTrack.album || '',
          durationMs || playerTrack.duration_ms || 0,
          spotifyId,
          {
            cacheKey,
            filepath: fp,
            readSidecar: isLocal ? lrcFromDirectory : false,
          },
        ).then(data => {
          if (stale) return;
          if (!data) return;
          // Prefer synced; keep existing plain if online only returns empty
          if (data.syncedLyrics) {
            setLyricsData(data);
            setParsedLyrics(parseLrc(data.syncedLyrics));
            setLyricsReadyFor(trackKey);
          } else if (data.plainLyrics && !localLyrics) {
            setLyricsData(data);
            setParsedLyrics([]);
            setLyricsReadyFor(trackKey);
          }
          const text = data.syncedLyrics || data.plainLyrics;
          if (!text) return;
          if (fp) {
            patchTrack(fp, { local_lyrics: text });
            invoke('update_track_lyrics', {
              trackId: fp,
              filepath: fp,
              lyrics: text,
            }).catch(() => { /* non-fatal — cache already written in Rust */ });
          } else if ((playerTrack as any).playbackContext === 'liked' || likedTracks.some(t => t.id === playerTrack.id)) {
            invoke('update_track_lyrics', {
              trackId: playerTrack.id,
              filepath: null,
              lyrics: text,
            }).catch(() => { /* non-fatal */ });
          } else {
            // Browse / stream: ensure hash cache via explicit save (Rust get_lyrics already wrote)
            invoke('save_lyrics_cache', { cacheKey, lyrics: text }).catch(() => {});
          }
        });
      }
    } else {
      setCoverArt(null);
      setLyricsData(null);
      setParsedLyrics([]);
      setLyricsReadyFor(null);
    }
    return () => { stale = true; };
  }, [playerTrack?.id, playerTrack?.filepath, currentTrackPath, patchTrack, lrcFromDirectory, coverFallback]);

  // MediaSession action handlers — bind once; always call latest via refs.
  // Critical: MediaPlayPause also hits the global shortcut; resume guard + explicit
  // play/pause (never toggle) prevents Resume→immediate Pause.
  useEffect(() => {
    if (usesNativeAndroidMediaSession || !('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play', () => {
      if (!isPlayingRef.current) onTogglePlayRef.current?.();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      if (isResumeGuarded()) return;
      if (isPlayingRef.current) pausePlaybackRef.current();
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      onPrevRef.current?.();
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      onNextRef.current?.();
    });
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime !== 'number') return;
      const duration = getAudioClock().durationMs;
      const target = details.seekTime * 1000;
      seekPlaybackRef.current(duration > 0 ? Math.min(target, duration) : target);
    });
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      const clock = getAudioClock();
      const target = clock.positionMs + (details.seekOffset ?? 10) * 1000;
      seekPlaybackRef.current(clock.durationMs > 0 ? Math.min(target, clock.durationMs) : target);
    });
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      const target = getAudioClock().positionMs - (details.seekOffset ?? 10) * 1000;
      seekPlaybackRef.current(Math.max(0, target));
    });
    return () => {
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
      navigator.mediaSession.setActionHandler('previoustrack', null);
      navigator.mediaSession.setActionHandler('nexttrack', null);
      navigator.mediaSession.setActionHandler('seekto', null);
      navigator.mediaSession.setActionHandler('seekforward', null);
      navigator.mediaSession.setActionHandler('seekbackward', null);
    };
  }, [usesNativeAndroidMediaSession]);

  // Sync MediaSession metadata + SMTC silent wake (track/art/lyric line) — desktop Windows/macOS/Linux
  useEffect(() => {
    if (usesNativeAndroidMediaSession || !('mediaSession' in navigator) || !playerTrack) return;
    try {
      const artworkUrl =
        coverSrcForUi(playerTrack.artwork_url, (playerTrack as any).local_artwork_path, coverArt) ||
        (coverArt && coverSrcForUi(coverArt)) ||
        convertFileSrc(logoImg);

      const formatChip = techLabel(playerTrack);
      navigator.mediaSession.metadata = new MediaMetadata({
        title: stripExtension(playerTrack.title),
        artist: playerTrack.artist,
        album: nowPlayingLyric || formatChip || 'NekoBeat',
        artwork: [{ src: artworkUrl, sizes: '512x512', type: 'image/png' }],
      });
      document.title = `${stripExtension(playerTrack.title)} - ${playerTrack.artist} | NekoBeat`;

      // Keep silent clip playing while a track is loaded — do NOT pause it on GST pause.
      // Pausing the HTML audio was aborting play() and feeding Windows spurious SMTC pause.
      if (silentAudioRef.current) {
        silentAudioRef.current.volume = 0.01;
        if (silentAudioRef.current.paused) {
          silentAudioRef.current.play().catch(() => {});
        }
      }
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    } catch (err) {
      invoke('log_frontend', { msg: `MediaSession Error: ${err}` }).catch(() => {});
    }
  }, [playerTrack?.id, playerTrack?.title, playerTrack?.artist, playerTrack?.artwork_url, coverArt, isPlaying, nowPlayingLyric, usesNativeAndroidMediaSession]);

  // Enrich the Media3-owned Android session after the explicit local play request starts it.
  useEffect(() => {
    if (!isAndroidOs || !playerTrack || !currentTrackPath) return;
    const artworkUrl = nativeAndroidArtworkUrl(
      playerTrack.artwork_url,
      (playerTrack as any).local_artwork_path,
      coverArt,
    );
    void (async () => {
      try {
        await invoke('update_android_playback_metadata', {
          title: stripExtension(playerTrack.title),
          artist: playerTrack.artist || '',
          album: playerTrack.album || '',
          artworkUrl,
          durationMs: Math.max(0, durationMs || playerTrack.duration_ms || 0),
        });
      } catch (err) {
        console.warn('Native Android playback metadata sync failed:', err);
      }
    })();
  }, [
    isAndroidOs,
    currentTrackPath,
    playerTrack?.id,
    playerTrack?.filepath,
    playerTrack?.title,
    playerTrack?.artist,
    playerTrack?.album,
    playerTrack?.artwork_url,
    playerTrack?.duration_ms,
    coverArt,
    durationMs,
  ]);

  useEffect(() => {
    if (!isAndroidOs || !currentTrackPath) return;
    const syncState = () => {
      const clock = getAudioClock();
      invoke('update_android_playback_state', {
        isPlaying: isPlayingRef.current,
        positionMs: Math.max(0, Math.floor(clock.positionMs)),
        durationMs: Math.max(0, Math.floor(clock.durationMs || durationMs || 0)),
        playbackRate: portablePlayback.playbackRate,
      }).catch(() => {});
    };
    syncState();
    if (!isPlaying) return;
    const id = window.setInterval(syncState, 1000);
    return () => window.clearInterval(id);
  }, [isAndroidOs, currentTrackPath, isPlaying, durationMs, portablePlayback.playbackRate]);

  // Never tear down Media3 just because the UI track path flickered. Only stop when the user
  // clears playback intentionally (handled elsewhere) or removes the app from Recents.

  const handleActiveLyricLine = useCallback((line: string, _index: number, _context: string) => {
    setNowPlayingLyric(line);
  }, []);

  // Drive in-app "now playing" lyric even when LyricsDisplay is unmounted (mobile default).
  useEffect(() => {
    if (!parsedLyrics.length) {
      setNowPlayingLyric('');
      return;
    }
    let lastIdx = -2;
    const tick = () => {
      const pos = getAudioClock().positionMs - lyricsOffsetMs;
      let idx = -1;
      for (let i = 0; i < parsedLyrics.length; i++) {
        if (pos >= parsedLyrics[i].timeMs) idx = i;
        else break;
      }
      if (idx === lastIdx) return;
      lastIdx = idx;
      if (idx >= 0) setNowPlayingLyric(parsedLyrics[idx].text);
    };
    tick();
    const id = window.setInterval(tick, 400);
    return () => window.clearInterval(id);
  }, [parsedLyrics, lyricsOffsetMs, playerTrack?.id]);

  // Reset lyric line + clear Android lyrics notif on track change / stop
  useEffect(() => {
    setNowPlayingLyric('');
    if (!isAndroidOs) return;
    invoke('clear_lyrics_notification_cmd').catch(() => {});
  }, [playerTrack?.id, playerTrack?.filepath, isAndroidOs]);

  useEffect(() => {
    if (!isAndroidOs || notificationLyrics) return;
    invoke('clear_lyrics_notification_cmd').catch(() => {});
  }, [isAndroidOs, notificationLyrics]);

  // Push timed cues to native LyricsSync so the notification keeps updating in the background.
  useEffect(() => {
    if (!isAndroidOs || !notificationLyrics || !playerTrack || parsedLyrics.length === 0) return;
    const trackKey = playerTrack.id || playerTrack.filepath || currentTrackPath || null;
    if (!trackKey || lyricsReadyFor !== trackKey) return;
    invoke('set_lyrics_cues', {
      title: stripExtension(playerTrack.title),
      artist: playerTrack.artist || '',
      cuesJson: JSON.stringify(parsedLyrics.map((l) => ({ t: l.timeMs, text: l.text }))),
      offsetMs: lyricsOffsetMs,
    }).catch(() => {});
  }, [
    isAndroidOs,
    notificationLyrics,
    playerTrack?.id,
    playerTrack?.filepath,
    playerTrack?.title,
    playerTrack?.artist,
    currentTrackPath,
    parsedLyrics,
    lyricsOffsetMs,
    lyricsReadyFor,
  ]);

  // Position state for lock screen — throttled, no silent-audio / handler rebind
  useEffect(() => {
    if (usesNativeAndroidMediaSession || !('mediaSession' in navigator) || !playerTrack || durationMs <= 0) return;
    if (!('setPositionState' in navigator.mediaSession)) return;
    const id = setInterval(() => {
      if (!isPlayingRef.current) return;
      const pos = getAudioClock().positionMs;
      try {
        navigator.mediaSession.setPositionState({
          duration: durationMs / 1000,
          playbackRate: portablePlayback.playbackRate,
          position: Math.min(pos / 1000, durationMs / 1000),
        });
      } catch { /* invalid position state — ignore */ }
    }, 1000);
    return () => clearInterval(id);
  }, [playerTrack?.id, durationMs, usesNativeAndroidMediaSession, portablePlayback.playbackRate]);

  useEffect(() => {
    if (!expandOnPlay || !isPlaying || !playerTrack) return;
    setIsExpanded(true);
  }, [playerTrack?.id, playerTrack?.filepath]); // eslint-disable-line react-hooks/exhaustive-deps -- only open on track change

  const techLabel = (t: any) => (showAudioFormat ? audioFormatLabel(t) : '');

  // Keep a ref with the latest positionMs so async callbacks get the current value
  const positionMsRef = useRef(0);
  useEffect(() => {
    const sync = () => { positionMsRef.current = getAudioClock().positionMs; };
    sync();
    const id = setInterval(sync, 250);
    return () => clearInterval(id);
  }, []);

  // Helper to send commands to the YouTube iframe
  const sendYTCommand = (func: string, args: any[] = []) => {
    const iframe = (window as any).__nekobeat_yt_iframe as HTMLIFrameElement | undefined;
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args }), '*');
  };

  // Sync YouTube iframe video — only on seek or pause/play, NOT periodically
  const ytLastSyncRef = useRef<number>(0);
  useEffect(() => {
    if (!videoMode || !isExpanded || !playerTrack) return;
    if (!getYouTubeVideoId(playerTrack)) return;

    // Only sync when forced (seek sets ytLastSyncRef to -999)
    if (ytLastSyncRef.current === -999) {
      const currentSec = Math.floor(getAudioClock().positionMs / 1000);
      ytLastSyncRef.current = currentSec;
      sendYTCommand('seekTo', [currentSec, true]);
    }
  }, [videoMode, isExpanded, playerTrack, isPlaying]);

  // Pause/play the YouTube video when audio state changes
  useEffect(() => {
    if (!videoMode || !isExpanded || !playerTrack) return;
    if (!getYouTubeVideoId(playerTrack)) return;
    sendYTCommand(isPlaying ? 'playVideo' : 'pauseVideo');
  }, [isPlaying, videoMode, isExpanded, playerTrack]);

  // One-time initial sync when YT iframe becomes ready after track change
  useEffect(() => {
    if (!videoMode || !isExpanded || !playerTrack) return;
    if (!getYouTubeVideoId(playerTrack)) return;

    let cleaned = false;
    let synced = false;

    const doSync = () => {
      if (cleaned || synced) return;
      synced = true;
      const sec = Math.floor(positionMsRef.current / 1000);
      sendYTCommand('seekTo', [sec, true]);
      // Only send play once — the iframe autoplay=1 handles most cases
      if (isPlaying) sendYTCommand('playVideo');
    };

    // Listen for YT iframe ready event
    const onMessage = (e: MessageEvent) => {
      if (cleaned || synced) return;
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (data?.event === 'onReady' || data?.event === 'initialDelivery' || data?.info?.playerState !== undefined) {
          doSync();
        }
      } catch { }
    };
    window.addEventListener('message', onMessage);

    // Enable iframe API event listening
    const iframe = (window as any).__nekobeat_yt_iframe as HTMLIFrameElement | undefined;
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening' }), '*');
    }

    // Single fallback: if no message arrives within 2s, sync once
    const fallback = setTimeout(() => { doSync(); }, 2000);

    return () => {
      cleaned = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(fallback);
    };
  }, [videoMode, isExpanded, playerTrack?.id]);

  // Periodic drift correction: only seekTo (no play/pause commands to avoid icon flash)
  useEffect(() => {
    if (!videoMode || !isExpanded || !playerTrack || !isPlaying) return;
    if (!getYouTubeVideoId(playerTrack)) return;
    const interval = setInterval(() => {
      const sec = Math.floor(positionMsRef.current / 1000);
      sendYTCommand('seekTo', [sec, true]);
    }, 15000);
    return () => clearInterval(interval);
  }, [videoMode, isExpanded, playerTrack?.id, isPlaying]);

  const handleSeek = (e: { currentTarget: HTMLElement; clientX: number }) => {
    if (!playerTrack) return;
    const percent = seekPercentFromClientX(e.currentTarget, e.clientX);
    const clock = getAudioClock();
    const total = (clock.durationMs > 0 ? clock.durationMs : 0) || durationMs || playerTrack.duration_ms || 0;
    if (total <= 0) return;
    seek(Math.floor(percent * total));
    ytLastSyncRef.current = -999;
  };

  const searchArtist = (artist: string) => {
    openArtistPage(artist);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const plat = await invoke<string>('runtime_platform');
        if (!cancelled) {
          setRuntimePlatform(plat);
          setIsMobileOs(plat === 'android' || plat === 'ios');
          setIsAndroidOs(plat === 'android');
          if (plat === 'android') {
            setActiveTab((t) => (t === 'browse' || t === 'listen' ? 'library' : t));
          }
        }
      } catch {
        const ua = navigator.userAgent || '';
        if (!cancelled) {
          const android = /Android/i.test(ua);
          setRuntimePlatform(android ? 'android' : 'unknown');
          setIsMobileOs(/Android|iPhone|iPad/i.test(ua));
          setIsAndroidOs(android);
          if (android) {
            setActiveTab((t) => (t === 'browse' || t === 'listen' ? 'library' : t));
          }
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const refreshAndroidPermissions = useCallback(() => {
    if (!isAndroidOs) return;
    invoke<AndroidPermissionStatus>('get_android_permission_status')
      .then(setAndroidPermissions)
      .catch((error) => console.warn('Android permission status failed:', error));
  }, [isAndroidOs]);

  useEffect(() => {
    if (!isAndroidOs || androidOnlineEnabled) return;
    setActiveTab((tab) => (tab === 'listen' || tab === 'browse' ? 'library' : tab));
    setLibrarySubTab('tracks');
  }, [isAndroidOs, androidOnlineEnabled]);

  const requestAndroidPermission = useCallback(async (kind: 'audio' | 'notifications') => {
    setPermissionRequesting(kind);
    try {
      await invoke('request_android_permission', { kind });
      window.setTimeout(refreshAndroidPermissions, 400);
    } catch (error) {
      console.warn(`Android ${kind} permission request failed:`, error);
    } finally {
      setPermissionRequesting(null);
    }
  }, [refreshAndroidPermissions]);

  useEffect(() => {
    if (!isAndroidOs || activeTab !== 'settings') return;
    refreshAndroidPermissions();
    window.addEventListener('focus', refreshAndroidPermissions);
    return () => window.removeEventListener('focus', refreshAndroidPermissions);
  }, [isAndroidOs, activeTab, refreshAndroidPermissions]);

  useEffect(() => {
    if (runtimePlatform !== 'windows') return;
    const sync = () => {
      const clock = getAudioClock();
      const active = !!playerTrack;
      const state = !windowsTaskbarProgress || !active
        ? 'none'
        : streamError
          ? 'error'
          : isPlaying
            ? 'normal'
            : 'paused';
      void invoke('set_windows_taskbar_progress', {
        state,
        completed: Math.max(0, Math.floor(clock.positionMs)),
        total: Math.max(1, Math.floor(clock.durationMs || durationMs || playerTrack?.duration_ms || 1)),
      }).catch((error) => console.warn('Taskbar progress update failed:', error));
    };
    sync();
    const interval = windowsTaskbarProgress && playerTrack
      ? window.setInterval(sync, 500)
      : undefined;
    return () => {
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [
    runtimePlatform,
    windowsTaskbarProgress,
    playerTrack?.id,
    playerTrack?.filepath,
    playerTrack?.duration_ms,
    durationMs,
    isPlaying,
    streamError,
  ]);

  /** Desktop: folder picker. Mobile: directory picker is broken — use scan / multi-file. */
  const handleScanClick = async () => {
    if (isMobileOs) {
      try {
        const scanned = await scanDeviceMusic();
        if (!scanned?.length) {
          window.alert('No songs found in Music/Download. Try Add songs and pick files.');
        }
      } catch (e) {
        window.alert(String(e).replace(/^Error:\s*/i, '') || 'Could not scan device music. Allow audio permission, then try Add songs.');
      }
      return;
    }
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });
      if (selected) {
        await scanDirectory(selected as string);
      }
    } catch (e) {
      window.alert(String(e).replace(/^Error:\s*/i, '') || 'Could not open folder.');
    }
  };

  const handleRefreshLibrary = async () => {
    try {
      coverFillAttemptedRef.current.clear();
      const scanned = await refreshLibrary();
      if (!scanned?.length) {
        window.alert('No songs found while refreshing. Try Scan music or Add songs.');
      }
    } catch (e) {
      window.alert(String(e).replace(/^Error:\s*/i, '') || 'Could not refresh library.');
    }
  };

  const handleAddSongsClick = async () => {
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        filters: [{
          name: 'Audio',
          extensions: ['mp3', 'flac', 'm4a', 'mp4', 'wav', 'ogg', 'opus', 'aac', 'wma', 'aiff', 'aif', 'wv', 'ape', 'webm', 'dsf', 'dff'],
        }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const imported = await importAudioFiles(paths as string[]);
      if (!imported?.length) {
        window.alert(
          isAndroidOs
            ? 'No playable files imported. Prefer Scan device music, or pick again — shared files are copied into app storage now.'
            : 'No playable audio files were imported.',
        );
      }
    } catch (e) {
      window.alert(String(e).replace(/^Error:\s*/i, '') || 'Could not add songs.');
    }
  };

  const isLocalSynced = playerTrack?.local_lyrics && playerTrack.local_lyrics.trim().startsWith('[');
  const hasPlainLyrics = !!lyricsData?.plainLyrics || (!!playerTrack?.local_lyrics && !isLocalSynced);
  const plainLyricsText = (playerTrack?.local_lyrics && !isLocalSynced) ? playerTrack.local_lyrics : lyricsData?.plainLyrics;

  // Escape exits miniplayer / expanded player / queue
  useEffect(() => {
    if (!isMiniplayerMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void toggleMiniplayerMode();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMiniplayerMode]);

  if (isMiniplayerMode) {
    return (
      <div className="w-full h-screen bg-[#09090b] flex items-center p-3 gap-3 border border-white/10 rounded-2xl overflow-hidden shadow-2xl select-none relative">
        {/* Drag only this strip — never full-window (that ate clicks / froze cursor) */}
        <div
          data-tauri-drag-region
          className="absolute top-0 inset-x-0 h-7 z-20 cursor-grab active:cursor-grabbing"
          title="Drag window"
        />

        <div className="absolute inset-0 bg-black/80 backdrop-blur-[60px] pointer-events-none z-0" />
        {(uiCover && !uiCover.startsWith('data:')) && (
          <div
            className="absolute inset-0 opacity-40 pointer-events-none z-0"
            style={{
              backgroundImage: `url('${uiCover}')`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              filter: "blur(40px)",
            }}
          />
        )}

        <div className="relative z-10 w-20 h-20 rounded-xl overflow-hidden shrink-0 shadow-2xl border border-white/10">
          {uiCover ? (
            <StableCoverImg
              src={uiCover}
              trackKey={playerTrack?.id || playerTrack?.filepath || currentTrackPath}
              sourcePath={coverSourcePath}
              className="w-full h-full object-cover"
              alt="Cover"
              draggable={false}
            />
          ) : (
            <div className="w-full h-full bg-neutral-800 flex items-center justify-center">
              <ListMusic size={28} className="text-neutral-500" />
            </div>
          )}
        </div>

        <div className="relative z-10 flex flex-col flex-1 min-w-0 justify-center h-full pt-4">
          <div className="mb-2 min-w-0">
            <p className="text-white font-black text-sm truncate w-full drop-shadow-md">
              {playerTrack ? stripExtension(playerTrack.title) : "No track playing"}
            </p>
            <p className="text-[var(--color-neon-yellow)] text-[11px] font-bold uppercase tracking-widest truncate w-full opacity-80">
              {playerTrack?.artist || "Nekobeat"}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handlePrevTrack}
              disabled={!currentTrackPath}
              className="text-white/60 hover:text-white p-1.5 rounded-full hover:bg-white/10 transition-all active:scale-90 disabled:opacity-40"
              aria-label="Previous"
            >
              <SkipBack size={18} fill="currentColor" />
            </button>
            <button
              type="button"
              onClick={handleTogglePlayback}
              disabled={!playerTrack}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-all disabled:opacity-40 ${isBuffering ? "bg-[var(--color-neon-yellow)]/30 animate-pulse" : "bg-[var(--color-neon-yellow)] text-black shadow-lg hover:scale-110 active:scale-95"}`}
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              {isBuffering ? (
                <div className="w-5 h-5 border-2 border-black border-t-transparent rounded-full animate-spin" />
              ) : isPlaying ? (
                <Pause size={18} fill="currentColor" />
              ) : (
                <Play size={18} fill="currentColor" className="ml-1" />
              )}
            </button>
            <button
              type="button"
              onClick={handleNextTrack}
              disabled={!currentTrackPath}
              className="text-white/60 hover:text-white p-1.5 rounded-full hover:bg-white/10 transition-all active:scale-90 disabled:opacity-40"
              aria-label="Next"
            >
              <SkipForward size={18} fill="currentColor" />
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={() => { void toggleMiniplayerMode(); }}
          className="absolute top-2 right-2 z-30 text-white hover:text-black p-2.5 min-w-[40px] min-h-[40px] rounded-xl bg-white/15 hover:bg-[var(--color-neon-yellow)] transition-all backdrop-blur-md border border-white/20"
          title="Restore window (Esc)"
          aria-label="Restore window"
        >
          <Maximize2 size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-[var(--color-surface-base)] text-white overflow-hidden font-sans select-none relative main-container">
      {(!isAndroidOs || updateCheckNonce > 0) && (
      <UpdateNotification
        checkNonce={updateCheckNonce}
        force={updateForce || isAndroidOs}
        onStatus={(s) => {
          setUpdateChecking(s.checking);
          if (s.current) setAppVersion(s.current);
          setAvailableUpdate(s.update);
          setUpdateErr(s.error);
          if (!s.checking) setUpdateUpToDate(!!s.upToDate && !s.update);
        }}
      />
      )}
      {/* Stream Error / Preview Toast */}
      <AnimatePresence>
        {streamError && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 50, scale: 0.9 }}
            className={`fixed bottom-24 left-1/2 -translate-x-1/2 md:left-auto md:translate-x-0 md:right-8 z-[100] backdrop-blur-3xl p-5 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.5)] max-w-sm w-[90vw] md:w-auto ${
              streamError.previewUrl 
                ? 'bg-amber-950/60 border border-amber-500/30' 
                : 'bg-red-950/60 border border-red-500/30'
            }`}
          >
            <div className="flex items-start gap-3">
              <div className={`p-2.5 rounded-xl shrink-0 mt-0.5 ${streamError.previewUrl ? 'bg-amber-500/10' : 'bg-red-500/10'}`}>
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={streamError.previewUrl ? 'text-amber-400' : 'text-red-400'}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              </div>
              <div className="flex-1 min-w-0">
                <h4 className={`text-sm font-bold leading-tight ${streamError.previewUrl ? 'text-amber-300' : 'text-red-300'}`}>
                  {streamError.previewUrl ? 'Preview only' : "Can't play this track"}
                </h4>
                <p className="text-xs text-neutral-400 mt-1 leading-relaxed">{streamError.message}</p>
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  {androidOnlineEnabled && (
                  <button
                    onClick={() => {
                      const q = `${streamError.trackTitle || ''} ${streamError.trackArtist || ''}`.trim();
                      setSearchQuery(q);
                      setActiveTab('browse');
                      setStreamError(null);
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all hover:scale-105 active:scale-95 flex items-center gap-1.5 ${
                      streamError.previewUrl 
                        ? 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-300' 
                        : 'bg-red-500/20 hover:bg-red-500/30 text-red-300'
                    }`}
                  >
                    <Search size={12} />
                    Search on YouTube
                  </button>
                  )}
                  {isAndroidOs && !androidOnlineEnabled && (
                  <button
                    onClick={() => {
                      setActiveTab('library');
                      setStreamError(null);
                    }}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all bg-[var(--color-neon-yellow)]/20 text-[var(--color-neon-yellow)]"
                  >
                    Open Library
                  </button>
                  )}
                  <button
                    onClick={() => setStreamError(null)}
                    className="text-neutral-500 hover:text-white text-xs font-medium px-2 py-1"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Silent audio to trigger browser media session */}
      <audio ref={silentAudioRef} loop style={{ display: 'none' }} src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=" />
      
      {/* Dynamic Background Image + Blur (Aura - Mesh Gradient effect) */}
      <div
        className="absolute inset-0 z-0 opacity-60 mix-blend-screen pointer-events-none transition-all duration-1000 ease-out"
        style={{
          backgroundImage: `radial-gradient(circle at 50% 50%, rgba(255,255,255,0.1), transparent 70%), url('${uiCover || ""}')`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          filter: "blur(140px) saturate(250%)"
        }}
      />

      {/* Navigation (Sidebar on Desktop, Bottom Bar on Mobile) */}
      <motion.aside
        initial={{ x: -20, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        className="z-50 flex flex-col md:w-64
                   fixed md:relative bottom-0 inset-x-0 md:inset-auto md:h-full 
                   flex-row md:flex-col items-center md:items-start justify-around md:justify-start 
                   px-1 md:px-3 md:pt-14 md:pb-36 md:h-auto
                   md:bg-transparent md:border-r md:border-white/[0.06]
                   mobile-bottom-nav md:border-t-0"
      >
        <div className="hidden md:flex items-center gap-3 px-2 mb-12 bg-transparent border-0 shadow-none">
          <img src={logoImg} alt="Nekobeat" className="w-9 h-9 rounded-full object-cover shrink-0" />
          <span className="font-display font-black tracking-tighter text-2xl text-white leading-none">Neko<span className="text-[var(--color-neon-yellow)]">beat</span></span>
        </div>

        <nav className="flex flex-row md:flex-col gap-1 md:gap-2 w-full justify-around md:justify-start">
          {isAndroidOs ? (
            <>
              <NavItem icon={<ListMusic size={22} />} label="Songs" active={activeTab === 'library' && librarySubTab === 'tracks'} onClick={() => { setActiveTab('library'); setLibrarySubTab('tracks'); setLibraryFocus(null); }} />
              <NavItem icon={<Disc3 size={22} />} label="Albums" active={activeTab === 'library' && librarySubTab === 'albums'} onClick={() => { setActiveTab('library'); setLibrarySubTab('albums'); setLibraryFocus(null); }} />
              <NavItem icon={<User size={22} />} label="Artists" active={activeTab === 'library' && librarySubTab === 'artists'} onClick={() => { setActiveTab('library'); setLibrarySubTab('artists'); setLibraryFocus(null); }} />
              <NavItem icon={<Heart size={22} />} label="Playlists" active={(activeTab === 'library' && librarySubTab === 'playlists') || activeTab === 'liked'} onClick={() => { setActiveTab('library'); setLibrarySubTab('playlists'); setLibraryFocus(null); }} />
              <NavItem icon={<Settings size={22} />} label="Settings" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} />
            </>
          ) : (
            <>
              <NavItem icon={<Home size={22} />} label="Listen" active={activeTab === 'listen'} onClick={() => setActiveTab('listen')} />
              <NavItem icon={<Search size={22} />} label="Browse" active={activeTab === 'browse'} onClick={() => setActiveTab('browse')} />
              <NavItem icon={<Library size={22} />} label="Library" active={activeTab === 'library'} onClick={() => setActiveTab('library')} />
              <NavItem icon={<Heart size={22} />} label="Liked Songs" active={activeTab === 'liked'} onClick={() => setActiveTab('liked')} />
            </>
          )}
        </nav>
      </motion.aside>

      {/* Main Content Area */}
      <main className="flex-1 z-10 overflow-y-auto px-3 sm:px-4 md:px-8 py-6 md:py-8 pt-10 md:pt-8 w-full block scroll-smooth no-scrollbar main-scroll-pad">
        <AnimatePresence mode="wait">
          {activeTab === 'library' ? (
            <motion.div
              key="library"
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -20, opacity: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
            >
              <LibraryPanel
                tracks={tracks}
                isScanning={isScanning}
                isMobileOs={isMobileOs}
                isAndroidOs={isAndroidOs}
                isPlaying={isPlaying}
                currentTrackPath={currentTrackPath}
                viewMode={viewMode}
                setViewMode={setViewMode}
                librarySubTab={librarySubTab}
                setLibrarySubTab={setLibrarySubTab}
                librarySort={librarySort}
                setLibrarySort={setLibrarySort}
                libraryFocus={libraryFocus}
                setLibraryFocus={setLibraryFocus}
                techLabel={techLabel}
                coverFallback={coverFallback}
                showAudioFormat={showAudioFormat}
                onScan={handleScanClick}
                onRefresh={handleRefreshLibrary}
                onAddSongs={handleAddSongsClick}
                onPlayAll={handlePlayLibraryAll}
                onPlayTrackList={handlePlayTrackList}
                onPlayLocal={handlePlayLocalTrack}
                onPlayNext={(track) => playQueue.insertNext(tracksToQueue([track])[0])}
                onAddQueue={(track) => playQueue.enqueue(tracksToQueue([track])[0])}
                onStreamExternal={handleStreamExternalAudio}
                onOpenArtist={openArtistPage}
                onOpenAlbum={openAlbumPage}
                onOpenSettings={() => setActiveTab('settings')}
                onOpenLiked={() => setActiveTab('liked')}
                onArtResolved={(fp, url) => patchTrack(fp, { artwork_url: url })}
                playlists={playlistStore.playlists}
                playlistTracks={playlistTracks}
                onCreatePlaylist={async (name) => { await playlistStore.create(name); }}
                onRenamePlaylist={async (id, name) => { await playlistStore.rename(id, name); }}
                onDeletePlaylist={async (id) => { await playlistStore.remove(id); }}
                onOpenPlaylist={openPlaylist}
                onAddToPlaylist={async (id, filepath) => { await playlistStore.addTrack(id, filepath); }}
                onRemoveFromPlaylist={removePlaylistTrack}
                onAddCurrentToPlaylist={async (id) => {
                  const local = currentTrackPath && tracks.find((track) => track.filepath === currentTrackPath);
                  if (!local) {
                    window.alert('Play a local library track first.');
                    return;
                  }
                  await playlistStore.addTrack(id, local.filepath);
                  setPlaylistTracks(await playlistStore.getTracks(id));
                }}
                stripExtension={stripExtension}
                ViewToggle={ViewToggle}
                AlbumCard={AlbumCard}
                TrackResult={TrackResult}
              />
            </motion.div>
          ) : activeTab === 'liked' ? (
            <motion.div
              key="liked"
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -20, opacity: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 md:gap-6 mb-6 md:mb-8">
                <h1 className="text-3xl sm:text-4xl md:text-5xl font-display font-black text-[var(--color-neon-yellow)] drop-shadow-[0_0_15px_rgba(219,255,0,0.5)] tracking-tighter leading-none">Liked Songs</h1>
                <ViewToggle viewMode={viewMode} onChange={setViewMode} />
              </div>
              
              {likedTracks.length === 0 ? (
                <div className="py-20 px-6 text-center max-w-md mx-auto space-y-4">
                  <Heart size={48} className="mx-auto mb-2 text-[var(--color-neon-yellow)]/70" />
                  <h2 className="text-xl font-display font-black text-white tracking-tight">No liked songs yet</h2>
                  <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed">
                    {!androidOnlineEnabled
                      ? 'Heart a library track while it plays — it shows up here.'
                      : 'Tap the heart on any track while it plays — liked songs show up here for quick replay.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => setActiveTab(androidOnlineEnabled ? 'browse' : 'library')}
                    className="inline-flex px-5 py-2.5 rounded-xl bg-[var(--color-neon-yellow)] text-black font-black text-sm uppercase tracking-wider"
                  >
                    {androidOnlineEnabled ? 'Find music to like' : 'Open Library'}
                  </button>
                </div>
              ) : viewMode === 'grid' ? (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4 md:gap-6">
                  {likedTracks.map((track) => (
                    <AlbumCard
                      key={track.id}
                      index={0}
                      title={track.title}
                      artist={track.artist}
                      album={track.album}
                      artworkUrl={
                        coverSrcForUi(track.artwork_url, track.local_artwork_path) || track.artwork_url
                      }
                      source={track.source}
                      coverFallback={coverFallback}
                      onArtistClick={() => openArtistPage(track.artist)}
                      onClick={() => handleStreamExternalAudio(track, 'liked')}
                      isPlaying={playerTrack?.id === track.id && isPlaying}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col gap-2 sm:gap-2.5">
                  {likedTracks.map((track) => (
                    <TrackResult key={track.id} track={{
                      ...track,
                      artwork_url:
                        coverSrcForUi(track.artwork_url, track.local_artwork_path) || track.artwork_url || '',
                    } as any}
                      showFormat={showAudioFormat}
                      coverFallback={coverFallback}
                      onArtistClick={() => openArtistPage(track.artist)}
                      onPlayNext={() => playQueue.insertNext(toExternalQueueTrack(track as any, 'liked'))}
                      onAddQueue={() => playQueue.enqueue(toExternalQueueTrack(track as any, 'liked'))}
                      onPlay={() => handleStreamExternalAudio(track, 'liked')} currentTrackId={playerTrack?.id || null} isCurrentlyPlaying={isPlaying} />
                  ))}
                </div>
              )}
            </motion.div>
          ) : activeTab === 'browse' ? (
            <motion.div
              key="browse"
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -20, opacity: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className={`space-y-10 transition-all duration-700 ${(!searchQuery && !isSearchFocused) ? '' : ''}`}
            >
              <HeroSearch
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                isSearching={isSearching}
                source={searchSource}
                onSourceChange={setSearchSource}
                activeSources={activeSources}
                onFocus={() => setIsSearchFocused(true)}
                onBlur={() => setIsSearchFocused(false)}
              />

              {!searchQuery && (
                <div className="pb-8 space-y-8 home-stagger">
                  {browseNews.length > 0 && (
                    <div className="space-y-3 md:space-y-4">
                      <h2 className="text-lg md:text-xl font-display font-bold text-white tracking-tight">Trending now</h2>
                      <div className="flex gap-3 md:gap-4 overflow-x-auto no-scrollbar pb-1 -mx-1 px-1 snap-x snap-mandatory">
                        {browseNews.slice(0, 10).map((track, i) => (
                          <button
                            key={`${track.title}-${track.artist}-${i}`}
                            type="button"
                            onClick={() => setSearchQuery(`${track.title} ${track.artist}`)}
                            className="shrink-0 w-[38vw] max-w-[9.5rem] sm:w-36 text-left group snap-start"
                          >
                            <div className="aspect-square rounded-2xl overflow-hidden bg-zinc-800 border border-white/10 mb-2">
                              <img src={track.artwork_url || logoImg} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                            </div>
                            <p className="text-[13px] md:text-sm font-bold text-white line-clamp-2 leading-snug group-hover:text-[var(--color-neon-yellow)]">{track.title}</p>
                            <p className="text-[11px] md:text-xs text-neutral-500 truncate mt-0.5">{track.artist}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed">Type a song or artist above. Search runs across YouTube, SoundCloud, and Spotify.</p>
                  {!browseNews.length && (
                    <p className="text-center text-[var(--color-ink-faint)] text-sm py-8">No trending picks yet — search for anything you want to hear.</p>
                  )}
                </div>
              )}

              {searchQuery && (
                <div className="space-y-8 pb-12">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                    <h2 className="text-3xl font-display font-black text-white tracking-tight leading-none">Results</h2>
                    <ViewToggle viewMode={viewMode} onChange={setViewMode} />
                  </div>
                  {isSearching ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                      {[1, 2, 3, 4, 5, 6].map(i => <SkeletonTrack key={i} />)}
                    </div>
                  ) : (
                    <>
                  {(Object.keys(sourceErrors).length > 0 || searchError) && (
                    <div className="flex flex-wrap gap-2 mb-2">
                      {searchError && (
                        <span className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 px-3 py-1.5 rounded-lg">{searchError}</span>
                      )}
                      {Object.entries(sourceErrors).map(([src, msg]) => (
                        <span key={src} className="text-xs text-amber-200/90 bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 rounded-lg">
                          <span className="capitalize">{src}</span>: {msg.replace(/^Error:\s*/i, '').slice(0, 80)}
                        </span>
                      ))}
                    </div>
                  )}
                  {searchResults.length > 0 ? (
                    viewMode === 'grid' ? (
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4 md:gap-6">
                        {searchResults.map((track, i) => (
                          <AlbumCard
                            key={track.id}
                            index={i}
                            title={track.title}
                            artist={track.artist}
                            album={track.album}
                            artworkUrl={track.artwork_url}
                            source={track.source}
                            coverFallback={coverFallback}
                            onArtistClick={() => openArtistPage(track.artist)}
                            onClick={() => {
                              const streamUrl = getTrackPlaybackUrl(track);
                              handleStreamExternalAudio({
                                id: track.id,
                                source: track.source,
                                filepath: track.id,
                                title: track.title,
                                artist: track.artist,
                                album: track.album || track.source,
                                duration_ms: track.duration_ms,
                                artwork_url: track.artwork_url,
                                stream_url: streamUrl
                              }, 'search');
                              setCoverArt((prev) => nextPlayerCover(prev, track.artwork_url));
                            }}
                            isPlaying={(playerTrack?.id || currentTrackPath) === track.id && isPlaying}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2 sm:gap-2.5">
                        {searchResults.map(track => (
                          <TrackResult key={track.id} track={track}
                            showFormat={showAudioFormat}
                            coverFallback={coverFallback}
                            onArtistClick={() => openArtistPage(track.artist)}
                            onPlayNext={() => playQueue.insertNext(toExternalQueueTrack(track, 'search'))}
                            onAddQueue={() => playQueue.enqueue(toExternalQueueTrack(track, 'search'))}
                            onPlay={(track) => {
                            const streamUrl = getTrackPlaybackUrl(track);
                            handleStreamExternalAudio({
                              id: track.id,
                              source: track.source,
                              filepath: track.id,
                              title: track.title,
                              artist: track.artist,
                              album: track.album || track.source,
                              duration_ms: track.duration_ms,
                              artwork_url: track.artwork_url,
                              stream_url: streamUrl
                            }, 'search');
                            setCoverArt((prev) => nextPlayerCover(prev, track.artwork_url));
                          }} currentTrackId={playerTrack?.id || currentTrackPath} isCurrentlyPlaying={isPlaying} />
                        ))}
                      </div>
                    )
                  ) : (
                    <div className="py-20 px-6 text-center max-w-md mx-auto space-y-3">
                      <p className="text-lg font-display font-bold text-white">No matches for “{searchQuery}”</p>
                      <p className="text-sm text-[var(--color-ink-muted)]">Try a shorter title, add the artist name, or switch source above.</p>
                    </div>
                  )}
                  </>
                  )}
                  
                  {/* Infinite scroll / Load more */}
                  {searchResults.length > 0 && hasMore && (
                    <div ref={loadMoreSentinelRef} className="flex items-center justify-center py-8">
                      {isLoadingMore ? (
                        <div className="flex items-center gap-3 text-neutral-400">
                          <div className="w-5 h-5 border-2 border-[var(--color-neon-yellow)] border-t-transparent rounded-full animate-spin" />
                          <span className="text-sm font-medium">Fetching more tracks…</span>
                        </div>
                      ) : (
                        <button 
                          onClick={loadMore}
                          className="px-6 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full text-sm font-medium text-neutral-300 hover:text-white transition-all"
                        >
                          Load more results
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          ) : activeTab === 'settings' ? (
            <motion.div
              key="settings"
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -20, opacity: 0 }}
              className="settings-shell"
            >
              <header className="space-y-2">
                <button
                  type="button"
                  onClick={() => setActiveTab(androidOnlineEnabled ? 'listen' : 'library')}
                  className="md:hidden inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[var(--color-ink-muted)] hover:text-[var(--color-neon-yellow)] min-h-[40px] -ml-1 px-1"
                >
                  <ChevronDown className="rotate-90" size={16} />
                  Back
                </button>
                <p className="section-kicker">Preferences</p>
                <h2 className="text-2xl sm:text-3xl font-display font-black text-white tracking-tight">Settings</h2>
                <p className="text-sm text-[var(--color-ink-muted)] max-w-xl">
                  Library, playback, and lyrics — neon NekoBeat style on phone and desktop.
                </p>
              </header>
              {androidOnlineEnabled && (
              <>
              <section className="settings-card space-y-4">
                <div>
                  <h3 className="text-base sm:text-lg font-display font-bold text-white">New releases region</h3>
                  <p className="text-sm text-[var(--color-ink-muted)] mt-1">
                    Apple charts for your country + global Last.fm. JioSaavn (Bollywood / Indian new releases) is only loaded when region is India — other regions never get it unless you switch to India.
                    {newsCountryPref === "auto" ? ` Auto → ${newsCountry.toUpperCase()}.` : ""}
                  </p>
                </div>
                <label className="block space-y-2">
                  <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-ink-faint)]">Country</span>
                  <select
                    value={newsCountryPref}
                    onChange={(e) => applyNewsCountryPref(e.target.value)}
                    className="w-full min-h-[48px] rounded-2xl bg-black/40 border border-white/10 text-white px-4 py-3 font-medium focus:outline-none focus:border-[var(--color-neon-yellow)]/60"
                  >
                    {NEWS_COUNTRY_OPTIONS.map((opt) => (
                      <option key={opt.code} value={opt.code} className="bg-zinc-900 text-white">
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
              </section>

              <section className="settings-card space-y-4">
                <div>
                  <h3 className="text-base sm:text-lg font-display font-bold text-white">Search sources</h3>
                  <p className="text-sm text-[var(--color-ink-muted)] mt-1">
                    Platforms included when you search. Restart after enabling a new backend if results look stale.
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {Object.entries(activeSources).map(([source, isActive]) => (
                    <button
                      key={source}
                      type="button"
                      onClick={() => {
                        const newSources = { ...activeSources, [source]: !isActive };
                        setActiveSources(newSources);
                        if (isActive && searchSource === source) setSearchSource('all');
                      }}
                      className={`flex items-center justify-between gap-3 p-4 min-h-[56px] rounded-2xl transition-all border text-left ${isActive
                        ? 'bg-white/10 border-[var(--color-neon-yellow)] shadow-[0_0_15px_-5px_rgba(219,255,0,0.3)]'
                        : 'bg-black/20 border-white/5 hover:bg-white/5'
                        }`}
                    >
                      <span className="capitalize font-bold text-white">{source}</span>
                      <div className={`w-12 h-6 rounded-full transition-colors relative shrink-0 ${isActive ? 'bg-[var(--color-neon-yellow)]' : 'bg-neutral-800'}`}>
                        <div className={`absolute top-1 w-4 h-4 rounded-full transition-all ${isActive ? 'left-7 bg-black' : 'left-1 bg-neutral-400'}`} />
                      </div>
                    </button>
                  ))}
                </div>
              </section>
              </>
              )}

              {!isMobileOs && portablePlayback.capabilities && (
                <section className="settings-card">
                  <PortablePlaybackControls
                    capabilities={portablePlayback.capabilities}
                    playbackRate={portablePlayback.playbackRate}
                    replayGainMode={portablePlayback.replayGainMode}
                    replayGainPreamp={portablePlayback.replayGainPreamp}
                    onPlaybackRateChange={portablePlayback.setPlaybackRate}
                    onReplayGainModeChange={portablePlayback.setReplayGainMode}
                    onReplayGainPreampChange={portablePlayback.setReplayGainPreamp}
                  />
                </section>
              )}

              {/* Equalizer — desktop only */}
              {!isMobileOs && (
                <section className="settings-card">
                  <Equalizer />
                </section>
              )}

              {(isAndroidOs || runtimePlatform === 'windows' || runtimePlatform === 'linux') && (
                <section className="settings-card space-y-4">
                  <div>
                    <h3 className="text-base sm:text-lg font-display font-bold text-white">Platform integration</h3>
                    <p className="text-sm text-[var(--color-ink-muted)] mt-1">
                      Native controls are enabled only where the operating system supports them.
                    </p>
                  </div>
                  {isAndroidOs && (
                    <>
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4 space-y-4">
                      <p className="font-bold text-white">Private local playback</p>
                      <p className="text-xs text-[var(--color-ink-muted)] leading-relaxed">
                        Android plays music stored on this device. NekoBeat does not upload your library, require an account, or contact streaming services.
                      </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {androidPermissions ? (
                        ([['audio', androidPermissions.audio], ['notifications', androidPermissions.notifications]] as const).map(([kind, entry]) => (
                          <div key={kind} className="rounded-2xl border border-white/10 bg-black/20 p-4 flex flex-col gap-3">
                            <div className="min-w-0">
                              <p className="font-bold text-white">{entry.label}</p>
                              <p className="text-xs text-[var(--color-ink-muted)] mt-1 break-words">
                                Android {androidPermissions.apiLevel} · {!entry.applicable ? 'No runtime permission needed' : entry.granted ? 'Allowed' : 'Not allowed'}
                              </p>
                            </div>
                            {entry.applicable && !entry.granted && (
                              <button
                                type="button"
                                disabled={permissionRequesting !== null}
                                onClick={() => void requestAndroidPermission(kind)}
                                className="min-h-[44px] rounded-xl border border-[var(--color-neon-yellow)]/40 bg-[var(--color-neon-yellow)]/10 px-4 text-sm font-bold text-[var(--color-neon-yellow)] disabled:opacity-40"
                              >
                                {permissionRequesting === kind ? 'Opening Android prompt…' : `Allow ${kind === 'audio' ? 'audio access' : 'notifications'}`}
                              </button>
                            )}
                          </div>
                        ))
                      ) : (
                        <p className="text-sm text-[var(--color-ink-muted)]">Checking Android permissions…</p>
                      )}
                    </div>
                    </>
                  )}
                  {runtimePlatform === 'windows' && (
                    <SettingsToggle
                      title="Windows taskbar progress"
                      desc="Show playback progress with normal, paused, and error states"
                      value={windowsTaskbarProgress}
                      onChange={setWindowsTaskbarProgress}
                    />
                  )}
                  {runtimePlatform === 'linux' && (
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <p className="font-bold text-white">Linux media controls</p>
                      <p className="text-xs text-[var(--color-ink-muted)] mt-1">
                        Native MPRIS is unavailable in this build: adding a second media-control runtime would increase packaging and event-loop risk. NekoBeat uses the Web MediaSession integration exposed by the Linux WebView instead.
                      </p>
                    </div>
                  )}
                </section>
              )}

              <UpdateSettingsCard
                currentVersion={appVersion}
                checking={updateChecking}
                upToDate={updateUpToDate}
                error={updateErr}
                update={availableUpdate}
                onCheck={() => {
                  setUpdateForce(true);
                  setUpdateCheckNonce((n) => n + 1);
                }}
              />

              {!isAndroidOs && (
              <section className="settings-card space-y-4">
                <div>
                  <h3 className="text-base sm:text-lg font-display font-bold text-white">Playback</h3>
                  <p className="text-sm text-[var(--color-ink-muted)] mt-1">
                    How tracks continue and whether video rides along.
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setAutoLoopLiked(!autoLoopLiked)}
                    className={`flex items-center justify-between gap-3 p-4 min-h-[64px] rounded-2xl transition-all border text-left ${autoLoopLiked
                      ? 'bg-white/10 border-[var(--color-neon-yellow)] shadow-[0_0_15px_-5px_rgba(219,255,0,0.3)]'
                      : 'bg-black/20 border-white/5 hover:bg-white/5'
                      }`}
                  >
                    <div className="min-w-0">
                      <span className="font-bold text-white block">Auto-loop liked</span>
                      <span className="text-xs text-[var(--color-ink-muted)]">When on, Up next shows what plays after the last liked track, and the queue keeps going</span>
                    </div>
                    <div className={`w-12 h-6 rounded-full transition-colors relative shrink-0 ${autoLoopLiked ? 'bg-[var(--color-neon-yellow)]' : 'bg-neutral-800'}`}>
                      <div className={`absolute top-1 w-4 h-4 rounded-full transition-all ${autoLoopLiked ? 'left-7 bg-black' : 'left-1 bg-neutral-400'}`} />
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setVideoMode(!videoMode)}
                    className={`flex items-center justify-between gap-3 p-4 min-h-[64px] rounded-2xl transition-all border text-left ${videoMode
                      ? 'bg-white/10 border-red-500 shadow-[0_0_15px_-5px_rgba(239,68,68,0.3)]'
                      : 'bg-black/20 border-white/5 hover:bg-white/5'
                      }`}
                  >
                    <div className="min-w-0">
                      <span className="font-bold text-white block">Music video</span>
                      <span className="text-xs text-[var(--color-ink-muted)]">YouTube visual in expanded player</span>
                    </div>
                    <div className={`w-12 h-6 rounded-full transition-colors relative shrink-0 ${videoMode ? 'bg-red-500' : 'bg-neutral-800'}`}>
                      <div className={`absolute top-1 w-4 h-4 rounded-full transition-all ${videoMode ? 'left-7 bg-white' : 'left-1 bg-neutral-400'}`} />
                    </div>
                  </button>
                </div>
              </section>
              )}

              <section className="settings-card space-y-4">
                <div>
                  <h3 className="text-base sm:text-lg font-display font-bold text-white">Startup & queue</h3>
                  <p className="text-sm text-[var(--color-ink-muted)] mt-1">
                    Choose what is restored and how playing a list affects Up next.
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <SettingsToggle
                    title="Refresh library at startup"
                    desc="Reindex configured folders once when NekoBeat opens"
                    value={refreshAtStartup}
                    onChange={setRefreshAtStartup}
                  />
                  <SettingsToggle
                    title="Restore playback"
                    desc="Restore the previous queue, track, and position without autoplay"
                    value={playbackRestore}
                    onChange={setPlaybackRestore}
                  />
                </div>
                <div className="space-y-2">
                  <p className="text-[10px] font-black uppercase tracking-widest text-[var(--color-ink-faint)]">When playing a list</p>
                  <div className="grid grid-cols-2 gap-2">
                    {(['replace', 'append'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setPlaylistQueueMode(mode)}
                        className={`min-h-[44px] rounded-xl border px-4 text-xs font-bold capitalize ${
                          playlistQueueMode === mode
                            ? 'bg-[var(--color-neon-yellow)] text-black border-[var(--color-neon-yellow)]'
                            : 'bg-white/5 text-white/70 border-white/10'
                        }`}
                      >
                        {mode} queue
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-[var(--color-ink-muted)]">
                    Append keeps the current track playing and adds new, non-duplicate tracks to the end.
                  </p>
                </div>
              </section>

              <section className="settings-card space-y-4">
                <div>
                  <h3 className="text-base sm:text-lg font-display font-bold text-white">Now playing & lyrics</h3>
                  <p className="text-sm text-[var(--color-ink-muted)] mt-1">
                    Player expansion, covers, and lyrics layout.
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <SettingsToggle
                    title="Display audio format"
                    desc="Show FLAC / kbps / sample rate on library and player"
                    value={showAudioFormat}
                    onChange={setShowAudioFormat}
                  />
                  <SettingsToggle
                    title="Open now playing on play"
                    desc="Expand the player when a new track starts"
                    value={expandOnPlay}
                    onChange={setExpandOnPlay}
                  />
                  <SettingsToggle
                    title="Fallback covers"
                    desc="Look up artwork online when a file has none"
                    value={coverFallback}
                    onChange={setCoverFallback}
                  />
                  <SettingsToggle
                    title="Sidecar lyrics (.lrc)"
                    desc="Prefer lyrics files next to audio when scanning"
                    value={lrcFromDirectory}
                    onChange={setLrcFromDirectory}
                  />
                  {isAndroidOs && (
                    <SettingsToggle
                      title="Notification lyrics"
                      desc="Show the current line in a separate notification you can swipe away"
                      value={notificationLyrics}
                      onChange={setNotificationLyrics}
                    />
                  )}
                </div>
                <div className="space-y-2 pt-1">
                  <p className="text-[10px] font-black uppercase tracking-widest text-[var(--color-ink-faint)]">Lyrics alignment</p>
                  <div className="flex gap-2">
                    {(['left', 'center', 'right'] as const).map((a) => (
                      <button
                        key={a}
                        type="button"
                        onClick={() => setLyricsAlign(a)}
                        className={`px-4 py-2.5 rounded-xl text-xs font-bold capitalize border min-h-[44px] ${
                          lyricsAlign === a
                            ? 'bg-[var(--color-neon-yellow)] text-black border-[var(--color-neon-yellow)]'
                            : 'bg-white/5 text-white/70 border-white/10'
                        }`}
                      >
                        {a}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                  <div className="space-y-2">
                    <p className="text-[10px] font-black uppercase tracking-widest text-[var(--color-ink-faint)]">Lyrics size</p>
                    <div className="grid grid-cols-3 gap-2">
                      {(['small', 'medium', 'large'] as const).map((size) => (
                        <button
                          key={size}
                          type="button"
                          onClick={() => setLyricsSize(size)}
                          className={`min-h-[44px] rounded-xl border px-2 text-xs font-bold capitalize ${
                            lyricsSize === size
                              ? 'bg-[var(--color-neon-yellow)] text-black border-[var(--color-neon-yellow)]'
                              : 'bg-white/5 text-white/70 border-white/10'
                          }`}
                        >
                          {size}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p className="text-[10px] font-black uppercase tracking-widest text-[var(--color-ink-faint)]">Animation intensity</p>
                    <div className="grid grid-cols-3 gap-2">
                      {(['off', 'reduced', 'full'] as const).map((intensity) => (
                        <button
                          key={intensity}
                          type="button"
                          onClick={() => setAnimationIntensity(intensity)}
                          className={`min-h-[44px] rounded-xl border px-2 text-xs font-bold capitalize ${
                            animationIntensity === intensity
                              ? 'bg-[var(--color-neon-yellow)] text-black border-[var(--color-neon-yellow)]'
                              : 'bg-white/5 text-white/70 border-white/10'
                          }`}
                        >
                          {intensity}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              <section className="settings-card space-y-4">
                <div>
                  <h3 className="text-base sm:text-lg font-display font-bold text-white">Local library</h3>
                  <p className="text-sm text-[var(--color-ink-muted)] mt-1">
                    Songs added from folders on this device. Does not delete files on disk or Liked Songs.
                  </p>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl border border-white/10 bg-black/20">
                  <div className="min-w-0">
                    <p className="font-bold text-white">{tracks.length} track{tracks.length === 1 ? '' : 's'} in library</p>
                    <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
                      {new Set(tracks.map((t) => (t.artist || 'Unknown').trim())).size} artists · {new Set(tracks.map((t) => `${t.album}\0${t.artist}`)).size} albums. Reset clears the index only — files stay on disk.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={tracks.length === 0}
                    onClick={async () => {
                      const ok = window.confirm(
                        `Clear ${tracks.length} local library track${tracks.length === 1 ? '' : 's'}?\n\nYour audio files stay on disk. Liked Songs are not affected.`,
                      );
                      if (!ok) return;
                      try {
                        await clearLibrary();
                      } catch {
                        window.alert('Could not reset the library. Try again after the app finishes loading.');
                      }
                    }}
                    className="shrink-0 px-4 py-2.5 min-h-[44px] rounded-xl border border-red-500/40 bg-red-500/10 text-red-300 text-sm font-bold hover:bg-red-500/20 hover:border-red-400/60 disabled:opacity-40 disabled:pointer-events-none transition-colors"
                  >
                    Reset library
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={isScanning}
                    onClick={() => void loadCachedTracks()}
                    className="min-h-[44px] rounded-xl border border-white/15 bg-white/5 px-4 text-sm font-bold text-white disabled:opacity-40"
                  >
                    Refresh library
                  </button>
                  <button
                    type="button"
                    disabled={isScanning || tracks.length === 0}
                    onClick={() => void reindexLibrary()}
                    className="min-h-[44px] rounded-xl border border-[var(--color-neon-yellow)]/40 bg-[var(--color-neon-yellow)]/10 px-4 text-sm font-bold text-[var(--color-neon-yellow)] disabled:opacity-40"
                  >
                    {isScanning ? 'Reindexing…' : 'Reindex metadata'}
                  </button>
                </div>
                <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                  <label className="flex flex-col gap-2 text-sm font-bold text-white sm:flex-row sm:items-center sm:justify-between">
                    Minimum audio file size
                    <select
                      value={librarySettings.min_file_size_bytes}
                      onChange={(event) => void setMinFileSize(Number(event.target.value))}
                      className="min-h-11 rounded-xl border border-white/15 bg-zinc-900 px-3 text-sm text-white"
                    >
                      <option value={0}>No minimum</option>
                      <option value={16 * 1024}>16 KB</option>
                      <option value={64 * 1024}>64 KB</option>
                      <option value={256 * 1024}>256 KB</option>
                    </select>
                  </label>
                  <div>
                    <p className="mb-2 text-xs font-black uppercase tracking-widest text-[var(--color-ink-faint)]">Indexed folders</p>
                    {librarySettings.directories.length === 0 ? (
                      <p className="text-xs text-[var(--color-ink-muted)]">Folders you add on desktop will appear here.</p>
                    ) : (
                      <div className="space-y-2">
                        {librarySettings.directories.map((directory) => (
                          <div key={directory} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                            <span className="min-w-0 flex-1 truncate text-xs text-white/75" title={directory}>{directory}</span>
                            <button type="button" onClick={() => void removeDirectory(directory)} className="rounded-lg p-2 text-red-300/70 hover:bg-red-500/10" aria-label={`Forget ${directory}`}>
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            </motion.div>
          ) : (
            <MusicNews
              news={browseNews}
              loading={browseNewsLoading}
              newsCountry={newsCountry}
              viewMode={viewMode}
              setViewMode={setViewMode}
              recentPlays={recentPlays}
              onQuickNav={(tab) => setActiveTab(!androidOnlineEnabled && tab === 'browse' ? 'library' : tab)}
              onPlayRecent={(recent) => {
                if (recent.filepath && (!recent.source || recent.source === 'local')) {
                  void handlePlayLocalTrack(recent.filepath);
                  return;
                }
                if (!androidOnlineEnabled) {
                  setActiveTab('library');
                  return;
                }
                handleStreamExternalAudio({
                  id: recent.id,
                  source: recent.source || 'youtube',
                  filepath: recent.id,
                  title: recent.title,
                  artist: recent.artist,
                  album: recent.source || 'recent',
                  duration_ms: 0,
                  artwork_url: recent.artwork_url,
                  stream_url: recent.stream_url,
                }, 'liked');
              }}
              onSelect={(track) => {
                if (!androidOnlineEnabled) {
                  setActiveTab('library');
                  return;
                }
                const q = `${track.title} ${track.artist}`;
                setPendingAutoplayQuery(q);
                setSearchQuery(q);
                setSearchSource('all');
                setActiveTab('browse');
              }}
            />
          )}
        </AnimatePresence>
      </main>

      {/* Mini-Player / Desktop Bottom Player — fixed so parent overflow-hidden can't clip controls */}
      <motion.div
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        drag={isMobileOs ? "x" : false}
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.18}
        onDragEnd={(_, info) => {
          if (!isMobileOs || !playerTrack) return;
          if (info.offset.x > 72 || info.velocity.x > 450) handlePrevTrack();
          else if (info.offset.x < -72 || info.velocity.x < -450) handleNextTrack();
        }}
        className="glass-panel fixed z-[60] flex items-center gap-1.5 sm:gap-3
                   md:inset-x-0 md:bottom-0 md:h-[88px] md:px-6 lg:px-8 md:rounded-none md:border-t md:border-white/10 md:bg-[var(--color-surface-glass-heavy)]
                   rounded-2xl shadow-[0_12px_32px_rgba(0,0,0,0.45)] bg-black/55 backdrop-blur-[40px] border border-white/10
                   mobile-mini-player md:!bottom-0 md:!left-0 md:!right-0 md:!h-[88px] md:!px-6 overflow-x-clip overflow-y-visible"
      >
        {/* Mobile progress hint along the top edge */}
        <div className="md:hidden absolute top-0 inset-x-0 z-20 rounded-t-2xl overflow-hidden">
          <MobileProgressHint
            durationMs={durationMs || ((playerTrack?.duration_ms && playerTrack.duration_ms > 0) ? playerTrack.duration_ms : undefined)}
            onSeek={handleSeek}
          />
        </div>

        {/* Left: art + meta */}
        <div
          onClick={() => playerTrack && setIsExpanded(true)}
          className="flex items-center gap-2 md:gap-3.5 min-w-0 flex-1 md:flex-none md:w-[28%] lg:w-[30%] overflow-hidden cursor-pointer group hover:bg-white/5 rounded-xl p-1 -ml-0.5 transition-colors"
        >
          <div className="w-9 h-9 md:w-14 md:h-14 rounded-lg md:rounded-md shadow-2xl bg-zinc-800 overflow-hidden shrink-0 relative">
            <StableCoverImg
              src={uiCover}
              trackKey={playerTrack?.id || playerTrack?.filepath || currentTrackPath}
              sourcePath={coverSourcePath}
              className="absolute inset-0 w-full h-full object-cover group-hover:blur-sm"
              alt=""
            />
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <Maximize2 size={16} className="text-white drop-shadow-md" />
            </div>
          </div>
          <div className="flex flex-col justify-center min-w-0 flex-1 gap-0 overflow-hidden">
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={playerTrack?.id || playerTrack?.filepath || 'idle'}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                className="font-semibold text-white truncate text-shadow-sm font-display text-[12px] sm:text-[13px] md:text-[15px] leading-snug"
              >
                {playerTrack ? stripExtension(playerTrack.title) : "Nothing playing"}
              </motion.span>
            </AnimatePresence>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={(playerTrack?.id || '') + (nowPlayingLyric || playerTrack?.artist || 'meta')}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.24, ease: 'easeOut' }}
                className="text-[10px] sm:text-[11px] md:text-xs text-[var(--color-ink-muted)] truncate font-medium leading-snug"
              >
                {nowPlayingLyric
                  ? nowPlayingLyric
                  : playerTrack
                    ? (techLabel(playerTrack)
                      ? `${playerTrack.artist} · ${techLabel(playerTrack)}`
                      : playerTrack.artist)
                    : isAndroidOs ? "Choose a song from your library" : "Find a track on Listen or Browse"}
              </motion.span>
            </AnimatePresence>
          </div>
          {playerTrack?.source && playerTrack.source !== 'local' && (
            <span className="hidden md:inline-flex text-[9px] font-black uppercase tracking-wider text-black bg-[var(--color-neon-yellow)] px-1.5 py-0.5 rounded-md shrink-0">
              {hifiReadyIds[playerTrack.id || ''] ? 'HiFi' : playerTrack.source === 'soundcloud' ? 'SC' : playerTrack.source === 'spotify' ? 'SP' : playerTrack.source === 'youtube' ? 'YT' : playerTrack.source}
            </span>
          )}
          {showAudioFormat && playerTrack?.source === 'local' && (playerTrack as any).format && (
            <span className="hidden md:inline-flex text-[9px] font-black uppercase tracking-wider text-black bg-[var(--color-neon-yellow)] px-1.5 py-0.5 rounded-md shrink-0">
              {(playerTrack as any).format}
            </span>
          )}
          {playerTrack && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void toggleLike(
                  playerTrack,
                  lyricsData?.syncedLyrics || lyricsData?.plainLyrics,
                  currentTrackPath || playerTrack.filepath,
                );
              }}
              className="ml-auto p-2 shrink-0 focus:outline-none hover:scale-110 active:scale-95 transition-transform flex"
              aria-label={playerIsLiked ? 'Unlike' : 'Like'}
            >
              {playerIsLiking ? (
                 <div className="w-5 h-5 border-2 border-[var(--color-neon-green)] border-t-transparent rounded-full animate-spin" />
              ) : (
                 <Heart size={18} fill={playerIsLiked ? "var(--color-neon-green)" : "none"} className={playerIsLiked ? "text-[var(--color-neon-green)] drop-shadow-[0_0_10px_rgba(219,255,0,0.5)]" : "text-neutral-400 hover:text-[var(--color-neon-green)]"} />
              )}
            </button>
          )}
        </div>

        {/* Center: transport + compact progress — sized to fit bar height */}
        <div className="hidden md:flex flex-col items-center justify-center flex-1 min-w-0 max-w-xl px-2 gap-1">
          <div className="flex items-center justify-center gap-3 lg:gap-5 h-10">
            <button
              type="button"
              onClick={handlePrevTrack}
              disabled={!currentTrackPath}
              aria-label="Previous Track"
              className="text-neutral-400 hover:text-white transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white rounded-full w-10 h-10 flex items-center justify-center"
            >
              <SkipBack size={20} fill="currentColor" />
            </button>
            <button
              type="button"
              onClick={handleTogglePlayback}
              disabled={!playerTrack}
              aria-label={isPlaying ? "Pause" : "Play"}
              aria-pressed={isPlaying}
              className={`w-10 h-10 lg:w-11 lg:h-11 rounded-full flex items-center justify-center transition-all shadow-lg shrink-0
                        ${isBuffering ? 'bg-[var(--color-neon-yellow)]/30 animate-pulse' : 'bg-[var(--color-neon-yellow)] text-black hover:scale-105 active:scale-95'}
                        ${isPlaying && !isBuffering ? 'neko-play-pulse' : ''}`}
            >
              {isBuffering ? (
                <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
              ) : isPlaying ? (
                <Pause size={18} fill="currentColor" />
              ) : (
                <Play size={18} fill="currentColor" className="ml-0.5" />
              )}
            </button>
            <button
              type="button"
              onClick={handleNextTrack}
              disabled={!currentTrackPath}
              aria-label="Next Track"
              className="text-neutral-400 hover:text-white transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white rounded-full w-10 h-10 flex items-center justify-center"
            >
              <SkipForward size={20} fill="currentColor" />
            </button>
          </div>
          <div className="w-full">
            <ProgressBar
              compact
              durationMs={durationMs || ((playerTrack?.duration_ms && playerTrack.duration_ms > 0) ? playerTrack.duration_ms : undefined)}
              onSeek={handleSeek}
            />
          </div>
        </div>

        {/* Right: utilities — vertically centered with left column */}
        <div className="hidden md:flex w-[28%] lg:w-[30%] justify-end items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={() => playQueue.setShowQueue(!playQueue.showQueue)}
            className={`transition-colors w-10 h-10 flex items-center justify-center rounded-full hover:bg-white/10 ${playQueue.showQueue ? 'text-[var(--color-neon-yellow)] bg-white/10' : 'text-neutral-400 hover:text-white'}`}
            title="Up next"
            aria-label="Up next"
          >
            <ListMusic size={18} />
          </button>
          <button
            type="button"
            onClick={toggleMiniplayerMode}
            className="transition-colors w-10 h-10 flex items-center justify-center rounded-full hover:bg-white/10 text-neutral-400 hover:text-white"
            title="Compact miniplayer window"
            aria-label="Compact miniplayer window"
          >
            <Minimize2 size={18} />
          </button>
          <button
            type="button"
            onClick={() => { playQueue.setShowQueue(false); setActiveTab('settings'); }}
            className={`transition-colors w-10 h-10 flex items-center justify-center rounded-full hover:bg-white/10 ${activeTab === 'settings' ? 'text-white bg-white/10' : 'text-neutral-400 hover:text-white'}`}
            aria-label="Settings"
          >
            <Settings size={18} />
          </button>

          <VolumeControl volume={volume} onChange={setVolume} />
        </div>

        {/* Mobile: queue + settings + transport */}
        <div className="md:hidden flex items-center justify-end shrink-0 pl-0.5 gap-0">
          <button
            type="button"
            onClick={() => playQueue.setShowQueue(!playQueue.showQueue)}
            className={`w-8 h-10 flex items-center justify-center rounded-full active:bg-white/10 ${playQueue.showQueue ? 'text-[var(--color-neon-yellow)]' : 'text-neutral-300'}`}
            aria-label="Up next"
            aria-expanded={playQueue.showQueue}
          >
            <ListMusic size={15} />
          </button>
          <button
            type="button"
            onClick={() => { playQueue.setShowQueue(false); setActiveTab('settings'); }}
            className={`w-8 h-10 flex items-center justify-center rounded-full active:bg-white/10 ${activeTab === 'settings' ? 'text-[var(--color-neon-yellow)]' : 'text-neutral-300'}`}
            aria-label="Settings"
          >
            <Settings size={15} />
          </button>
          <button
            type="button"
            onClick={handlePrevTrack}
            disabled={!currentTrackPath}
            aria-label="Previous"
            className="text-neutral-300 disabled:opacity-40 w-7 h-10 flex items-center justify-center rounded-full active:bg-white/10"
          >
            <SkipBack size={13} fill="currentColor" />
          </button>
          <button
            type="button"
            onClick={handleTogglePlayback}
            disabled={!playerTrack}
            aria-label={isPlaying ? "Pause" : "Play"}
            aria-pressed={isPlaying}
            className={`w-9 h-9 rounded-full flex items-center justify-center transition-all shrink-0
                      ${isBuffering ? 'bg-[var(--color-neon-yellow)]/30 animate-pulse' : 'bg-[var(--color-neon-yellow)] text-black active:scale-95 shadow-[0_0_16px_rgba(219,255,0,0.35)]'}`}
          >
            {isBuffering ? (
              <div className="w-3.5 h-3.5 border-2 border-black border-t-transparent rounded-full animate-spin" />
            ) : isPlaying ? (
              <Pause size={15} fill="currentColor" />
            ) : (
              <Play size={15} fill="currentColor" className="ml-0.5" />
            )}
          </button>
          <button
            type="button"
            onClick={handleNextTrack}
            disabled={!currentTrackPath}
            aria-label="Next"
            className="text-neutral-300 disabled:opacity-40 w-7 h-10 flex items-center justify-center rounded-full active:bg-white/10"
          >
            <SkipForward size={13} fill="currentColor" />
          </button>
        </div>
      </motion.div>

      {/* Up-next queue — click anywhere outside (or Esc) to close; works on phone + desktop */}
      <AnimatePresence>
        {playQueue.showQueue && (() => {
          const queueLoopActive =
            autoLoopLiked &&
            (externalTrack?.playbackContext === 'liked' || playQueue.current?.playbackContext === 'liked') &&
            playQueue.queue.length > 1;
          const upcomingRows = playQueue.getUpcoming(queueLoopActive);
          const straightRows = upcomingRows.filter((r) => !r.looped);
          const loopedRows = upcomingRows.filter((r) => r.looped);
          const nowPlaying = playQueue.current;

          const playQueueRow = (t: QueueTrack, queueIndex: number) => {
            playQueue.setCurrentIndex(queueIndex);
            if (isLocalQueueTrack(t)) {
              void handlePlayLocalTrack(t.stream_url || t.id, { rebuildQueue: false });
            } else {
              handleStreamExternalAudio(
                { ...t, stream_url: t.stream_url || getTrackPlaybackUrl(t) },
                t.playbackContext === 'liked' ? 'liked' : 'search',
                { skipQueueRebuild: true },
              );
            }
            setCoverArt((prev) => nextPlayerCover(prev, t.artwork_url, (t as any).local_artwork_path));
            playQueue.setShowQueue(false);
          };

          const renderRow = (row: { track: QueueTrack; queueIndex: number; looped: boolean }) => {
            const { track: t, queueIndex, looped } = row;
            const isDragOver = queueDragOver === queueIndex && queueDragFrom !== queueIndex;
            return (
              <div
                key={`${looped ? 'loop' : 'next'}-${t.id}-${queueIndex}`}
                draggable
                onDragStart={(e) => {
                  setQueueDragFrom(queueIndex);
                  e.dataTransfer.effectAllowed = 'move';
                  try { e.dataTransfer.setData('text/plain', String(queueIndex)); } catch { /* ignore */ }
                }}
                onDragEnd={() => { setQueueDragFrom(null); setQueueDragOver(null); }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (queueDragOver !== queueIndex) setQueueDragOver(queueIndex);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = queueDragFrom ?? Number(e.dataTransfer.getData('text/plain'));
                  if (Number.isFinite(from) && from !== queueIndex) {
                    playQueue.reorderQueue(from, queueIndex);
                  }
                  setQueueDragFrom(null);
                  setQueueDragOver(null);
                }}
                className={`w-full flex items-center gap-1.5 p-1.5 min-h-[52px] rounded-xl border transition-colors ${
                  isDragOver
                    ? 'border-[var(--color-neon-yellow)]/50 bg-[var(--color-neon-yellow)]/10'
                    : looped
                      ? 'border-transparent bg-white/[0.02]'
                      : 'border-transparent hover:bg-white/5'
                } ${queueDragFrom === queueIndex ? 'opacity-50' : ''}`}
              >
                <span
                  className="shrink-0 p-1.5 text-neutral-500 cursor-grab active:cursor-grabbing touch-none"
                  title="Drag to rearrange"
                  aria-hidden
                >
                  <GripVertical size={14} />
                </span>
                <button
                  type="button"
                  onClick={() => playQueueRow(t, queueIndex)}
                  className="flex items-center gap-2.5 min-w-0 flex-1 text-left rounded-lg py-1 pr-1"
                >
                  <img src={t.artwork_url || logoImg} alt="" className="w-10 h-10 rounded-md object-cover bg-zinc-800 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white truncate font-medium">{t.title}</p>
                    <p className="text-[11px] text-neutral-500 truncate">
                      {t.artist} · {t.source}{looped ? ' · loop' : ''}
                    </p>
                  </div>
                </button>
                <div className="flex flex-col shrink-0">
                  <button
                    type="button"
                    aria-label="Move up"
                    disabled={queueIndex <= 0}
                    onClick={() => playQueue.moveQueueItem(queueIndex, -1)}
                    className="p-1 text-neutral-500 hover:text-white disabled:opacity-25 min-h-[22px]"
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    disabled={queueIndex >= playQueue.queue.length - 1}
                    onClick={() => playQueue.moveQueueItem(queueIndex, 1)}
                    className="p-1 text-neutral-500 hover:text-white disabled:opacity-25 min-h-[22px]"
                  >
                    <ArrowDown size={12} />
                  </button>
                </div>
                {!looped && (
                  <button
                    type="button"
                    aria-label={`Remove ${t.title} from queue`}
                    title="Remove from queue"
                    onClick={() => playQueue.removeAt(queueIndex)}
                    className="p-2 text-neutral-500 hover:text-red-300 rounded-lg hover:bg-red-500/10 shrink-0"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            );
          };

          return (
          <motion.div
            key="queue-layer"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[70]"
          >
            <button
              type="button"
              aria-label="Close up next"
              className="absolute inset-0 bg-black/55 md:bg-black/35 cursor-default border-0 p-0"
              onClick={() => playQueue.setShowQueue(false)}
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label="Up next"
              initial={{ opacity: 0, y: 18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 380, damping: 28 }}
              className="absolute left-3 right-3 md:left-auto md:right-4 mobile-queue-panel w-auto md:w-[22rem] max-h-[min(28rem,58vh)] overflow-hidden rounded-2xl border border-white/12 bg-black/92 backdrop-blur-xl shadow-2xl flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-white/10 shrink-0">
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-white">Up next</h3>
                  {queueLoopActive && (
                    <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-neon-yellow)] flex items-center gap-1 mt-0.5">
                      <Repeat size={10} /> Auto-loop liked
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={playQueue.shuffle}
                    disabled={playQueue.queue.length < 2}
                    aria-label="Shuffle upcoming queue"
                    title="Shuffle upcoming"
                    className={`p-2 rounded-lg disabled:opacity-30 ${playQueue.shuffleEnabled ? 'text-[var(--color-neon-yellow)] bg-white/10' : 'text-neutral-400 hover:text-white hover:bg-white/10'}`}
                  >
                    <Shuffle size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={playQueue.clear}
                    disabled={playQueue.queue.length === 0}
                    className="text-neutral-400 hover:text-red-300 text-xs font-bold min-h-[36px] px-2 rounded-lg hover:bg-red-500/10 disabled:opacity-30"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={() => playQueue.setShowQueue(false)}
                    className="text-[var(--color-ink-faint)] hover:text-white text-xs font-bold min-h-[36px] px-2"
                  >
                    Close
                  </button>
                </div>
              </div>
              <div className="overflow-y-auto flex-1 p-2 space-y-1">
                {nowPlaying && (
                  <div className="mb-2 px-2 py-2 rounded-xl bg-[var(--color-neon-yellow)]/10 border border-[var(--color-neon-yellow)]/25">
                    <p className="text-[9px] font-black uppercase tracking-widest text-[var(--color-neon-yellow)] mb-1.5">Now playing</p>
                    <div className="flex items-center gap-2.5 min-w-0">
                      <img src={nowPlaying.artwork_url || logoImg} alt="" className="w-10 h-10 rounded-md object-cover bg-zinc-800 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-white truncate font-medium">{nowPlaying.title}</p>
                        <p className="text-[11px] text-neutral-400 truncate">{nowPlaying.artist}</p>
                      </div>
                    </div>
                  </div>
                )}

                {straightRows.length > 0 && (
                  <p className="text-[9px] font-black uppercase tracking-widest text-neutral-500 px-2 pt-1">Next</p>
                )}
                {straightRows.map(renderRow)}

                {queueLoopActive && loopedRows.length > 0 && (
                  <>
                    <div className="flex items-center gap-2 px-2 pt-3 pb-1">
                      <div className="h-px flex-1 bg-white/10" />
                      <p className="text-[9px] font-black uppercase tracking-widest text-[var(--color-neon-yellow)]/90 flex items-center gap-1 shrink-0">
                        <Repeat size={10} /> Then loops
                      </p>
                      <div className="h-px flex-1 bg-white/10" />
                    </div>
                    {loopedRows.map(renderRow)}
                  </>
                )}

                {upcomingRows.length === 0 && (
                  <p className="text-xs text-[var(--color-ink-muted)] p-3 leading-relaxed">
                    {queueLoopActive
                      ? 'Only this track is in the liked queue — add more liked songs to keep looping through a list.'
                      : 'Queue is empty. Play from Liked with Auto-loop on, or from Browse, and tracks will line up here. Drag the handle to rearrange.'}
                  </p>
                )}
              </div>
            </motion.div>
          </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* Expanded Player Overlay */}
      <AnimatePresence>
        {isExpanded && playerTrack && (
          <motion.div
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="fixed inset-0 z-[100] bg-[var(--color-surface-base)] overflow-hidden flex flex-col min-h-0"
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={0.8}
            onDragEnd={(_, info) => {
              if (info.offset.y > 150 || info.velocity.y > 500) {
                setIsExpanded(false);
              }
            }}
          >
            <div className="absolute inset-0 z-0 bg-[var(--color-surface-base)] pointer-events-none" />
            <div className="absolute top-8 inset-x-8 z-50 flex justify-between items-center pointer-events-none">
              <button
                onClick={() => setIsExpanded(false)}
                aria-label="Close now playing"
                className="p-3 rounded-full bg-white/10 hover:bg-white/20 transition-colors text-white pointer-events-auto"
              >
                <ChevronDown size={28} />
              </button>

              <div className="flex items-center gap-2 pointer-events-auto">
                {getYouTubeVideoId(playerTrack) && (
                  <button
                    onClick={() => setVideoMode(!videoMode)}
                    className={`p-3 rounded-full transition-colors shadow-lg ${videoMode ? 'bg-red-600 text-white shadow-[0_0_15px_rgba(239,68,68,0.4)]' : 'bg-white/10 hover:bg-white/20 text-white'}`}
                    title={videoMode ? 'Hide video' : 'Show music video'}
                  >
                    <MonitorPlay size={24} />
                  </button>
                )}
                <button
                  onClick={() => setShowMobileLyrics(!showMobileLyrics)}
                  aria-label={showMobileLyrics ? 'Show player controls' : 'Show lyrics'}
                  className={`md:hidden p-3 rounded-full transition-colors shadow-lg ${showMobileLyrics ? 'bg-[var(--color-neon-yellow)] text-black shadow-[0_0_15px_rgba(219,255,0,0.4)]' : 'bg-white/10 hover:bg-white/20 text-white'}`}
                >
                  <ListMusic size={24} />
                </button>
              </div>
            </div>

            <div className="relative z-10 flex flex-col w-full h-full min-h-0 max-w-7xl mx-auto px-4 sm:px-6 md:px-10 pt-[max(4.5rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <div className="flex flex-col md:flex-row flex-1 min-h-0 w-full gap-3 md:gap-8">
              {/* Left Side: Art, meta, controls — always fully visible */}
              <div className={`w-full md:w-1/2 min-h-0 h-full flex-col ${showMobileLyrics ? 'hidden md:flex' : 'flex'}`}>
                <div className="flex flex-col flex-1 min-h-0 w-full max-w-[min(100%,420px)] mx-auto">
                  {/* Art — scales to leftover viewport height so title+controls never clip */}
                  <div className="relative flex-1 min-h-0 flex items-center justify-center py-2 md:py-3">
                    <div
                      className="relative aspect-square shrink-0 contain-strict"
                      style={{
                        transform: 'translateZ(0)',
                        width: 'min(100%, 380px, 52vw, 42dvh)',
                        maxHeight: 'min(42dvh, 380px)',
                      }}
                    >
                  {videoMode && getYouTubeVideoId(playerTrack) ? (
                    <>
                      <div className="relative z-10 w-full h-full rounded-[1.75rem] sm:rounded-[2.5rem] md:rounded-[3rem] shadow-2xl overflow-hidden">
                        <iframe
                          ref={(el) => {
                            if (el) {
                              (window as any).__nekobeat_yt_iframe = el;
                            }
                          }}
                          key={getYouTubeVideoId(playerTrack)!}
                          src={`https://www.youtube-nocookie.com/embed/${getYouTubeVideoId(playerTrack)}?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&showinfo=0&loop=0&fs=0&disablekb=1&iv_load_policy=3&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`}
                          className="absolute"
                          style={{ border: 'none', pointerEvents: 'none', top: '-56%', left: '-33%', width: '166%', height: '210%' }}
                          allow="autoplay; encrypted-media"
                          allowFullScreen={false}
                          title="Music Video"
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <motion.div
                        layoutId="album-art"
                        className={`relative z-10 w-full h-full rounded-2xl overflow-hidden bg-black transition-[opacity,transform] duration-200 shadow-[0_18px_48px_rgba(0,0,0,0.32)] ${isPlaying ? 'scale-100' : 'scale-[0.985] opacity-95'}`}
                        style={{ willChange: 'transform' }}
                        drag="x"
                        dragConstraints={{ left: 0, right: 0 }}
                        dragElastic={0.4}
                        onDragEnd={(_, info) => {
                          if (info.offset.x > 100) {
                            handlePrevTrack();
                          } else if (info.offset.x < -100) {
                            handleNextTrack();
                          }
                        }}
                      >
                        <StableCoverImg
                          src={uiCover}
                          trackKey={playerTrack.id || playerTrack.filepath}
                          sourcePath={coverSourcePath}
                          className="absolute inset-0 w-full h-full object-cover"
                          alt="Album Art"
                        />
                      </motion.div>
                    </>
                  )}
                    </div>
                  </div>

                  {/* Title / artist — same width as art column, never flush to window edge */}
                  <div className="w-full flex items-center justify-between gap-3 text-left shrink-0 relative z-20 px-1 sm:px-2 py-2 md:py-3">
                    <div className="min-w-0 flex-1">
                      <AnimatePresence mode="wait" initial={false}>
                        <motion.h2
                          key={playerTrack.id || playerTrack.filepath}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -8 }}
                          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                          className="text-lg sm:text-xl md:text-2xl lg:text-3xl font-display font-bold text-white mb-1 truncate drop-shadow-md tracking-tight leading-tight"
                        >
                          {stripExtension(playerTrack.title)}
                        </motion.h2>
                      </AnimatePresence>
                      <button
                        type="button"
                        onClick={() => searchArtist(playerTrack.artist)}
                        className="text-[11px] sm:text-xs md:text-sm text-[var(--color-neon-yellow)] font-medium font-sans truncate drop-shadow-sm uppercase tracking-widest opacity-80 hover:opacity-100 hover:underline underline-offset-4 text-left max-w-full"
                        title={`Search ${playerTrack.artist}`}
                      >
                        {playerTrack.artist}
                      </button>
                      {techLabel(playerTrack) && (
                        <p className="text-[10px] sm:text-[11px] text-white/45 font-mono tracking-wide mt-1.5 truncate">
                          {techLabel(playerTrack)}
                        </p>
                      )}
                      {nowPlayingLyric && (
                        <p className="text-[11px] sm:text-xs text-white/70 mt-2 line-clamp-2 font-lyrics leading-snug">
                          {nowPlayingLyric}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        void toggleLike(
                          playerTrack,
                          lyricsData?.syncedLyrics || lyricsData?.plainLyrics,
                          currentTrackPath || playerTrack.filepath,
                        )
                      }
                      className="p-2.5 sm:p-3 shrink-0 focus:outline-none hover:scale-110 active:scale-95 transition-transform bg-white/5 hover:bg-white/10 rounded-full"
                      aria-label={playerIsLiked ? 'Unlike' : 'Like'}
                    >
                      {playerIsLiking ? (
                         <div className="w-5 h-5 sm:w-6 sm:h-6 border-2 border-[var(--color-neon-yellow)] border-t-transparent rounded-full animate-spin" />
                      ) : (
                         <Heart size={22} fill={playerIsLiked ? "var(--color-neon-yellow)" : "none"} className={playerIsLiked ? "text-[var(--color-neon-yellow)] drop-shadow-[0_0_15px_rgba(219,255,0,0.8)]" : "text-white/80 hover:text-white"} />
                      )}
                    </button>
                  </div>

                  {/* Controls — in-flow (not viewport-fixed) so they stay on screen with art */}
                  <div className="w-full flex flex-col items-center justify-center gap-3 sm:gap-4 shrink-0 relative z-20 px-1 sm:px-2 pb-2 md:pb-4 pt-1">
                    <div className="w-full">
                      <ExpandedProgressBar durationMs={durationMs || ((playerTrack?.duration_ms && playerTrack.duration_ms > 0) ? playerTrack.duration_ms : undefined)} onSeek={handleSeek} />
                    </div>
                    <div className="flex items-center justify-center gap-5 sm:gap-6 md:gap-8">
                      <button type="button" onClick={handlePrevTrack} disabled={!currentTrackPath} aria-label="Previous" className="text-white/60 hover:text-white transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white rounded-md p-2 min-w-[44px] min-h-[44px] flex items-center justify-center"><SkipBack size={22} className="md:w-6 md:h-6" fill="currentColor" /></button>
                      <button
                        type="button"
                        onClick={handleTogglePlayback}
                        disabled={!playerTrack}
                        aria-label={isPlaying ? "Pause" : "Play"}
                        aria-pressed={isPlaying}
                        className={`w-14 h-14 sm:w-14 sm:h-14 md:w-16 md:h-16 rounded-full flex items-center justify-center transition-all shadow-lg shrink-0
                               ${isBuffering ? 'bg-[var(--color-neon-green)]/30 animate-pulse' : 'bg-[var(--color-neon-green)] text-black hover:scale-105 active:scale-95'}`}
                      >
                        {isBuffering ? (
                          <div className="w-6 h-6 border-3 border-black border-t-transparent rounded-full animate-spin" />
                        ) : isPlaying ? (
                          <Pause size={22} fill="currentColor" />
                        ) : (
                          <Play size={22} fill="currentColor" className="ml-1" />
                        )}
                      </button>
                      <button type="button" onClick={handleNextTrack} disabled={!currentTrackPath} aria-label="Next" className="text-white/60 hover:text-white transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white rounded-md p-2 min-w-[44px] min-h-[44px] flex items-center justify-center"><SkipForward size={22} className="md:w-6 md:h-6" fill="currentColor" /></button>
                    </div>
                    <div className="flex items-center justify-center gap-2" aria-label="Playback options">
                      <button type="button" onClick={playQueue.shuffle} disabled={playQueue.queue.length < 2} aria-label="Shuffle queue" aria-pressed={playQueue.shuffleEnabled} className={`grid min-h-11 min-w-11 place-items-center rounded-xl disabled:opacity-30 ${playQueue.shuffleEnabled ? 'bg-[var(--color-neon-yellow)]/15 text-[var(--color-neon-yellow)]' : 'text-white/55'}`}><Shuffle size={18} /></button>
                      <button type="button" onClick={() => setAutoLoopLiked((value) => !value)} aria-label="Repeat queue" aria-pressed={autoLoopLiked} className={`grid min-h-11 min-w-11 place-items-center rounded-xl ${autoLoopLiked ? 'bg-[var(--color-neon-yellow)]/15 text-[var(--color-neon-yellow)]' : 'text-white/55'}`}><Repeat size={18} /></button>
                      <button type="button" onClick={() => { setIsExpanded(false); playQueue.setShowQueue(true); }} aria-label="Open up next queue" className="grid min-h-11 min-w-11 place-items-center rounded-xl text-white/55"><ListMusic size={18} /></button>
                      <button type="button" onClick={() => setShowMobileLyrics(true)} aria-label="Show synchronized lyrics" className="min-h-11 rounded-xl px-3 text-xs font-bold text-white/70">Lyrics</button>
                    </div>
                    <div className="w-full max-w-[260px] flex justify-center pt-1">
                      <VolumeControl volume={volume} onChange={setVolume} alwaysShow />
                    </div>
                  </div>
                </div>
              </div>

              {/* Right Side: Lyrics */}
              <div className={`w-full md:w-1/2 min-h-0 h-full flex-col relative ${showMobileLyrics ? 'flex' : 'hidden md:flex'}`}>
                <LyricsDisplay
                  parsedLyrics={parsedLyrics}
                  hasPlainLyrics={hasPlainLyrics}
                  plainLyricsText={plainLyricsText}
                  lyricsOffsetMs={lyricsOffsetMs}
                  onOffsetChange={handleLyricsOffsetChange}
                  onUploadLyrics={handleUploadLyrics}
                  onActiveLineChange={handleActiveLyricLine}
                  align={lyricsAlign}
                  size={lyricsSize}
                  lyricsSource={lyricsData?.source}
                />
              </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function NavItem({ icon, label, active = false, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick?: () => void }) {
  const short = label === 'Liked Songs' ? 'Liked' : label;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col md:flex-row items-center justify-center md:justify-start gap-0.5 md:gap-3 px-1 md:px-4 py-1.5 md:py-2.5 rounded-xl transition-all font-medium w-full min-h-[44px] md:min-h-0 ${
        active
          ? 'nav-item-active'
          : 'text-[var(--color-ink-faint)] md:text-[var(--color-ink-muted)] hover:text-white hover:bg-white/5'
      }`}
    >
      <span className={active ? "text-[var(--color-neon-yellow)]" : ""}>{icon}</span>
      <span className={`text-[9px] md:text-base font-bold leading-none ${active ? 'text-white' : ''}`}>
        <span className="md:hidden">{short}</span>
        <span className="hidden md:inline">{label}</span>
      </span>
    </button>
  );
}

function HeroSearch({ value, onChange, isSearching, source, onSourceChange, activeSources, onFocus, onBlur }: { value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; isSearching: boolean, source: string, onSourceChange: (s: any) => void, activeSources: Record<string, boolean>, onFocus: () => void, onBlur: () => void }) {
  return (
    <motion.div 
      layout
      transition={{ type: "spring", stiffness: 200, damping: 25 }}
      className="relative w-full max-w-4xl mx-auto px-0 sm:px-4 flex flex-col gap-5 md:gap-8"
    >
      <motion.div layout className="relative group">
        <div className="absolute inset-y-0 left-4 md:left-6 flex items-center pointer-events-none">
          <Search className={`transition-colors duration-300 ${isSearching ? 'text-[var(--color-neon-yellow)] animate-pulse' : 'text-white/40'}`} size={22} />
        </div>
        <input
          type="text"
          value={value}
          onChange={onChange}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={source === 'all' ? 'Song, artist, or album…' : `Search ${source.charAt(0).toUpperCase() + source.slice(1)}…`}
          className="w-full bg-[var(--color-surface-raised)]/80 backdrop-blur-xl border border-[var(--color-neon-yellow)]/15 shadow-inner shadow-black/40 rounded-2xl py-4 md:py-6 pl-12 md:pl-16 pr-4 md:pr-6 text-base md:text-2xl text-white placeholder-[var(--color-ink-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--color-neon-yellow)] focus:border-transparent transition-all duration-300 shadow-2xl"
        />
      </motion.div>

      <motion.div layout className="flex flex-wrap items-center justify-center gap-3">
        <button
          onClick={() => onSourceChange('all')}
          className={`flex items-center gap-2 px-6 py-2.5 rounded-xl font-bold transition-all border ${source === 'all' 
            ? 'bg-gradient-to-b from-[var(--color-neon-yellow)] to-[color-mix(in_srgb,var(--color-neon-yellow)_85%,black)] border-[var(--color-neon-yellow)] text-black shadow-[inset_0_2px_4px_rgba(255,255,255,0.6),0_10px_20px_-5px_rgba(219,255,0,0.4)]' 
            : 'bg-white/5 text-neutral-400 border-white/5 hover:bg-white/10 hover:text-white'}`}
        >
          All
        </button>
        {Object.entries(activeSources).filter(([_, isActive]) => isActive).map(([s, _]) => {
          const isSelected = source === s;

          return (
            <button
              key={s}
              onClick={() => onSourceChange(s as any)}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-xl font-bold transition-all border capitalize ${isSelected 
                ? s === 'youtube' 
                  ? 'bg-[var(--color-src-youtube)] border-red-400 text-white shadow-[0_10px_20px_-5px_rgba(239,68,68,0.4)]'
                  : s === 'soundcloud'
                    ? 'bg-[var(--color-src-soundcloud)] border-orange-300 text-white shadow-[0_10px_20px_-5px_rgba(249,115,22,0.4)]'
                    : s === 'spotify'
                      ? 'bg-[var(--color-src-spotify)] border-emerald-300 text-black shadow-[0_10px_20px_-5px_rgba(29,185,84,0.4)]'
                      : 'bg-white/20 border-white/30 text-white'
                : 'bg-white/5 text-[var(--color-ink-muted)] border-white/5 hover:bg-white/10 hover:text-white'}`}
            >
              {s === 'youtube' ? 'YouTube' : s === 'soundcloud' ? 'SoundCloud' : s === 'spotify' ? 'Spotify' : s}
            </button>
          );
        })}
      </motion.div>
    </motion.div>
  );
}


function TrackResult({
  track,
  onPlay,
  currentTrackId,
  isCurrentlyPlaying,
  showFormat = true,
  onArtistClick,
  onPlayNext,
  onAddQueue,
  coverFallback = true,
  onArtResolved,
}: {
  track: AggregatedTrack;
  onPlay: (track: AggregatedTrack) => void;
  currentTrackId: string | null;
  isCurrentlyPlaying: boolean;
  showFormat?: boolean;
  onArtistClick?: () => void;
  onPlayNext?: () => void;
  onAddQueue?: () => void;
  coverFallback?: boolean;
  onArtResolved?: (url: string) => void;
}) {
  const isCurrentTrack = currentTrackId === track.id;
  const tech = showFormat ? audioFormatLabel(track) : '';
  const initialArt = coverSrcForUi(track.artwork_url) || (isRealArtworkUrl(track.artwork_url) ? track.artwork_url : undefined);
  const [artUrl, setArtUrl] = useState(initialArt && !isPlaceholderArt(initialArt) ? initialArt : '');
  const fetchingRef = useRef(false);
  const trackIdRef = useRef(track.id);

  useEffect(() => {
    const trackChanged = trackIdRef.current !== track.id;
    trackIdRef.current = track.id;
    const next = coverSrcForUi(track.artwork_url) || (isRealArtworkUrl(track.artwork_url) && !isLocalCoverPath(track.artwork_url) ? track.artwork_url! : undefined);
    const nextOk = !!(next && !isPlaceholderArt(next) && isRealArtworkUrl(next));

    let cancelled = false;

    if (nextOk) {
      setArtUrl((prev) => {
        if (!trackChanged && prev && !isPlaceholderArt(prev) && coversSameAsset(prev, next!)) return prev;
        if (!trackChanged && prev && isRealArtworkUrl(prev) && !isPlaceholderArt(prev)) {
          void preloadCoverUrl(next!).then((ok) => {
            if (ok) setArtUrl(next!);
          });
          return prev;
        }
        return next!;
      });
    } else if (isLocalCoverPath(track.artwork_url)) {
      // Same path Media3 uses as file:// — load as data URL for list <img>
      void resolveCoverForWebView(track.artwork_url).then((url) => {
        if (cancelled || !url) return;
        setArtUrl(url);
      });
    } else if (trackChanged) {
      setArtUrl('');
    }

    if (nextOk || isLocalCoverPath(track.artwork_url)) {
      return () => { cancelled = true; };
    }

    // Missing art: keep previous good cover for this row; fetch in background
    if (trackChanged) setArtUrl('');
    if (!coverFallback || fetchingRef.current) return;
    fetchingRef.current = true;
    ensureTrackCoverArt(
      {
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork_url: track.artwork_url,
        filepath: (track as any).filepath,
      },
      (url) => {
        if (cancelled || !url || isPlaceholderArt(url)) return;
        if (isLocalCoverPath(url)) {
          void resolveCoverForWebView(url).then((resolved) => {
            if (!cancelled && resolved) {
              setArtUrl(resolved);
              onArtResolved?.(url);
            }
          });
          return;
        }
        setArtUrl(url);
        onArtResolved?.(url);
      },
    ).finally(() => { fetchingRef.current = false; });
    return () => { cancelled = true; };
  }, [track.id, track.title, track.artist, track.album, track.artwork_url, coverFallback, onArtResolved]);

  const handlePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (coverFallback && !isRealArtworkUrl(track.artwork_url) && !isRealArtworkUrl(artUrl)) {
      void ensureTrackCoverArt(
        { title: track.title, artist: track.artist, album: track.album, artwork_url: track.artwork_url },
        (url) => {
          setArtUrl(url);
          onArtResolved?.(url);
        },
      );
    }
    onPlay(track);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`library-track-row group flex items-center gap-3 sm:gap-4 px-2.5 py-2 sm:p-3 rounded-xl sm:rounded-2xl transition-all relative
                  ${isCurrentTrack
                    ? 'bg-[var(--color-neon-yellow)]/12 border border-[var(--color-neon-yellow)]/45 shadow-[0_0_0_1px_rgba(243,173,36,0.12)]'
                    : 'bg-[var(--color-raised)]/55 border border-[var(--color-divider)] hover:bg-[var(--color-raised)] hover:border-[var(--color-neon-yellow)]/25'}`}
    >
      <button
        type="button"
        onClick={handlePlay}
        aria-label={`Play ${track.title} by ${track.artist}`}
        className="w-14 h-14 sm:w-16 sm:h-16 rounded-xl sm:rounded-2xl overflow-hidden shrink-0 relative bg-[var(--color-surface-raised)] text-left ring-1 ring-white/8"
      >
        <img
          src={artUrl || logoImg}
          className="w-full h-full object-cover"
          alt=""
          onError={(e) => {
            // Soft fallback once — avoid error loops that blink logo
            const el = e.currentTarget;
            if (el.dataset.fallback === '1') return;
            el.dataset.fallback = '1';
            if (coverFallback && !isRealArtworkUrl(artUrl)) {
              void ensureTrackCoverArt(
                { title: track.title, artist: track.artist, album: track.album, artwork_url: track.artwork_url, filepath: (track as any).filepath },
                (url) => {
                  if (url && !isPlaceholderArt(url)) setArtUrl(url);
                },
              );
            }
          }}
        />
        <div className={`absolute inset-0 flex items-center justify-center bg-black/45 transition-opacity ${isCurrentTrack && isCurrentlyPlaying ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-active:opacity-100'}`}>
          {isCurrentTrack && isCurrentlyPlaying ? (
            <div className="flex gap-0.5 items-end h-4">
              <span className="w-0.5 h-2 bg-[var(--color-neon-yellow)] animate-pulse" />
              <span className="w-0.5 h-4 bg-[var(--color-neon-yellow)] animate-pulse" style={{ animationDelay: '120ms' }} />
              <span className="w-0.5 h-3 bg-[var(--color-neon-yellow)] animate-pulse" style={{ animationDelay: '240ms' }} />
            </div>
          ) : (
            <Play size={18} fill="var(--color-neon-yellow)" className="text-[var(--color-neon-yellow)] ml-0.5" />
          )}
        </div>
      </button>
      <div className="flex-1 truncate min-w-0 py-0.5">
        <button type="button" onClick={handlePlay} className="block max-w-full text-left">
          <h4 className={`font-display font-bold tracking-tight truncate text-[13px] sm:text-[15px] ${isCurrentTrack ? 'text-[var(--color-neon-yellow)]' : 'text-[var(--color-text-primary)]'}`}>
            {stripExtension(track.title)}
          </h4>
        </button>
        <div className="flex items-center gap-2 min-w-0 mt-0.5">
          <button
            type="button"
            className="text-[11px] sm:text-xs text-[var(--color-ink-muted)] tracking-wide font-medium truncate hover:text-[var(--color-neon-yellow)]"
            onClick={(e) => { if (onArtistClick) { e.stopPropagation(); onArtistClick(); } }}
          >{track.artist}</button>
          {track.source && track.source !== 'local' && (
            <span className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-md uppercase tracking-wide ${
              track.source === 'youtube' ? 'bg-[var(--color-src-youtube)]/20 text-[var(--color-src-youtube)]' :
              track.source === 'soundcloud' ? 'bg-[var(--color-src-soundcloud)]/20 text-[var(--color-src-soundcloud)]' :
              track.source === 'spotify' ? 'bg-[var(--color-src-spotify)]/20 text-[var(--color-src-spotify)]' :
              'bg-white/10 text-white/50'
            }`}>
              {track.source === 'youtube' ? 'YT' : track.source === 'soundcloud' ? 'SC' : track.source === 'spotify' ? 'SP' : track.source}
            </span>
          )}
        </div>
        {tech && (
          <p className="text-[10px] text-[var(--color-ink-faint)] font-mono tracking-wide mt-0.5 truncate">{tech}</p>
        )}
      </div>

      <div className="absolute right-2 sm:right-3 inset-y-0 flex items-center gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity bg-gradient-to-l from-[var(--color-surface-base)] via-[var(--color-surface-base)]/95 to-transparent pl-6 sm:pl-8">
        <button
          type="button"
          onClick={handlePlay}
          className="bg-[var(--color-neon-yellow)] text-black font-bold px-3 py-2 rounded-xl text-xs sm:text-sm shadow-lg hover:scale-105 active:scale-95 transition-all"
        >
          {isCurrentTrack && isCurrentlyPlaying ? 'Playing' : 'Play'}
        </button>
        {onPlayNext && (
          <button
            type="button"
            onClick={onPlayNext}
            aria-label={`Play ${track.title} next`}
            title="Play next"
            className="p-2 backdrop-blur-md bg-white/10 rounded-xl border border-white/15 hover:bg-white/20 transition-all text-[var(--color-text-primary)]"
          >
            <SkipForward size={17} />
          </button>
        )}
        {onAddQueue && (
          <button
            type="button"
            onClick={onAddQueue}
            aria-label={`Add ${track.title} to queue`}
            title="Add to queue"
            className="p-2 backdrop-blur-md bg-white/10 rounded-xl border border-white/15 hover:bg-white/20 transition-all text-[var(--color-text-primary)]"
          >
            <ListMusic size={17} />
          </button>
        )}
      </div>
    </motion.div>
  );
}

function SkeletonTrack() {
  return (
    <div className="flex items-center gap-4 p-3 rounded-2xl bg-white/5 animate-pulse">
      <div className="w-16 h-16 rounded-2xl bg-white/10" />
      <div className="flex-1 space-y-2">
        <div className="h-4 bg-white/10 rounded w-3/4" />
        <div className="h-3 bg-white/10 rounded w-1/2" />
      </div>
    </div>
  );
}

function AlbumCard({ index, title, artist, album, onClick, isPlaying, artworkUrl, source, formatLabel, coverFallback = true, onArtResolved, onArtistClick }: { index: number; title: string; artist: string; album?: string; onClick: () => void; isPlaying: boolean; artworkUrl?: string; source?: string; formatLabel?: string; coverFallback?: boolean; onArtResolved?: (url: string) => void; onArtistClick?: () => void }) {
  const resolved = coverSrcForUi(artworkUrl) || (isRealArtworkUrl(artworkUrl) ? artworkUrl : undefined);
  const [imgUrl, setImgUrl] = useState(resolved && !isPlaceholderArt(resolved) ? resolved : '');
  const failedRef = useRef(false);
  const titleRef = useRef(`${title}|${artist}|${album || ''}`);

  useEffect(() => {
    failedRef.current = false;
    const identity = `${title}|${artist}|${album || ''}`;
    const identityChanged = titleRef.current !== identity;
    titleRef.current = identity;
    const next = coverSrcForUi(artworkUrl);
    const nextOk = !!(next && !isPlaceholderArt(next));

    if (nextOk) {
      setImgUrl((prev) => {
        if (!identityChanged && prev && coversSameAsset(prev, next!)) return prev;
        if (!identityChanged && prev && isRealArtworkUrl(prev) && !isPlaceholderArt(prev)) {
          void preloadCoverUrl(next!).then((ok) => { if (ok) setImgUrl(next!); });
          return prev;
        }
        return next!;
      });
      if (isRealArtworkUrl(artworkUrl) || isRealArtworkUrl(next)) return;
    } else if (isLocalCoverPath(artworkUrl)) {
      let cancelledLocal = false;
      void resolveCoverForWebView(artworkUrl).then((url) => {
        if (!cancelledLocal && url) setImgUrl(url);
      });
      return () => { cancelledLocal = true; };
    } else if (identityChanged) {
      setImgUrl('');
    }

    if (!coverFallback) return;
    let cancelled = false;
    fetchAlbumArt(title, artist, album).then((url) => {
      if (cancelled || failedRef.current || !url || isPlaceholderArt(url)) return;
      setImgUrl(url);
      if (!artworkUrl || !isRealArtworkUrl(artworkUrl)) onArtResolved?.(url);
    });
    return () => { cancelled = true; };
  }, [title, artist, album, artworkUrl, onArtResolved, coverFallback]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        delay: Math.min(index * 0.03, 0.45),
        type: 'spring',
        stiffness: 380,
        damping: 28,
      }}
      whileHover={{ y: -8, scale: 1.02 }}
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      className="group cursor-pointer flex flex-col gap-2 md:gap-3 min-w-0"
    >
      <div className={`aspect-square rounded-xl md:rounded-2xl bg-zinc-800/30 overflow-hidden relative border border-white/10 transition-shadow duration-300 shadow-[0_15px_35px_rgba(0,0,0,0.4)] group-hover:shadow-[0_25px_50px_rgba(0,0,0,0.55)] group-hover:border-[var(--color-neon-yellow)]/30`}>
        {imgUrl ? (
          <img
            src={imgUrl}
            className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700 ease-out"
            alt=""
            onError={() => {
              if (failedRef.current) return;
              failedRef.current = true;
              fetchAlbumArt(title, artist, album).then((url) => {
                if (url && !isPlaceholderArt(url)) {
                  setImgUrl(url);
                  onArtResolved?.(url);
                }
              });
            }}
          />
        ) : (
          <div className="w-full h-full bg-zinc-800/80" />
        )}
        {source && source !== 'local' && (
          <div className={`absolute top-1.5 right-1.5 md:top-2 md:right-2 px-1.5 md:px-2 py-0.5 rounded-md md:rounded-lg text-[9px] md:text-[10px] font-bold uppercase tracking-wide shadow-lg ${
            source === 'youtube' ? 'bg-[var(--color-src-youtube)] text-white' :
            source === 'soundcloud' ? 'bg-[var(--color-src-soundcloud)] text-white' :
            source === 'spotify' ? 'bg-[var(--color-src-spotify)] text-black' :
            'bg-white/20 text-white'
          }`}>
            {source === 'youtube' ? 'YT' : source === 'soundcloud' ? 'SC' : source === 'spotify' ? 'SP' : source}
          </div>
        )}
        {source === 'local' && formatLabel && (
          <div className="absolute top-1.5 left-1.5 md:top-2 md:left-2 max-w-[85%] px-1.5 md:px-2 py-0.5 rounded-md md:rounded-lg text-[9px] md:text-[10px] font-bold uppercase tracking-wide shadow-lg bg-black/65 text-[var(--color-neon-yellow)] border border-white/10 truncate">
            {formatLabel.split(' • ')[0]}
          </div>
        )}
        <div className={`absolute inset-0 bg-[#09090b]/35 md:bg-[#09090b]/45 transition-opacity flex items-center justify-center backdrop-blur-[1px] ${isPlaying ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-active:opacity-100'}`}>
          <motion.div
            layout
            className="w-12 h-12 md:w-14 md:h-14 bg-[var(--color-neon-yellow)] shadow-[0_0_24px_rgba(219,255,0,0.55)] rounded-full flex items-center justify-center border border-white/20"
            animate={isPlaying ? { scale: [1, 1.06, 1] } : { scale: 1 }}
            transition={isPlaying ? { repeat: Infinity, duration: 1.2, ease: 'easeInOut' } : {}}
          >
            {isPlaying ? (
              <div className="flex gap-1 items-center justify-center h-5">
                <div className="w-1 h-3 bg-black animate-pulse" style={{ animationDelay: '0ms' }} />
                <div className="w-1 h-5 bg-black animate-pulse" style={{ animationDelay: '150ms' }} />
                <div className="w-1 h-2 bg-black animate-pulse" style={{ animationDelay: '300ms' }} />
              </div>
            ) : (
              <Play size={22} fill="black" className="text-black ml-0.5 md:ml-1" />
            )}
          </motion.div>
        </div>
      </div>
      <div className="min-w-0 px-0.5">
        <h3 className={`font-display font-bold tracking-tight line-clamp-2 text-[13px] sm:text-base md:text-lg text-white leading-snug ${isPlaying ? 'text-[var(--color-neon-yellow)]' : ''}`}>{stripExtension(title)}</h3>
        <p
          className="text-[11px] md:text-sm text-neutral-400 truncate font-sans mt-0.5 hover:text-[var(--color-neon-yellow)]"
          onClick={(e) => { if (onArtistClick) { e.stopPropagation(); onArtistClick(); } }}
        >{artist}</p>
        {formatLabel && (
          <p className="text-[10px] text-white/35 font-mono tracking-wide mt-0.5 truncate">{formatLabel}</p>
        )}
      </div>
    </motion.div>
  );
}


function ContinueCard({
  track,
  sourceHint,
  onPlay,
}: {
  track: RecentPlay;
  sourceHint?: string;
  onPlay: () => void;
}) {
  const initial = coverSrcForUi(track.artwork_url) || durableArtUrl(track.artwork_url) || '';
  const [art, setArt] = useState(initial);
  const failed = useRef(false);

  useEffect(() => {
    failed.current = false;
    const display = coverSrcForUi(track.artwork_url) || durableArtUrl(track.artwork_url);
    if (display && !isPlaceholderArt(display)) {
      setArt((prev) => {
        if (prev && coversSameAsset(prev, display)) return prev;
        if (prev && isRealArtworkUrl(prev) && !isPlaceholderArt(prev)) {
          void preloadCoverUrl(display).then((ok) => { if (ok) setArt(display); });
          return prev;
        }
        return display;
      });
      return;
    }
    let cancelled = false;
    fetchAlbumArt(track.title, track.artist, track.album).then((url) => {
      if (!cancelled && url && !isPlaceholderArt(url)) setArt(url);
    });
    return () => { cancelled = true; };
  }, [track.id, track.artwork_url, track.title, track.artist, track.album]);

  return (
    <button
      type="button"
      onClick={onPlay}
      className="shrink-0 w-[42vw] max-w-[11rem] sm:w-40 text-left group snap-start flex flex-col"
    >
      <div className="aspect-square rounded-2xl overflow-hidden bg-zinc-800/80 border border-[var(--color-neon-yellow)]/10 mb-2 relative shrink-0">
        <SourceHintBadge source={sourceHint} />
        {art ? (
          <img
            src={art}
            alt=""
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            onError={() => {
              if (failed.current) return;
              failed.current = true;
              fetchAlbumArt(track.title, track.artist, track.album).then((url) => {
                if (url && !isPlaceholderArt(url)) setArt(url);
              });
            }}
          />
        ) : (
          <div className="w-full h-full bg-zinc-800" />
        )}
        <div className="absolute inset-0 bg-black/30 md:bg-black/35 md:opacity-0 md:group-hover:opacity-100 opacity-100 transition-opacity flex items-center justify-center">
          <div className="bg-[var(--color-neon-yellow)] text-black rounded-full p-2.5 md:p-3 shadow-[0_0_20px_rgba(219,255,0,0.35)]">
            <Play size={16} fill="currentColor" className="ml-0.5" />
          </div>
        </div>
      </div>
      {/* Fixed meta height so artist lines align across the row */}
      <div className="min-w-0 px-0.5 h-[3.35rem] flex flex-col justify-start">
        <p className="text-[13px] md:text-sm font-bold text-white line-clamp-2 leading-snug h-[2.5em] group-hover:text-[var(--color-neon-yellow)]">
          {track.title}
        </p>
        <p className="text-[11px] md:text-xs text-[var(--color-ink-faint)] truncate mt-0.5">{track.artist}</p>
      </div>
    </button>
  );
}

function MusicNews({
  onSelect,
  viewMode,
  setViewMode,
  recentPlays = [],
  onPlayRecent,
  onQuickNav,
  news = [],
  loading = false,
  newsCountry = "us",
}: {
  onSelect: (track: NewsTrack) => void;
  viewMode: 'grid' | 'list';
  setViewMode: (mode: 'grid' | 'list') => void;
  recentPlays?: RecentPlay[];
  onPlayRecent?: (track: RecentPlay) => void;
  onQuickNav?: (tab: 'browse' | 'library' | 'liked') => void;
  news?: NewsTrack[];
  loading?: boolean;
  newsCountry?: string;
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-8 home-stagger">
        <div>
          <p className="section-kicker mb-3">NekoBeat</p>
          <h1 className="text-[2.75rem] sm:text-5xl md:text-7xl font-display font-black text-white tracking-tighter leading-[0.9]">Listen</h1>
        </div>
        <div className={viewMode === 'grid' ? "grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 md:gap-6" : "flex flex-col gap-3"}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => <SkeletonTrack key={i} />)}
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex flex-col gap-8 md:gap-12 pb-8 md:pb-32 home-stagger"
    >
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-5 md:gap-8">
        <div className="max-w-xl">
          <p className="section-kicker mb-2 md:mb-3">NekoBeat</p>
          <h1 className="text-[2.75rem] sm:text-5xl md:text-7xl lg:text-8xl font-display font-black text-white tracking-tighter leading-[0.88]">
            Listen
          </h1>
          <p className="text-[var(--color-ink-muted)] mt-3 md:mt-4 font-medium text-sm md:text-lg leading-relaxed max-w-[22rem] md:max-w-none">
            Pick up where you left off — or dive into what’s dropping now.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 md:pb-1">
          <button
            type="button"
            onClick={() => onQuickNav?.('browse')}
            className="px-5 py-2.5 min-h-[44px] rounded-xl bg-[var(--color-neon-yellow)] text-black text-sm font-black uppercase tracking-wider hover:brightness-110 active:scale-[0.98] transition-all shadow-[0_8px_28px_-8px_rgba(219,255,0,0.55)]"
          >
            Find music
          </button>
          <button type="button" onClick={() => onQuickNav?.('library')} className="px-4 py-2.5 min-h-[44px] rounded-xl bg-white/5 border border-white/10 text-sm font-bold text-white hover:border-[var(--color-neon-yellow)]/50 hover:text-[var(--color-neon-yellow)] transition-colors">Library</button>
          <button type="button" onClick={() => onQuickNav?.('liked')} className="px-4 py-2.5 min-h-[44px] rounded-xl bg-white/5 border border-white/10 text-sm font-bold text-white hover:border-[var(--color-neon-yellow)]/50 hover:text-[var(--color-neon-yellow)] transition-colors">Liked</button>
        </div>
      </div>

      {recentPlays.length > 0 && (
        <section className="space-y-3 md:space-y-4">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-xl md:text-3xl font-display font-black text-white tracking-tighter">Continue</h2>
            <p className="text-[10px] md:text-xs font-bold uppercase tracking-widest text-[var(--color-ink-faint)]">Recent</p>
          </div>
          <div className="flex gap-3 md:gap-4 overflow-x-auto no-scrollbar pb-1 -mx-1 px-1 snap-x snap-mandatory items-stretch">
            {recentPlays.map((track) => {
              const src = resolveTrackSource(track.id || track.filepath, track.source);
              return (
                <ContinueCard
                  key={track.id}
                  track={track}
                  sourceHint={src}
                  onPlay={() => onPlayRecent?.(track)}
                />
              );
            })}
          </div>
        </section>
      )}

      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 md:gap-6">
        <div>
          <p className="section-kicker mb-2">Fresh</p>
          <h2 className="text-2xl md:text-4xl font-display font-black text-white tracking-tighter leading-none">New releases</h2>
          <p className="text-[var(--color-ink-muted)] mt-2 font-medium text-sm max-w-md">
            {newsCountry.toUpperCase()} charts + global Last.fm
            {newsCountry === "in" ? " (incl. JioSaavn)" : ""} — tap a cover to match in Browse.
          </p>
        </div>
        <ViewToggle viewMode={viewMode} onChange={setViewMode} />
      </div>

      {news.length === 0 ? (
        <div className="py-16 px-6 text-center space-y-5 border border-dashed border-[var(--color-neon-yellow)]/20 rounded-3xl bg-[var(--color-neon-yellow)]/[0.03]">
          <p className="text-lg font-display font-bold text-white">Nothing new to show yet</p>
          <p className="text-sm text-[var(--color-ink-muted)] max-w-sm mx-auto">Search YouTube, SoundCloud, or Spotify — or open Browse to find a track.</p>
          <button type="button" onClick={() => onQuickNav?.('browse')} className="px-5 py-2.5 rounded-xl bg-[var(--color-neon-yellow)] text-black font-black text-sm uppercase tracking-wider">Find music</button>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4 md:gap-6">
          {news.map((track, i) => {
            const badge = newsSourceBadge(track);
            return (
            <motion.div
              key={`${track.source}-${track.title}-${track.artist}-${track.release_date}-${i}`}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: Math.min(i * 0.02, 0.4), type: "spring", stiffness: 300, damping: 25 }}
              whileHover={{ y: -6 }}
              onClick={() => onSelect(track)}
              className="group cursor-pointer flex flex-col gap-2 md:gap-3"
            >
              <div className="aspect-square rounded-xl md:rounded-[2rem] bg-zinc-800/30 overflow-hidden relative border border-white/10 transition-all duration-300 shadow-xl group-hover:shadow-2xl group-hover:border-white/20">
                <img src={track.artwork_url || logoImg} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" alt={track.title} />
                {badge && (
                  <span className="absolute top-2 left-2 z-10 text-[9px] font-black uppercase tracking-wider text-black bg-[var(--color-neon-yellow)] px-1.5 py-0.5 rounded-md shadow-md">
                    {badge}
                  </span>
                )}
                <div className="absolute inset-0 bg-black/25 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <div className="bg-[var(--color-neon-yellow)] text-black rounded-full p-3 md:hidden shadow-[0_0_18px_rgba(219,255,0,0.4)]">
                    <Play size={16} fill="currentColor" className="ml-0.5" />
                  </div>
                  <div className="hidden md:flex bg-[var(--color-neon-yellow)] text-black font-black px-6 py-2.5 rounded-2xl text-xs uppercase tracking-widest shadow-2xl scale-90 group-hover:scale-100 transition-transform items-center gap-2">
                    <Play size={14} fill="currentColor" /> Play
                  </div>
                </div>
              </div>
              <div className="px-0.5 min-w-0">
                <h3 className="font-display font-bold tracking-tight line-clamp-2 text-[13px] sm:text-base md:text-lg text-white leading-snug group-hover:text-[var(--color-neon-yellow)] transition-colors">{track.title}</h3>
                <p className="text-[11px] md:text-sm text-neutral-400 truncate font-sans font-medium mt-0.5">{track.artist}</p>
                <p className="text-[10px] text-[var(--color-neon-yellow)] font-black uppercase tracking-widest opacity-90 mt-0.5 truncate">{track.release_date}</p>
              </div>
            </motion.div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-2 md:gap-3">
          {news.map((track, i) => {
            const badge = newsSourceBadge(track);
            return (
            <motion.div
              key={`${track.source}-${track.title}-${track.artist}-${track.release_date}-${i}`}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: Math.min(i * 0.01, 0.3) }}
              onClick={() => onSelect(track)}
              className="group flex items-center gap-3 md:gap-4 p-2.5 md:p-3 rounded-2xl bg-zinc-900/20 hover:bg-white/5 border border-transparent hover:border-white/10 transition-all cursor-pointer relative min-h-[64px]"
            >
              <div className="w-14 h-14 md:w-16 md:h-16 rounded-xl md:rounded-2xl overflow-hidden shrink-0 relative bg-zinc-800">
                <img src={track.artwork_url || logoImg} className="w-full h-full object-cover" alt={track.title} />
                {badge && (
                  <span className="absolute bottom-1 left-1 text-[8px] font-black uppercase tracking-wider text-black bg-[var(--color-neon-yellow)] px-1 py-0.5 rounded">
                    {badge}
                  </span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-black text-white truncate text-sm md:text-base group-hover:text-[var(--color-neon-yellow)] transition-colors">{track.title}</h4>
                <div className="flex items-center gap-2 min-w-0">
                  <p className="text-xs text-white/50 tracking-wide font-medium truncate">{track.artist}</p>
                  <span className="w-1 h-1 rounded-full bg-white/20 shrink-0 hidden sm:block" />
                  <p className="text-[10px] text-[var(--color-neon-yellow)] font-bold uppercase tracking-widest shrink-0 hidden sm:block">{track.release_date}</p>
                </div>
              </div>
              <div className="bg-[var(--color-neon-yellow)] text-black rounded-full p-2.5 shrink-0 md:rounded-xl md:px-4 md:py-2 md:font-black md:text-[10px] md:uppercase md:tracking-widest flex items-center gap-1">
                <Play size={14} fill="currentColor" className="ml-0.5 md:ml-0" />
                <span className="hidden md:inline">Play</span>
              </div>
            </motion.div>
            );
          })}
        </div>
      )}
    </motion.div>
  );
}

export default App;
