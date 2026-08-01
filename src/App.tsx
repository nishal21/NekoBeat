import { useState, useEffect, useRef, useCallback, memo } from "react";
import { Play, Pause, SkipForward, SkipBack, Search, Home, Library, Settings, FolderOpen, ChevronDown, Maximize2, Minimize2, ListMusic, Heart, LayoutGrid, List, Volume2, VolumeX, Download, MonitorPlay, GripVertical, Repeat, ArrowUp, ArrowDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useAudioPlayer, useLibrary, fetchAlbumArt, fetchLyrics, LyricsData, useAggregatorSearch, AggregatedTrack, useLikedLibrary, useEqualizer, EQ_PRESETS, useAudioClock, getAudioClock, seedAudioClockDuration, isResumeGuarded, isRealArtworkUrl, toDisplayArtUrl, usePlayQueue, QueueTrack } from "./hooks";
// Used for interacting with system dialogs in Tauri
import { open } from "@tauri-apps/plugin-dialog";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { check } from "@tauri-apps/plugin-updater";
import logoImg from "./assets/logo.png";

type RecentPlay = {
  id: string;
  title: string;
  artist: string;
  artwork_url: string;
  source?: string;
  stream_url?: string;
  filepath?: string;
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

/** Only persist durable http(s) cover URLs — asset:// / local paths break after reload. */
function durableArtUrl(url?: string | null): string {
  const u = (url || '').trim();
  if (/^https?:\/\//i.test(u) && !u.includes('picsum')) return u;
  return '';
}

const placeholderArt = (_seed?: string) => logoImg;

// Hook for mouse-drag horizontal scrolling on non-touch devices
function useDragScroll() {
  const ref = useRef<HTMLDivElement>(null);
  const state = useRef({ isDown: false, startX: 0, scrollLeft: 0 });

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    state.current = { isDown: true, startX: e.pageX - el.offsetLeft, scrollLeft: el.scrollLeft };
    el.style.cursor = 'grabbing';
    el.style.userSelect = 'none';
  }, []);

  const onMouseUp = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    state.current.isDown = false;
    el.style.cursor = 'grab';
    el.style.userSelect = '';
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!state.current.isDown || !ref.current) return;
    e.preventDefault();
    const x = e.pageX - ref.current.offsetLeft;
    ref.current.scrollLeft = state.current.scrollLeft - (x - state.current.startX);
  }, []);

  const onMouseLeave = useCallback(() => {
    if (!ref.current) return;
    state.current.isDown = false;
    ref.current.style.cursor = 'grab';
    ref.current.style.userSelect = '';
  }, []);

  return { ref, onMouseDown, onMouseUp, onMouseMove, onMouseLeave };
}

// Provide a stable time formatter outside of renders
const formatTime = (ms: number) => {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const stripExtension = (title: string) => {
  return title.replace(/\.(mp3|flac|wav|m4a|ogg)$/i, '');
};

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
        onPointerCancel={() => { dragging.current = false; setDragPct(null); }}
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

/** Volume: horizontal slider on touch/expanded; hover flyout still works on desktop chrome. */
const VolumeControl = memo(({ volume, onChange, alwaysShow = false }: { volume: number, onChange: (v: number) => void, alwaysShow?: boolean }) => {
  const [open, setOpen] = useState(false);
  const showSlider = alwaysShow || open;
  const volSpring = { type: "spring" as const, stiffness: 420, damping: 32, mass: 0.6 };

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
          aria-label={volume === 0 ? 'Unmute' : 'Mute'}
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

  return (
    <div
      className="relative flex items-center justify-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <AnimatePresence>
        {showSlider && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 flex flex-col items-center justify-center w-14 h-44 bg-zinc-900/95 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl z-[80] py-3 pointer-events-auto"
            // Invisible bridge so moving from icon → slider doesn't close
            style={{ paddingBottom: 0 }}
          >
            {/* hit-area bridge into the button */}
            <div className="absolute -bottom-3 left-0 right-0 h-3" aria-hidden />
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
                style={{ appearance: 'slider-vertical' } as any}
                aria-label="Volume"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        type="button"
        whileTap={{ scale: 0.88 }}
        className="text-neutral-400 hover:text-white transition-colors p-2 min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-white/5 rounded-full"
        onClick={() => {
          // Touch / click: toggle popover; second tap on icon mutes when already open
          if (open) onChange(volume === 0 ? 0.7 : 0);
          else setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        aria-label={volume === 0 ? 'Unmute' : 'Volume'}
        aria-expanded={open}
      >
        {VolumeIcon}
      </motion.button>
    </div>
  );
});

const LyricsDisplay = memo(({ parsedLyrics, hasPlainLyrics, plainLyricsText, lyricsOffsetMs, onOffsetChange, onUploadLyrics }: { parsedLyrics: { timeMs: number, text: string }[], hasPlainLyrics: boolean, plainLyricsText?: string, lyricsOffsetMs: number, onOffsetChange: (offset: number) => void, onUploadLyrics?: () => void }) => {
  const { positionMs } = useAudioClock();
  let activeLyricIndex = -1;
  const adjustedPositionMs = positionMs - lyricsOffsetMs;
  for (let i = 0; i < parsedLyrics.length; i++) {
    if (adjustedPositionMs >= parsedLyrics[i].timeMs) {
      activeLyricIndex = i;
    } else {
      break;
    }
  }

  // Smoothly scroll the active lyric into the center of the mask
  useEffect(() => {
    if (activeLyricIndex >= 0 && parsedLyrics.length > 0) {
      const activeLine = document.getElementById(`lyric-${activeLyricIndex}`);
      if (activeLine) {
        activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [activeLyricIndex, parsedLyrics.length]);

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
        <div className="flex flex-col gap-6 md:gap-10">
          {parsedLyrics.map((line, ix) => {
            const isActive = ix === activeLyricIndex;

            return (
              <div
                key={ix}
                id={`lyric-${ix}`}
                className={`px-2 py-1 transition-all duration-500 ease-out origin-left will-change-[transform,opacity]
                  ${isActive ? 'scale-105 opacity-100' : 'scale-100 opacity-20'}`}
              >
                <p className={`text-2xl md:text-5xl font-lyrics font-black tracking-tight leading-tight transition-colors duration-500
                  ${isActive ? 'liquid-neon-text' : 'text-white'}`}>
                  {line.text}
                </p>
              </div>
            );
          })}
        </div>
      ) : hasPlainLyrics && plainLyricsText ? (
        <div className="flex flex-col gap-4 py-8">
          <p className="text-sm font-bold text-[var(--color-neon-yellow)] tracking-widest uppercase mb-4 opacity-80">Unsynchronized Lyrics</p>
          {plainLyricsText.split('\n').map((line, ix) => (
            <div key={ix} className="px-2 py-1">
              <p className={`text-2xl md:text-4xl font-lyrics font-bold tracking-tight leading-tight text-white/80`}>
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
    <div className="inline-flex items-center gap-1 bg-white/5 p-1 rounded-xl border border-white/10 shrink-0 self-start">
      <button
        type="button"
        onClick={() => onChange('grid')}
        className={`p-2.5 md:p-1.5 min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 rounded-lg transition-all flex items-center justify-center ${viewMode === 'grid' ? 'bg-[var(--color-neon-yellow)] text-black' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}
        title="Grid View"
        aria-label="Grid view"
        aria-pressed={viewMode === 'grid'}
      >
        <LayoutGrid size={18} />
      </button>
      <button
        type="button"
        onClick={() => onChange('list')}
        className={`p-2.5 md:p-1.5 min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 rounded-lg transition-all flex items-center justify-center ${viewMode === 'list' ? 'bg-[var(--color-neon-yellow)] text-black' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}
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

  // References for global media keys
  const onTogglePlayRef = useRef<any>(null);
  const onNextRef = useRef<any>(null);
  const onPrevRef = useRef<any>(null);

  const [showMobileLyrics, setShowMobileLyrics] = useState(false);
  const [videoMode, setVideoMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('nekobeat_video_mode');
    return saved ? JSON.parse(saved) : false;
  });

  const { tracks, isScanning, scanDirectory, clearLibrary } = useLibrary();
  const { results: searchResults, isLoading: isSearching, isLoadingMore, hasMore, search: performSearch, loadMore, sourceErrors, error: searchError } = useAggregatorSearch();
  const { likedTracks, isLiking, toggleLike } = useLikedLibrary();
  const playQueue = usePlayQueue();
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
  const resumePlaybackRef = useRef(resumePlayback);
  resumePlaybackRef.current = resumePlayback;

  const [coverArt, setCoverArt] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [lyricsOffsetMs, setLyricsOffsetMs] = useState(0);
  const [lyricsData, setLyricsData] = useState<LyricsData | null>(null);
  const [parsedLyrics, setParsedLyrics] = useState<{ timeMs: number, text: string }[]>([]);
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
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{ version: string, date?: string, body?: string } | null>(null);
  const [streamError, setStreamError] = useState<{ message: string, trackTitle?: string, trackArtist?: string, source?: string, previewUrl?: string } | null>(null);

  // Auto-Updater Check
  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const update = await check();
        if (update) {
          console.log(`Update available: ${update.version}`);
          setUpdateInfo({
            version: update.version,
            date: update.date,
            body: update.body
          });
        }
      } catch (e) {
        console.error("Failed to check for updates:", e);
      }
    };
    // Check for updates on startup with a slight delay
    const timer = setTimeout(checkUpdate, 3000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem('nekobeat_auto_loop_liked', JSON.stringify(autoLoopLiked));
  }, [autoLoopLiked]);

  useEffect(() => {
    localStorage.setItem('nekobeat_view_mode', viewMode);
  }, [viewMode]);

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

  // Single music news fetch (Listen home + Browse idle strip)
  const [browseNewsLoading, setBrowseNewsLoading] = useState(true);
  useEffect(() => {
    invoke<NewsTrack[]>('get_music_news')
      .then((data) => {
        setBrowseNews(data);
        setBrowseNewsLoading(false);
      })
      .catch(() => {
        setBrowseNewsLoading(false);
      });
  }, []);

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
  let playerTrack = currentTrack;
  if (externalTrack && currentTrackPath) {
    playerTrack = externalTrack;
  }

  // Persist recent plays + push current track into Continue row
  useEffect(() => {
    if (!playerTrack || !isPlaying) return;
    const likedHit = likedTracks.find((t) => t.id === (playerTrack.id || ''));
    const art =
      durableArtUrl(playerTrack.artwork_url) ||
      durableArtUrl(likedHit?.artwork_url) ||
      durableArtUrl(coverArt);
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

  // Fallback: fetch metadata/artwork from Last.fm only when cover is still missing
  useEffect(() => {
    async function fetchLastfmMeta() {
      if (!playerTrack) return;
      if (isRealArtworkUrl(playerTrack.artwork_url) || isRealArtworkUrl(coverArt)) return;
      if (playerTrack.artwork_url && !playerTrack.artwork_url.includes('picsum')) return;
      try {
        const apiKey = '8c6cd0f902d698cec247211d0aaef717';
        const url = `https://ws.audioscrobbler.com/2.0/?method=track.getInfo&api_key=${apiKey}&artist=${encodeURIComponent(playerTrack.artist)}&track=${encodeURIComponent(playerTrack.title)}&format=json`;
        const res = await fetch(url);
        const data = await res.json();
        if (data && data.track && data.track.album && data.track.album.image) {
          const img = data.track.album.image.find((i: any) => i.size === 'extralarge')?.['#text'] || '';
          if (img) setCoverArt(img);
        }
      } catch (e) {
        // Ignore errors
      }
    }
    fetchLastfmMeta();
  }, [playerTrack?.id, playerTrack?.filepath, coverArt]);

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
    setCoverArt(track.artwork_url);
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
    const timeReg = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;

    for (const line of lines) {
      const match = timeReg.exec(line);
      if (match) {
        const m = parseInt(match[1]);
        const s = parseInt(match[2]);
        const msStr = match[3].length === 2 ? match[3] + '0' : match[3];
        const ms = parseInt(msStr);
        const timeMs = (m * 60 * 1000) + (s * 1000) + ms;
        const text = line.replace(timeReg, '').trim();
        if (text) {
          result.push({ timeMs, text });
        }
      }
    }
    return result;
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
    opts?: { skipQueueRebuild?: boolean },
  ) => {
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
          artwork_url: (t.artwork_url && /^https?:\/\//i.test(t.artwork_url))
            ? t.artwork_url
            : (toDisplayArtUrl(t.artwork_url, t.local_artwork_path) || t.artwork_url || ''),
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
      toDisplayArtUrl(
        track.artwork_url || likedMeta?.artwork_url,
        // Only use local art when remote CDN art is missing
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
      try {
        await playTrack(localPath, track.id);
        if (requestId !== playRequestRef.current) return;
        setStreamError(null);
        return;
      } catch (e) {
        console.error("Failed to play local liked track, falling back to stream:", e);
        if (requestId !== playRequestRef.current) return;
        setStreamError({
          message: `Offline file missing for "${track.title}". Re-download from Liked or stream again.`,
          trackTitle: track.title,
          trackArtist: track.artist,
          source: track.source,
        });
      }
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
    const resolvedUrl = await streamExternalAudio(
      playbackUrl,
      track.source,
      track.id,
      track.title,
      track.artist,
    );
    if (requestId !== playRequestRef.current) return;
    if (resolvedUrl) {
      if (requestId !== playRequestRef.current) return;
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
            ? `Failed to play "${trackTitle}" from Spotify. Check spotiflac-cli sidecar / network.`
            : `Failed to stream "${trackTitle}". The track may be unavailable.`,
        trackTitle,
        trackArtist,
        source: track.source
      });
      setTimeout(() => setStreamError(null), 12000);
    }
  };

  // Clear externalTrack when playing a local track
  const handlePlayLocalTrack = (filepath: string) => {
    setExternalTrack(null);
    playTrack(filepath);
  };

  // Unified next/prev — prefer explicit play queue
  const handleNextTrack = () => {
    const next = playQueue.advance(autoLoopLiked && externalTrack?.playbackContext === 'liked');
    if (next) {
      handleStreamExternalAudio(
        { ...next, stream_url: next.stream_url || getTrackPlaybackUrl(next) },
        next.playbackContext === 'liked' ? 'liked' : 'search',
        { skipQueueRebuild: true },
      );
      setCoverArt(next.artwork_url);
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
          setCoverArt(n.artwork_url);
        } else if (autoLoopLiked && isLikedContext && playlist.length > 1) {
          const first: any = playlist[0];
          handleStreamExternalAudio({...first, stream_url: getTrackPlaybackUrl(first)}, 'liked');
          setCoverArt(first.artwork_url);
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
      handleStreamExternalAudio(
        { ...prev, stream_url: prev.stream_url || getTrackPlaybackUrl(prev) },
        prev.playbackContext === 'liked' ? 'liked' : 'search',
        { skipQueueRebuild: true },
      );
      setCoverArt(prev.artwork_url);
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
          setCoverArt(p.artwork_url);
        }
      } else {
        playPrev(tracks);
      }
    } else {
      playPrev(tracks);
    }
  };

  onNextRef.current = handleNextTrack;
  onPrevRef.current = handlePrevTrack;
  onTogglePlayRef.current = () => togglePause();

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
      const localArt = (playerTrack as any).local_artwork_path as string | undefined;
      const remoteArt = playerTrack.artwork_url;
      const displayArt = toDisplayArtUrl(
        remoteArt,
        (remoteArt && /^https?:\/\//i.test(remoteArt)) ? undefined : localArt,
      );
      const hasArt = !!(displayArt && (
        /^https?:\/\//i.test(displayArt) ||
        displayArt.startsWith('asset:') ||
        displayArt.startsWith('blob:') ||
        isRealArtworkUrl(remoteArt) ||
        isRealArtworkUrl(localArt)
      ));
      setCoverArt(hasArt && displayArt ? displayArt : placeholderArt(playerTrack.title));

      // Seed progress duration from metadata so the thumb can move before GST reports length
      if (playerTrack.duration_ms && playerTrack.duration_ms > 0) {
        seedAudioClockDuration(playerTrack.duration_ms);
      } else if (durationMs > 0) {
        seedAudioClockDuration(durationMs);
      }

      // Only hit iTunes when artwork is missing / placeholder (skip when we have offline art)
      if (!hasArt) {
        fetchAlbumArt(playerTrack.title, playerTrack.artist).then(url => {
          if (!stale && url) setCoverArt(url);
        });
      }

      // Apply local lyrics immediately; network only if missing
      const localLyrics = playerTrack.local_lyrics as string | undefined;
      const localIsSynced = !!(localLyrics && localLyrics.trim().startsWith('['));
      if (localIsSynced && localLyrics) {
        setParsedLyrics(parseLrc(localLyrics));
        setLyricsData({ syncedLyrics: localLyrics, source: 'local' });
      } else if (localLyrics && !localIsSynced) {
        setParsedLyrics([]);
        setLyricsData({ plainLyrics: localLyrics, source: 'local' });
      } else {
        setLyricsData(null);
        setParsedLyrics([]);
      }

      const trackKey = playerTrack.id || playerTrack.filepath || currentTrackPath;
      let savedOffset = 0;
      if (trackKey) {
        try {
          const stored = JSON.parse(localStorage.getItem('nekobeat_lyrics_offsets') || '{}');
          if (typeof stored[trackKey] === 'number') savedOffset = stored[trackKey];
        } catch { }
      }
      setLyricsOffsetMs(savedOffset);

      if (!localLyrics) {
        let spotifyId = undefined;
        if (playerTrack.source === 'spotify' || (playerTrack as any).id?.startsWith('sp-')) {
          let rawId = (playerTrack as any).id.replace('sp-', '');
          const match = rawId.match(/track\/([a-zA-Z0-9]+)/);
          if (match) {
            spotifyId = match[1];
          } else {
            spotifyId = rawId;
          }
        }

        fetchLyrics(playerTrack.title, playerTrack.artist, playerTrack.album, durationMs || playerTrack.duration_ms, spotifyId).then(data => {
          if (stale) return;
          setLyricsData(data);
          if (data && data.syncedLyrics) {
            setParsedLyrics(parseLrc(data.syncedLyrics));
          } else {
            setParsedLyrics([]);
          }
          // Persist lyrics onto liked registry for next offline play
          const text = data?.syncedLyrics || data?.plainLyrics;
          if (text && ((playerTrack as any).playbackContext === 'liked' || likedTracks.some(t => t.id === playerTrack.id))) {
            invoke('update_track_lyrics', {
              trackId: playerTrack.id,
              filepath: null,
              lyrics: text,
            }).catch(() => { /* non-fatal */ });
          }
        });
      }
    } else {
      setCoverArt(null);
      setLyricsData(null);
      setParsedLyrics([]);
    }
    return () => { stale = true; };
  }, [playerTrack?.id, playerTrack?.filepath, currentTrackPath]);

  // MediaSession action handlers — bind once; always call latest via refs.
  // Critical: MediaPlayPause also hits the global shortcut; resume guard + explicit
  // play/pause (never toggle) prevents Resume→immediate Pause.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play', () => {
      if (!isPlayingRef.current) resumePlaybackRef.current();
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
    return () => {
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
      navigator.mediaSession.setActionHandler('previoustrack', null);
      navigator.mediaSession.setActionHandler('nexttrack', null);
    };
  }, []);

  // Sync MediaSession metadata + SMTC silent wake (track/art only — not every clock tick)
  useEffect(() => {
    if (!('mediaSession' in navigator) || !playerTrack) return;
    try {
      const artworkUrl = playerTrack.artwork_url?.startsWith('http')
        ? playerTrack.artwork_url
        : (playerTrack.artwork_url ? convertFileSrc(playerTrack.artwork_url) : (coverArt || convertFileSrc(logoImg)));

      navigator.mediaSession.metadata = new MediaMetadata({
        title: stripExtension(playerTrack.title),
        artist: playerTrack.artist,
        album: 'NekoBeat',
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
  }, [playerTrack?.id, playerTrack?.title, playerTrack?.artist, playerTrack?.artwork_url, coverArt, isPlaying]);

  // Position state for lock screen — throttled, no silent-audio / handler rebind
  useEffect(() => {
    if (!('mediaSession' in navigator) || !playerTrack || durationMs <= 0) return;
    if (!('setPositionState' in navigator.mediaSession)) return;
    const id = setInterval(() => {
      if (!isPlayingRef.current) return;
      const pos = getAudioClock().positionMs;
      try {
        navigator.mediaSession.setPositionState({
          duration: durationMs / 1000,
          playbackRate: 1,
          position: Math.min(pos / 1000, durationMs / 1000),
        });
      } catch { /* invalid position state — ignore */ }
    }, 1000);
    return () => clearInterval(id);
  }, [playerTrack?.id, durationMs]);

  // Find active lyric index — handled inside LyricsDisplay via useAudioClock

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
    const q = (artist || '').trim();
    if (!q) return;
    setPendingAutoplayQuery(null);
    setSearchQuery(q);
    setSearchSource('all');
    setActiveTab('browse');
    setIsExpanded(false);
  };

  const handleScanClick = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
    });
    if (selected) {
      await scanDirectory(selected as string);
    }
  };

  const isLocalSynced = playerTrack?.local_lyrics && playerTrack.local_lyrics.trim().startsWith('[');
  const hasPlainLyrics = !!lyricsData?.plainLyrics || (!!playerTrack?.local_lyrics && !isLocalSynced);
  const plainLyricsText = (playerTrack?.local_lyrics && !isLocalSynced) ? playerTrack.local_lyrics : lyricsData?.plainLyrics;

  if (isMiniplayerMode) {
    return (
      <div 
        onMouseDown={(e) => {
          if (e.button === 0) { // Left click
            getCurrentWindow().startDragging();
          }
        }}
        className="w-full h-screen bg-[#09090b]/90 backdrop-blur-3xl flex items-center p-4 gap-4 border border-white/10 rounded-2xl overflow-hidden shadow-2xl cursor-default select-none group/pip"
        style={{
          backgroundImage: `url('${playerTrack?.artwork_url || coverArt || ""}')`,
          backgroundSize: "cover",
          backgroundPosition: "center"
        }}
      >
        <div data-tauri-drag-region className="absolute inset-0 bg-black/70 backdrop-blur-[80px]" />
        
        <div data-tauri-drag-region className="relative w-24 h-24 rounded-2xl overflow-hidden shrink-0 shadow-2xl border border-white/10">
          {(playerTrack?.artwork_url || coverArt) ? (
            <img data-tauri-drag-region src={playerTrack?.artwork_url || coverArt || ""} className="w-full h-full object-cover" alt="Cover" />
          ) : (
            <div data-tauri-drag-region className="w-full h-full bg-neutral-800 flex items-center justify-center">
              <ListMusic size={28} className="text-neutral-500" />
            </div>
          )}
        </div>
        
        <div data-tauri-drag-region className="relative flex flex-col flex-1 min-w-0 justify-center h-full">
          <div data-tauri-drag-region className="mb-2">
            <p data-tauri-drag-region className="text-white font-black text-base truncate w-full pr-8 drop-shadow-md">{playerTrack ? stripExtension(playerTrack.title) : "No track playing"}</p>
            <p data-tauri-drag-region className="text-[var(--color-neon-yellow)] text-xs font-bold uppercase tracking-widest truncate w-full opacity-80">{playerTrack?.artist || "Nekobeat"}</p>
          </div>
          
          <div className="flex items-center gap-4">
            <button 
              onMouseDown={(e) => e.stopPropagation()}
              onClick={handlePrevTrack} 
              disabled={!currentTrackPath} 
              className="text-white/60 hover:text-white p-1.5 rounded-full hover:bg-white/10 transition-all active:scale-90"
            >
              <SkipBack size={18} fill="currentColor" />
            </button>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={togglePause}
              disabled={!currentTrackPath}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${isBuffering ? 'bg-[var(--color-neon-yellow)]/30 animate-pulse' : 'bg-[var(--color-neon-yellow)] text-black shadow-lg hover:scale-110 active:scale-95'}`}
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
              onMouseDown={(e) => e.stopPropagation()}
              onClick={handleNextTrack} 
              disabled={!currentTrackPath} 
              className="text-white/60 hover:text-white p-1.5 rounded-full hover:bg-white/10 transition-all active:scale-90"
            >
              <SkipForward size={18} fill="currentColor" />
            </button>
          </div>
        </div>
        
        <button 
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            toggleMiniplayerMode();
          }} 
          className="absolute top-3 right-3 text-white/40 hover:text-white p-2 rounded-xl hover:bg-white/10 transition-all z-[100] backdrop-blur-md"
          title="Expand"
        >
          <Maximize2 size={16} />
        </button>
      </div>
    );
  }

  const handleUpdate = async () => {
    if (!updateInfo) return;
    try {
      // Find the update again to get the update object
      const update = await check();
      if (update) {
        console.log("Downloading and installing update...");
        await update.downloadAndInstall();
      }
    } catch (e) {
      console.error("Update failed:", e);
    }
  };

  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-[var(--color-surface-base)] text-white overflow-hidden font-sans select-none relative main-container">
      {/* Update Toast */}
      <AnimatePresence>
        {updateInfo && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 50, scale: 0.9 }}
            className="fixed bottom-24 right-8 z-[100] bg-zinc-900/40 backdrop-blur-3xl border border-[var(--color-neon-yellow)]/30 p-6 rounded-3xl shadow-[0_20px_50px_rgba(0,0,0,0.5)] max-w-sm"
          >
            <div className="flex items-start gap-4">
              <div className="bg-[var(--color-neon-yellow)]/10 p-3 rounded-2xl">
                <Download className="text-[var(--color-neon-yellow)]" size={24} />
              </div>
              <div className="flex-1">
                <h4 className="text-lg font-black text-white leading-tight">New Sonic Update!</h4>
                <p className="text-sm text-neutral-400 mt-1">Version {updateInfo.version} is ready to drop.</p>
                <div className="flex items-center gap-3 mt-4">
                  <button
                    onClick={handleUpdate}
                    className="bg-[var(--color-neon-yellow)] text-black px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest hover:scale-105 active:scale-95 transition-all shadow-[0_0_20px_rgba(219,255,0,0.3)]"
                  >
                    Install Now
                  </button>
                  <button
                    onClick={() => setUpdateInfo(null)}
                    className="text-neutral-500 hover:text-white text-xs font-bold px-2 py-1"
                  >
                    Later
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
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
          backgroundImage: `radial-gradient(circle at 50% 50%, rgba(255,255,255,0.1), transparent 70%), url('${playerTrack?.artwork_url || coverArt || "https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=2000&auto=format&fit=crop"}')`,
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
          <NavItem icon={<Home size={22} />} label="Listen" active={activeTab === 'listen'} onClick={() => setActiveTab('listen')} />
          <NavItem icon={<Search size={22} />} label="Browse" active={activeTab === 'browse'} onClick={() => setActiveTab('browse')} />
          <NavItem icon={<Library size={22} />} label="Library" active={activeTab === 'library'} onClick={() => setActiveTab('library')} />
          <NavItem icon={<Heart size={22} />} label="Liked Songs" active={activeTab === 'liked'} onClick={() => setActiveTab('liked')} />
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
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 md:gap-6 mb-6 md:mb-8">
                <h1 className="text-3xl sm:text-4xl md:text-5xl font-display font-black text-white tracking-tighter leading-none">Your Library</h1>
                <div className="flex items-center gap-3">
                  <ViewToggle viewMode={viewMode} onChange={setViewMode} />
                  <button
                    onClick={handleScanClick}
                    disabled={isScanning}
                    className="flex-1 md:flex-none flex items-center justify-center gap-2 px-5 py-3 bg-gradient-to-b from-[var(--color-neon-yellow)] to-[#c4e600] text-black rounded-xl transition-all font-bold text-sm disabled:opacity-50 shadow-[inset_0_2px_4px_rgba(255,255,255,0.6),0_10px_30px_rgba(219,255,0,0.4)] hover:shadow-[inset_0_2px_4px_rgba(255,255,255,0.6),0_15px_40px_rgba(219,255,0,0.6)] hover:-translate-y-1"
                  >
                    <FolderOpen size={16} />
                    <span>{isScanning ? "Scanning folder…" : "Add folder"}</span>
                  </button>
                </div>
              </div>

              {tracks.length === 0 ? (
                <div className="py-20 px-6 text-center max-w-md mx-auto space-y-4">
                  <Library size={48} className="mx-auto mb-2 text-[var(--color-neon-yellow)]/70" />
                  <h2 className="text-xl font-display font-black text-white tracking-tight">Your library is empty</h2>
                  <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed">Add a folder of MP3, FLAC, or WAV files to play offline from this device.</p>
                  <button
                    onClick={handleScanClick}
                    disabled={isScanning}
                    className="inline-flex items-center justify-center gap-2 px-5 py-3 bg-[var(--color-neon-yellow)] text-black rounded-xl font-bold text-sm disabled:opacity-50"
                  >
                    <FolderOpen size={16} />
                    {isScanning ? "Scanning folder…" : "Add a music folder"}
                  </button>
                </div>
              ) : viewMode === 'grid' ? (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4 md:gap-6">
                  {tracks.map((track, i) => (
                    <AlbumCard
                      key={track.filepath}
                      index={i}
                      title={track.title}
                      artist={track.artist}
                      artworkUrl={track.artwork_url}
                      onClick={() => (!track.source || track.source === 'local') ? handlePlayLocalTrack(track.filepath) : handleStreamExternalAudio(track)}
                      isPlaying={currentTrackPath === track.filepath && isPlaying}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {tracks.map((track) => (
                    <TrackResult
                      key={track.filepath}
                      track={{
                        id: track.id || track.filepath,
                        title: track.title,
                        artist: track.artist,
                        album: track.album,
                        duration_ms: track.duration_ms,
                        artwork_url: track.artwork_url || placeholderArt(track.title),
                        source: track.source || 'local',
                        stream_url: track.filepath
                      }}
                      onPlay={() => (!track.source || track.source === 'local') ? handlePlayLocalTrack(track.filepath) : handleStreamExternalAudio(track)}
                      currentTrackId={currentTrackPath}
                      isCurrentlyPlaying={isPlaying && currentTrackPath === track.filepath}
                    />
                  ))}
                </div>
              )}
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
                  <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed">Tap the heart on any track while it plays — liked songs show up here for quick replay.</p>
                  <button
                    type="button"
                    onClick={() => setActiveTab('browse')}
                    className="inline-flex px-5 py-2.5 rounded-xl bg-[var(--color-neon-yellow)] text-black font-black text-sm uppercase tracking-wider"
                  >
                    Find music to like
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
                      artworkUrl={
                        (track.artwork_url && /^https?:\/\//i.test(track.artwork_url))
                          ? track.artwork_url
                          : (toDisplayArtUrl(track.artwork_url, track.local_artwork_path) || track.artwork_url)
                      }
                      source={track.source}
                      onClick={() => handleStreamExternalAudio(track, 'liked')}
                      isPlaying={playerTrack?.id === track.id && isPlaying}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {likedTracks.map((track) => (
                    <TrackResult key={track.id} track={{
                      ...track,
                      artwork_url:
                        (track.artwork_url && /^https?:\/\//i.test(track.artwork_url))
                          ? track.artwork_url
                          : (toDisplayArtUrl(track.artwork_url, track.local_artwork_path) || track.artwork_url),
                    } as any} onPlay={() => handleStreamExternalAudio(track, 'liked')} currentTrackId={playerTrack?.id || null} isCurrentlyPlaying={isPlaying} />
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
                        <span key={src} className="text-xs text-amber-200/90 bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 rounded-lg capitalize">
                          {src}: {msg.replace(/^Error:\s*/i, '').slice(0, 80)}
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
                            artworkUrl={track.artwork_url}
                            source={track.source}
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
                              setCoverArt(track.artwork_url);
                            }}
                            isPlaying={(playerTrack?.id || currentTrackPath) === track.id && isPlaying}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3">
                        {searchResults.map(track => (
                          <TrackResult key={track.id} track={track} onPlay={(track) => {
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
                            setCoverArt(track.artwork_url);
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
                  onClick={() => setActiveTab('listen')}
                  className="md:hidden inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[var(--color-ink-muted)] hover:text-[var(--color-neon-yellow)] min-h-[40px] -ml-1 px-1"
                >
                  <ChevronDown className="rotate-90" size={16} />
                  Back
                </button>
                <p className="section-kicker">Preferences</p>
                <h2 className="text-2xl sm:text-3xl font-display font-black text-white tracking-tight">Settings</h2>
                <p className="text-sm text-[var(--color-ink-muted)] max-w-xl">
                  Sources, sound, and playback — tuned for phone, tablet, and desktop.
                </p>
              </header>

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

              <section className="settings-card">
                <Equalizer />
              </section>

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
                    <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">Reset clears the library index so you can re-scan folders.</p>
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
              </section>
            </motion.div>
          ) : (
            <MusicNews
              news={browseNews}
              loading={browseNewsLoading}
              viewMode={viewMode}
              setViewMode={setViewMode}
              recentPlays={recentPlays}
              onQuickNav={(tab) => setActiveTab(tab)}
              onPlayRecent={(recent) => {
                if (recent.filepath && !recent.source) {
                  playTrack(recent.filepath);
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
        initial={{ y: 100 }}
        animate={{ y: 0 }}
        transition={{ type: "spring", stiffness: 200, damping: 25 }}
        className="glass-panel fixed z-[60] flex items-center gap-1.5 sm:gap-3
                   md:inset-x-0 md:bottom-0 md:h-[88px] md:px-6 lg:px-8 md:rounded-none md:border-t md:border-white/10 md:bg-[var(--color-surface-glass-heavy)]
                   rounded-2xl shadow-[0_12px_32px_rgba(0,0,0,0.45)] bg-black/55 backdrop-blur-[40px] border border-white/10
                   mobile-mini-player md:!bottom-0 md:!left-0 md:!right-0 md:!h-[88px] md:!px-6 overflow-hidden"
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
            {coverArt && <img src={coverArt} className="w-full h-full object-cover group-hover:blur-sm transition-all" alt="" />}
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <Maximize2 size={16} className="text-white drop-shadow-md" />
            </div>
          </div>
          <div className="flex flex-col justify-center min-w-0 flex-1 gap-0 overflow-hidden">
            <span className="font-semibold text-white truncate text-shadow-sm font-display text-[12px] sm:text-[13px] md:text-[15px] leading-snug">
              {playerTrack ? stripExtension(playerTrack.title) : "Nothing playing"}
            </span>
            <span className="text-[10px] sm:text-[11px] md:text-xs text-[var(--color-ink-muted)] truncate font-medium leading-snug">
              {playerTrack ? playerTrack.artist : "Find a track on Listen or Browse"}
            </span>
          </div>
          {playerTrack?.source && (
            <span className="hidden md:inline-flex text-[9px] font-black uppercase tracking-wider text-black bg-[var(--color-neon-yellow)] px-1.5 py-0.5 rounded-md shrink-0">
              {hifiReadyIds[playerTrack.id || ''] ? 'HiFi' : playerTrack.source === 'soundcloud' ? 'SC' : playerTrack.source === 'spotify' ? 'SP' : playerTrack.source === 'youtube' ? 'YT' : playerTrack.source}
            </span>
          )}
          {playerTrack && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleLike(playerTrack, lyricsData?.syncedLyrics || lyricsData?.plainLyrics, currentTrackPath); }}
              className="ml-auto p-2 shrink-0 focus:outline-none hover:scale-110 active:scale-95 transition-transform hidden sm:flex"
            >
              {isLiking[playerTrack.id || playerTrack.stream_url || ''] ? (
                 <div className="w-5 h-5 border-2 border-[var(--color-neon-green)] border-t-transparent rounded-full animate-spin" />
              ) : (
                 <Heart size={18} fill={likedTracks.some(t => t.id === (playerTrack.id || playerTrack.stream_url)) ? "var(--color-neon-green)" : "none"} className={likedTracks.some(t => t.id === (playerTrack.id || playerTrack.stream_url)) ? "text-[var(--color-neon-green)] drop-shadow-[0_0_10px_rgba(219,255,0,0.5)]" : "text-neutral-400 hover:text-[var(--color-neon-green)]"} />
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
              onClick={togglePause}
              disabled={!currentTrackPath}
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
            title="Miniplayer"
            aria-label="Miniplayer"
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
            onClick={togglePause}
            disabled={!currentTrackPath}
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

          const playQueueRow = (t: QueueTrack) => {
            playQueue.setCurrentIndex(playQueue.queue.findIndex((q) => q.id === t.id));
            handleStreamExternalAudio(
              { ...t, stream_url: t.stream_url || getTrackPlaybackUrl(t) },
              t.playbackContext === 'liked' ? 'liked' : 'search',
              { skipQueueRebuild: true },
            );
            setCoverArt(t.artwork_url);
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
                  onClick={() => playQueueRow(t)}
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
                <button
                  type="button"
                  onClick={() => playQueue.setShowQueue(false)}
                  className="text-[var(--color-ink-faint)] hover:text-white text-xs font-bold min-h-[36px] px-2 shrink-0"
                >
                  Close
                </button>
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
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", bounce: 0, duration: 0.4 }}
            className="fixed inset-0 z-[100] bg-zinc-950 overflow-hidden flex flex-col min-h-0"
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={0.8}
            onDragEnd={(_, info) => {
              if (info.offset.y > 150 || info.velocity.y > 500) {
                setIsExpanded(false);
              }
            }}
          >
            {/* Immersive Aura Mesh Background */}
            <div className="absolute inset-0 z-0 overflow-hidden bg-[#020202] contain-strict" style={{ transform: 'translateZ(0)' }}>
              <motion.div
                animate={{ scale: [1, 1.2, 1], x: [-30, 30, -30], y: [-20, 20, -20] }}
                transition={{ duration: 24, repeat: Infinity, ease: "linear" }}
                style={{ willChange: "transform" }}
                className="absolute top-[-25%] left-[-25%] w-[120%] h-[120%] rounded-full opacity-30 bg-sky-600 blur-[80px]"
              />
              <motion.div
                animate={{ scale: [1.2, 1, 1.2], x: [40, -40, 40], y: [30, -30, 30] }}
                transition={{ duration: 32, repeat: Infinity, ease: "linear" }}
                style={{ willChange: "transform" }}
                className="absolute bottom-[-25%] right-[-25%] w-[120%] h-[120%] rounded-full opacity-20 bg-amber-700 blur-[80px]"
              />
              <div className="absolute inset-0 bg-gradient-to-b from-[#09090b]/40 to-[#09090b]/80 pointer-events-none" />
            </div>
            <div className="absolute top-8 inset-x-8 z-50 flex justify-between items-center pointer-events-none">
              <button
                onClick={() => setIsExpanded(false)}
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
                      <div
                        className="absolute inset-x-4 bottom-[-8%] top-4 opacity-40 blur-[36px] z-0 pointer-events-none"
                        style={{
                          willChange: 'transform, opacity',
                          backgroundImage: coverArt ? `url(${coverArt})` : undefined,
                          backgroundSize: 'cover',
                          backgroundPosition: 'center',
                          borderRadius: '2rem'
                        }}
                      />

                      <motion.div
                        layoutId="album-art"
                        whileHover={{ scale: 1.02 }}
                        className={`relative z-10 w-full h-full rounded-[1.75rem] sm:rounded-[2.5rem] md:rounded-[3rem] overflow-hidden bg-black transition-all duration-700 ${isPlaying ? 'scale-100' : 'scale-[0.97] opacity-100'}`}
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
                        <img
                          src={coverArt || ""}
                          className="w-full h-full object-cover"
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
                      <h2 className="text-lg sm:text-xl md:text-2xl lg:text-3xl font-display font-bold text-white mb-1 truncate drop-shadow-md tracking-tight leading-tight">
                        {stripExtension(playerTrack.title)}
                      </h2>
                      <button
                        type="button"
                        onClick={() => searchArtist(playerTrack.artist)}
                        className="text-[11px] sm:text-xs md:text-sm text-[var(--color-neon-yellow)] font-medium font-sans truncate drop-shadow-sm uppercase tracking-widest opacity-80 hover:opacity-100 hover:underline underline-offset-4 text-left max-w-full"
                        title={`Search ${playerTrack.artist}`}
                      >
                        {playerTrack.artist}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleLike(playerTrack, lyricsData?.syncedLyrics || lyricsData?.plainLyrics, currentTrackPath)}
                      className="p-2.5 sm:p-3 shrink-0 focus:outline-none hover:scale-110 active:scale-95 transition-transform bg-white/5 hover:bg-white/10 rounded-full"
                      aria-label="Like"
                    >
                      {isLiking[playerTrack.id || playerTrack.stream_url || ''] ? (
                         <div className="w-5 h-5 sm:w-6 sm:h-6 border-2 border-[var(--color-neon-yellow)] border-t-transparent rounded-full animate-spin" />
                      ) : (
                         <Heart size={22} fill={likedTracks.some(t => t.id === (playerTrack.id || playerTrack.stream_url)) ? "var(--color-neon-yellow)" : "none"} className={likedTracks.some(t => t.id === (playerTrack.id || playerTrack.stream_url)) ? "text-[var(--color-neon-yellow)] drop-shadow-[0_0_15px_rgba(219,255,0,0.8)]" : "text-white/80 hover:text-white"} />
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
                        onClick={togglePause}
                        disabled={!currentTrackPath}
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


function TrackResult({ track, onPlay, currentTrackId, isCurrentlyPlaying }: { track: AggregatedTrack; onPlay: (track: AggregatedTrack) => void; currentTrackId: string | null; isCurrentlyPlaying: boolean }) {
  const isCurrentTrack = currentTrackId === track.id;

  const handlePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    onPlay(track);
  };



  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      onClick={handlePlay}
      className={`group flex items-center gap-4 p-3 rounded-2xl bg-zinc-900/20 hover:bg-white/5 border transition-all cursor-pointer relative
                  ${isCurrentTrack ? 'border-[var(--color-neon-yellow)]/50 bg-white/5' : 'border-transparent hover:border-white/10'}`}
    >
      <div className="w-16 h-16 rounded-2xl overflow-hidden shrink-0 relative bg-zinc-800">
        <img src={track.artwork_url} className="w-full h-full object-cover" alt={track.title} />
        <div className={`absolute bottom-0 left-0 right-0 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-center ${
          track.source === 'youtube' ? 'bg-red-600/90 text-white' :
          track.source === 'soundcloud' ? 'bg-orange-500/90 text-white' :
          track.source === 'spotify' ? 'bg-green-600/90 text-white' :
          'bg-white/20 text-white/80'
        }`}>
          {track.source === 'youtube' ? 'YT' : track.source === 'soundcloud' ? 'SC' : track.source === 'spotify' ? 'SP' : track.source}
        </div>
      </div>
      <div className="flex-1 truncate">
        <h4 className={`font-black truncate ${isCurrentTrack ? 'text-[var(--color-neon-yellow)]' : 'text-white'}`}>{stripExtension(track.title)}</h4>
        <div className="flex items-center gap-2">
          <p className="text-xs text-white/50 tracking-wide font-medium truncate">{track.artist}</p>
          <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-md ${
            track.source === 'youtube' ? 'bg-red-600/20 text-red-400' :
            track.source === 'soundcloud' ? 'bg-orange-500/20 text-orange-400' :
            track.source === 'spotify' ? 'bg-green-600/20 text-green-400' :
            'bg-white/10 text-white/40'
          }`}>
            {track.source === 'youtube' ? 'YouTube' : track.source === 'soundcloud' ? 'SoundCloud' : track.source === 'spotify' ? 'Spotify' : track.source}
          </span>
        </div>
      </div>

      {/* Hover Actions */}
      <div className="absolute right-3 inset-y-0 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={handlePlay}
          className="bg-[var(--color-neon-yellow)] text-black font-bold px-4 py-2 rounded-xl text-sm shadow-lg hover:scale-105 active:scale-95 transition-all text-sm"
        >
          {isCurrentTrack && isCurrentlyPlaying ? 'Playing' : 'Play'}
        </button>
        <button className="p-2 backdrop-blur-md bg-white/10 rounded-xl border border-white/20 hover:bg-white/20 transition-all">
          <ListMusic size={18} />
        </button>
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

function AlbumCard({ index, title, artist, onClick, isPlaying, artworkUrl, source }: { index: number; title: string; artist: string; onClick: () => void; isPlaying: boolean; artworkUrl?: string; source?: string }) {
  const [imgUrl, setImgUrl] = useState(artworkUrl || placeholderArt(title));
  const failedRef = useRef(false);

  useEffect(() => {
    failedRef.current = false;
    if (artworkUrl && isRealArtworkUrl(artworkUrl)) {
      setImgUrl(artworkUrl);
      return;
    }
    if (artworkUrl) {
      setImgUrl(artworkUrl);
    }
    fetchAlbumArt(title, artist).then((url) => {
      if (url && !failedRef.current) setImgUrl(url);
    });
  }, [title, artist, artworkUrl]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: Math.min(index * 0.02, 0.5), type: "spring", stiffness: 300, damping: 25 }}
      whileHover={{ y: -6 }}
      onClick={onClick}
      className="group cursor-pointer flex flex-col gap-2 md:gap-3 min-w-0"
    >
      <div className={`aspect-square rounded-xl md:rounded-xl bg-zinc-800/30 overflow-hidden relative border border-white/10 transition-all duration-300 shadow-[0_15px_35px_rgba(0,0,0,0.4)] group-hover:shadow-[0_25px_50px_rgba(0,0,0,0.6)] group-hover:border-white/20`}>
        <img
          src={imgUrl}
          className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700 ease-out"
          alt=""
          onError={() => {
            if (failedRef.current) return;
            failedRef.current = true;
            fetchAlbumArt(title, artist).then((url) => {
              if (url) setImgUrl(url);
              else setImgUrl(placeholderArt(title));
            });
          }}
        />
        {source && (
          <div className={`absolute top-1.5 right-1.5 md:top-2 md:right-2 px-1.5 md:px-2 py-0.5 rounded-md md:rounded-lg text-[9px] md:text-[10px] font-bold uppercase tracking-wide shadow-lg ${
            source === 'youtube' ? 'bg-[var(--color-src-youtube)] text-white' :
            source === 'soundcloud' ? 'bg-[var(--color-src-soundcloud)] text-white' :
            source === 'spotify' ? 'bg-[var(--color-src-spotify)] text-black' :
            'bg-white/20 text-white'
          }`}>
            {source === 'youtube' ? 'YT' : source === 'soundcloud' ? 'SC' : source === 'spotify' ? 'SP' : source}
          </div>
        )}
        <div className={`absolute inset-0 bg-[#09090b]/40 md:bg-[#09090b]/50 transition-opacity flex items-center justify-center backdrop-blur-[2px] ${isPlaying ? 'opacity-100' : 'opacity-100 md:opacity-0 md:group-hover:opacity-100'}`}>
          <div className="w-11 h-11 md:w-14 md:h-14 bg-[var(--color-neon-yellow)] shadow-[0_0_20px_rgba(219,255,0,0.5)] rounded-full flex items-center justify-center border border-white/20">
            {isPlaying ? (
              <div className="flex gap-1 items-center justify-center h-5">
                <div className="w-1 h-3 bg-black animate-pulse" style={{ animationDelay: '0ms' }} />
                <div className="w-1 h-5 bg-black animate-pulse" style={{ animationDelay: '150ms' }} />
                <div className="w-1 h-2 bg-black animate-pulse" style={{ animationDelay: '300ms' }} />
              </div>
            ) : (
              <Play size={20} fill="black" className="text-black ml-0.5 md:ml-1 md:w-6 md:h-6" />
            )}
          </div>
        </div>
      </div>
      <div className="min-w-0 px-0.5">
        <h3 className={`font-display font-bold tracking-tight line-clamp-2 text-[13px] sm:text-base md:text-lg text-white leading-snug ${isPlaying ? 'drop-shadow-[0_0_10px_rgba(255,255,255,0.3)]' : ''}`}>{title}</h3>
        <p className="text-[11px] md:text-sm text-neutral-400 truncate font-sans mt-0.5">{artist}</p>
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
  const initial = durableArtUrl(track.artwork_url) || logoImg;
  const [art, setArt] = useState(initial);
  const failed = useRef(false);

  useEffect(() => {
    failed.current = false;
    const durable = durableArtUrl(track.artwork_url);
    if (durable) {
      setArt(durable);
      return;
    }
    setArt(logoImg);
    let cancelled = false;
    fetchAlbumArt(track.title, track.artist).then((url) => {
      if (!cancelled && url) setArt(url);
    });
    return () => { cancelled = true; };
  }, [track.id, track.artwork_url, track.title, track.artist]);

  return (
    <button
      type="button"
      onClick={onPlay}
      className="shrink-0 w-[42vw] max-w-[11rem] sm:w-40 text-left group snap-start flex flex-col"
    >
      <div className="aspect-square rounded-2xl overflow-hidden bg-zinc-800/80 border border-[var(--color-neon-yellow)]/10 mb-2 relative shrink-0">
        <SourceHintBadge source={sourceHint} />
        <img
          src={art}
          alt=""
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
          onError={() => {
            if (failed.current) {
              setArt(logoImg);
              return;
            }
            failed.current = true;
            fetchAlbumArt(track.title, track.artist).then((url) => {
              setArt(url || logoImg);
            });
          }}
        />
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
}: {
  onSelect: (track: NewsTrack) => void;
  viewMode: 'grid' | 'list';
  setViewMode: (mode: 'grid' | 'list') => void;
  recentPlays?: RecentPlay[];
  onPlayRecent?: (track: RecentPlay) => void;
  onQuickNav?: (tab: 'browse' | 'library' | 'liked') => void;
  news?: NewsTrack[];
  loading?: boolean;
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
          <p className="text-[var(--color-ink-muted)] mt-2 font-medium text-sm max-w-md">Tap a cover — we’ll jump to Browse and start the match.</p>
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
          {news.map((track, i) => (
            <motion.div
              key={`${track.title}-${track.artist}-${track.release_date}-${i}`}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: Math.min(i * 0.02, 0.4), type: "spring", stiffness: 300, damping: 25 }}
              whileHover={{ y: -6 }}
              onClick={() => onSelect(track)}
              className="group cursor-pointer flex flex-col gap-2 md:gap-3"
            >
              <div className="aspect-square rounded-xl md:rounded-[2rem] bg-zinc-800/30 overflow-hidden relative border border-white/10 transition-all duration-300 shadow-xl group-hover:shadow-2xl group-hover:border-white/20">
                <img src={track.artwork_url || logoImg} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" alt={track.title} />
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
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2 md:gap-3">
          {news.map((track, i) => (
            <motion.div
              key={`${track.title}-${track.artist}-${track.release_date}-${i}`}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: Math.min(i * 0.01, 0.3) }}
              onClick={() => onSelect(track)}
              className="group flex items-center gap-3 md:gap-4 p-2.5 md:p-3 rounded-2xl bg-zinc-900/20 hover:bg-white/5 border border-transparent hover:border-white/10 transition-all cursor-pointer relative min-h-[64px]"
            >
              <div className="w-14 h-14 md:w-16 md:h-16 rounded-xl md:rounded-2xl overflow-hidden shrink-0 relative bg-zinc-800">
                <img src={track.artwork_url || logoImg} className="w-full h-full object-cover" alt={track.title} />
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
          ))}
        </div>
      )}
    </motion.div>
  );
}

export default App;
