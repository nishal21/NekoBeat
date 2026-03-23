import { useState, useEffect, useRef, memo } from "react";
import { Play, Pause, SkipForward, SkipBack, Search, Home, Library, Settings, FolderOpen, ChevronDown, Maximize2, Minimize2, ListMusic, Heart, LayoutGrid, List, Volume2, VolumeX, Download } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useAudioPlayer, useLibrary, fetchAlbumArt, fetchLyrics, LyricsData, useAggregatorSearch, AggregatedTrack, useLikedLibrary, useEqualizer, EQ_PRESETS } from "./hooks";
// Used for interacting with system dialogs in Tauri
import { open } from "@tauri-apps/plugin-dialog";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { check } from "@tauri-apps/plugin-updater";
import logoImg from "./assets/logo.png";

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

const ProgressBar = memo(({ positionMs, durationMs, onSeek }: { positionMs: number, durationMs: number | undefined, onSeek: (e: React.MouseEvent<HTMLDivElement>) => void }) => {
  const percentage = durationMs ? positionMs / durationMs : 0;
  return (
    <div className="w-full flex items-center gap-3">
      <span className="text-xs text-neutral-500 tabular-nums">
        {durationMs ? formatTime(positionMs) : "-:--"}
      </span>
      <div
        className="h-2 flex-1 bg-white/10 rounded-full overflow-hidden shrink-0 group cursor-pointer relative shadow-inner"
        onClick={onSeek}
        role="slider"
        tabIndex={0}
        aria-label="Seek track"
        aria-valuemin={0}
        aria-valuemax={durationMs || 100}
        aria-valuenow={positionMs}
      >
        <div
          className="absolute inset-y-0 left-0 bg-gradient-to-r w-full origin-left from-white/80 to-[var(--color-neon-yellow)] shadow-[0_0_15px_rgba(219,255,0,0.8)]"
          style={{ transform: `scaleX(${percentage})` }}
        />
      </div>
      <span className="text-xs text-neutral-500 tabular-nums">
        {durationMs ? formatTime(durationMs) : "-:--"}
      </span>
    </div>
  );
});

const ExpandedProgressBar = memo(({ positionMs, durationMs, onSeek }: { positionMs: number, durationMs: number | undefined, onSeek: (e: React.MouseEvent<HTMLDivElement>) => void }) => {
  const percentage = durationMs ? positionMs / durationMs : 0;
  return (
    <div className="w-full flex items-center gap-3">
      <span className="text-xs text-[var(--color-neon-yellow)] font-sans tabular-nums">{durationMs ? formatTime(positionMs) : "-:--"}</span>
      <div
        className="h-2 flex-1 bg-white/10 rounded-full overflow-hidden shrink-0 group relative shadow-inner cursor-pointer"
        onClick={onSeek}
        role="slider"
        tabIndex={0}
        aria-label="Seek track"
        aria-valuemin={0}
        aria-valuemax={durationMs || 100}
        aria-valuenow={positionMs}
      >
        <div className="absolute inset-y-0 left-0 bg-gradient-to-r w-full origin-left from-white/80 to-[var(--color-neon-yellow)] shadow-[0_0_15px_rgba(219,255,0,0.8)]" style={{ transform: `scaleX(${percentage})` }} />
      </div>
      <span className="text-xs text-neutral-500 font-sans tabular-nums">{durationMs ? formatTime(durationMs) : "-:--"}</span>
    </div>
  );
});

const LyricsDisplay = memo(({ parsedLyrics, activeLyricIndex, hasPlainLyrics, plainLyricsText, lyricsOffsetMs, onOffsetChange, onUploadLyrics }: { parsedLyrics: { timeMs: number, text: string }[], activeLyricIndex: number, hasPlainLyrics: boolean, plainLyricsText?: string, lyricsOffsetMs: number, onOffsetChange: (offset: number) => void, onUploadLyrics?: () => void }) => {

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
      className="lyrics-container no-scrollbar py-[40vh] px-4 md:px-12 overflow-y-auto scroll-smooth group/lyrics"
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
                <p className={`text-2xl md:text-5xl font-display font-black tracking-tight leading-tight transition-colors duration-500
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
              <p className={`text-2xl md:text-4xl font-display font-bold tracking-tight leading-tight text-white/80`}>
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
    <div className="flex items-center gap-1 bg-white/5 p-1 rounded-xl border border-white/10">
      <button
        onClick={() => onChange('grid')}
        className={`p-1.5 rounded-lg transition-all ${viewMode === 'grid' ? 'bg-[var(--color-neon-yellow)] text-black' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}
        title="Grid View"
      >
        <LayoutGrid size={18} />
      </button>
      <button
        onClick={() => onChange('list')}
        className={`p-1.5 rounded-lg transition-all ${viewMode === 'list' ? 'bg-[var(--color-neon-yellow)] text-black' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}
        title="List View"
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
  const { gains, updateGain, applyPreset } = useEqualizer();
  const bands = [
    { label: '31Hz', sub: 'Bass' },
    { label: '62Hz', sub: 'Bass' },
    { label: '125Hz', sub: 'Low Mid' },
    { label: '250Hz', sub: 'Mid' },
    { label: '500Hz', sub: 'Mid' },
    { label: '1kHz', sub: 'Mid' },
    { label: '2kHz', sub: 'High Mid' },
    { label: '4kHz', sub: 'Treble' },
    { label: '8kHz', sub: 'Treble' },
    { label: '16kHz', sub: 'Air' }
  ];

  return (
    <div className="bg-white/5 rounded-3xl p-6 md:p-8 border border-white/10 space-y-8">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
        <h3 className="text-xl font-bold text-white flex items-center gap-3 flex-none">
          <Volume2 size={24} className="text-[var(--color-neon-yellow)]" />
          10-Band EQ
        </h3>
        
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1 -mx-2 px-2 scroll-smooth mask-fade-x touch-pan-x">
          {Object.entries(EQ_PRESETS).map(([name, presetGains]) => {
            const isActive = JSON.stringify(gains) === JSON.stringify(presetGains);
            return (
              <button
                key={name}
                onClick={() => applyPreset(presetGains)}
                className={`flex-none px-5 py-2.5 rounded-full text-[10px] font-black uppercase tracking-widest transition-all border whitespace-nowrap active:scale-95 ${
                  isActive 
                    ? 'bg-[var(--color-neon-yellow)] text-black border-[var(--color-neon-yellow)] shadow-[0_0_20px_rgba(219,255,0,0.3)]' 
                    : 'bg-white/5 text-neutral-400 border-white/5 hover:border-white/20 hover:text-white'
                }`}
              >
                {name}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-end h-72 gap-4 md:gap-5 overflow-x-auto no-scrollbar pb-6 md:justify-between snap-x relative mask-fade-x touch-pan-x">
        {bands.map((band, i) => (
          <div key={band.label} className="flex flex-col items-center gap-5 flex-none md:flex-1 min-w-[70px] md:min-w-0 snap-center">
            <div className="relative h-44 w-4 md:w-2 bg-zinc-800/50 rounded-full overflow-hidden group">
              <div 
                className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[var(--color-neon-yellow)] to-[#c4e600] rounded-full transition-all"
                style={{ height: `${((gains[i] + 24) / 36) * 100}%` }}
              />
              <input
                type="range"
                min="-24"
                max="12"
                step="0.5"
                value={gains[i]}
                onChange={(e) => updateGain(i, parseFloat(e.target.value))}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer orientation-vertical"
                style={{ appearance: 'slider-vertical' } as any}
              />
            </div>
            <div className="text-center">
              <p className="text-[10px] font-black text-white tracking-widest">{band.label}</p>
              <p className="text-[8px] text-neutral-500 uppercase font-bold truncate max-w-[40px]">{band.sub}</p>
              <p className={`text-[10px] font-bold mt-1 ${gains[i] === 0 ? 'text-neutral-600' : 'text-[var(--color-neon-yellow)]'}`}>
                {gains[i] > 0 ? `+${gains[i]}` : gains[i]}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

const VolumeControl = memo(({ volume, onChange }: { volume: number, onChange: (v: number) => void }) => {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div 
      className="relative flex items-center justify-center"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <AnimatePresence>
        {isHovered && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.9 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute bottom-12 flex flex-col items-center justify-center w-12 h-40 bg-zinc-900/90 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl z-50 overflow-hidden py-4"
          >
            <div className="relative w-8 h-32 flex items-center justify-center group/vol">
              {/* Visual Track (Centered) */}
              <div className="relative w-1.5 h-full bg-white/10 rounded-full overflow-hidden pointer-events-none">
                {/* Visual fill */}
                <div 
                  className="absolute bottom-0 w-full bg-[var(--color-neon-yellow)] rounded-full transition-all duration-75"
                  style={{ height: `${volume * 100}%` }}
                />
              </div>
              
              {/* Wide Native vertical slider on top (Invisible hit area) */}
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={volume}
                onChange={(e) => onChange(parseFloat(e.target.value))}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer orientation-vertical z-10"
                style={{ appearance: 'slider-vertical' } as any}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <button 
        className="text-neutral-400 hover:text-white transition-all p-2 hover:bg-white/5 rounded-full"
        onClick={() => onChange(volume === 0 ? 0.5 : 0)}
      >
        {volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
      </button>
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
      // Ensure we at least flip the state so the UI isn't stuck
      setIsMiniplayerMode(!isMiniplayerMode);
    }
  };

  // References for global media keys
  const onTogglePlayRef = useRef<any>(null);
  const onNextRef = useRef<any>(null);
  const onPrevRef = useRef<any>(null);

  const [showMobileLyrics, setShowMobileLyrics] = useState(false);

  const { tracks, isScanning, scanDirectory } = useLibrary();
  const { results: searchResults, isLoading: isSearching, search: performSearch } = useAggregatorSearch();
  const { likedTracks, isLiking, toggleLike } = useLikedLibrary();

  const handleNextTrackRef = useRef<(() => void) | null>(null);

  // Audio player state and actions
  const {
    isPlaying,
    isBuffering,
    currentTrackPath,
    positionMs,
    durationMs,
    volume,
    playTrack,
    streamExternalAudio,
    togglePause,
    seek,
    setVolume,
    playNext,
    playPrev
  } = useAudioPlayer(() => tracks, () => {
    if (handleNextTrackRef.current) handleNextTrackRef.current();
  }, likedTracks);

  const [coverArt, setCoverArt] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [lyricsOffsetMs, setLyricsOffsetMs] = useState(0);
  const [lyricsData, setLyricsData] = useState<LyricsData | null>(null);
  const [parsedLyrics, setParsedLyrics] = useState<{ timeMs: number, text: string }[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchSource, setSearchSource] = useState<'youtube' | 'soundcloud' | 'bandcamp' | 'vk' | 'yandex'>('youtube');
  const [activeSources, setActiveSources] = useState({
    youtube: true,
    soundcloud: true
  });
  const [activeTab, setActiveTab] = useState<'listen' | 'browse' | 'library' | 'settings' | 'liked'>('library');
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

  const currentTrack = tracks.find(t => t.filepath === currentTrackPath);

  // Helper to get track info for player
  let playerTrack = currentTrack;
  if (!playerTrack && externalTrack && currentTrackPath) {
    // If we're not playing a library track, and we have an external track in state, 
    // it must be the one we're currently streaming. This is more resilient than path string matching.
    playerTrack = externalTrack;
  }

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

  // Fallback: fetch metadata/artwork from Last.fm if missing
  useEffect(() => {
    async function fetchLastfmMeta() {
      if (playerTrack && (!playerTrack.artwork_url || playerTrack.artwork_url.includes('picsum'))) {
        try {
          const apiKey = '8c6cd0f902d698cec247211d0aaef717'; // Replace with your Last.fm API key
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
    }
    fetchLastfmMeta();
  }, [playerTrack]);

  // Trigger search when query or source changes
  useEffect(() => {
    const timer = setTimeout(() => {
      performSearch(searchQuery, searchSource);
    }, 500);
    return () => clearTimeout(timer);
  }, [searchQuery, searchSource]);

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

  const handleStreamExternalAudio = async (track: any, context: 'search' | 'liked' = 'search') => {
    const playbackUrl = track.stream_url || track.id;
    setExternalTrack({
      ...track,
      title: track.title || 'Unknown Title',
      artist: track.artist || 'Unknown Artist',
      artwork_url: track.artwork_url || `https://picsum.photos/seed/${track.title || 'default'}/200`,
      album: track.album || '',
      duration_ms: track.duration_ms || 0,
      source: track.source || 'external',
      stream_url: playbackUrl,
      playbackContext: context
    });
    const resolvedUrl = await streamExternalAudio(playbackUrl, track.source, track.id);
    if (resolvedUrl) {
      setExternalTrack((prev: any) => prev ? { ...prev, stream_url: resolvedUrl } : null);
    }
  };

  // Clear externalTrack when playing a local track
  const handlePlayLocalTrack = (filepath: string) => {
    setExternalTrack(null);
    playTrack(filepath);
  };

  // Unified next/prev for both local and external tracks
  const handleNextTrack = () => {
    if (externalTrack) {
      const isLikedContext = externalTrack.playbackContext === 'liked';
      const playlist = isLikedContext ? likedTracks : searchResults;
      
      if (playlist.length > 0) {
        const currentIdx = playlist.findIndex((t: any) => t.id === externalTrack.id);
        const nextIdx = currentIdx + 1;
        if (nextIdx < playlist.length) {
          const next: any = playlist[nextIdx];
          const url = next.stream_url || (
            next.source === 'youtube' ? `https://www.youtube.com/watch?v=${next.id.replace('yt-', '')}` :
              next.source === 'soundcloud' ? `https://api-v2.soundcloud.com/tracks/${next.id.replace('sc-', '')}` :
                next.source === 'spotify' ? `https://open.spotify.com/track/${next.id.replace('sp-', '')}` :
                  next.id
          );
          handleStreamExternalAudio({...next, stream_url: url}, externalTrack.playbackContext);
          setCoverArt(next.artwork_url);
        } else if (autoLoopLiked && isLikedContext && playlist.length > 1) {
          // Loop back to the first song if at the end of Liked Songs
          const first: any = playlist[0];
          const url = first.stream_url || (
            first.source === 'youtube' ? `https://www.youtube.com/watch?v=${first.id.replace('yt-', '')}` :
              first.source === 'soundcloud' ? `https://api-v2.soundcloud.com/tracks/${first.id.replace('sc-', '')}` :
                first.source === 'spotify' ? `https://open.spotify.com/track/${first.id.replace('sp-', '')}` :
                  first.id
          );
          handleStreamExternalAudio({...first, stream_url: url}, 'liked');
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
    if (externalTrack) {
      const isLikedContext = externalTrack.playbackContext === 'liked';
      const playlist = isLikedContext ? likedTracks : searchResults;
      
      if (playlist.length > 0) {
        const currentIdx = playlist.findIndex((t: any) => t.id === externalTrack.id);
        const prevIdx = currentIdx - 1;
        if (prevIdx >= 0) {
          const prev: any = playlist[prevIdx];
          const url = prev.stream_url || (
            prev.source === 'youtube' ? `https://www.youtube.com/watch?v=${prev.id.replace('yt-', '')}` :
              prev.source === 'soundcloud' ? `https://api-v2.soundcloud.com/tracks/${prev.id.replace('sc-', '')}` :
                prev.source === 'spotify' ? `https://open.spotify.com/track/${prev.id.replace('sp-', '')}` :
                  prev.id
          );
          handleStreamExternalAudio({...prev, stream_url: url}, externalTrack.playbackContext);
          setCoverArt(prev.artwork_url);
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
    if (playerTrack) {
      // Set initial/cached artwork immediately
      setCoverArt(playerTrack.artwork_url || `https://picsum.photos/seed/${playerTrack.title}/200`);

      // Fetch high-res artwork
      fetchAlbumArt(playerTrack.title, playerTrack.artist).then(url => {
        if (url) setCoverArt(url);
      });

      // Fetch lyrics
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

      invoke('log_frontend', { msg: `App.tsx: Evaluating playerTrack for lyrics. source=${playerTrack.source}, raw_id=${playerTrack.id}, extracted_spotifyId=${spotifyId}` }).catch(() => { });

      fetchLyrics(playerTrack.title, playerTrack.artist, playerTrack.album, durationMs || playerTrack.duration_ms, spotifyId).then(data => {
        setLyricsData(data);
        setLyricsOffsetMs(0); // Reset offset
        
        const localIsSynced = playerTrack.local_lyrics && playerTrack.local_lyrics.trim().startsWith('[');
        
        if (localIsSynced && playerTrack.local_lyrics) {
          setParsedLyrics(parseLrc(playerTrack.local_lyrics));
        } else if (data && data.syncedLyrics) {
          setParsedLyrics(parseLrc(data.syncedLyrics));
        } else {
          setParsedLyrics([]);
        }
      });
    } else {
      setCoverArt(null);
      setLyricsData(null);
      setParsedLyrics([]);
    }
  }, [playerTrack?.id, playerTrack?.filepath, currentTrackPath]);

  // Sync with System Media Session (Lock Screen / Notifications)
  useEffect(() => {
    if ('mediaSession' in navigator && playerTrack) {
      try {
        const artworkUrl = playerTrack.artwork_url?.startsWith('http') 
          ? playerTrack.artwork_url 
          : (playerTrack.artwork_url ? convertFileSrc(playerTrack.artwork_url) : (coverArt || convertFileSrc(logoImg)));

        navigator.mediaSession.metadata = new MediaMetadata({
          title: stripExtension(playerTrack.title),
          artist: playerTrack.artist,
          album: 'NekoBeat',
          artwork: [
            { src: artworkUrl, sizes: '512x512', type: 'image/png' }
          ]
        });

        // Wake up the Media Session with a silent audio clip
        if (silentAudioRef.current) {
          if (isPlaying) {
            silentAudioRef.current.play()
              .then(() => invoke('log_frontend', { msg: `MediaSession: Silent audio playing. Metadata set for: ${playerTrack.title}` }))
              .catch((e) => invoke('log_frontend', { msg: `MediaSession: Silent audio play failed: ${e}` }));
          } else {
            silentAudioRef.current.pause();
          }
        }

        navigator.mediaSession.setActionHandler('play', () => togglePause());
        navigator.mediaSession.setActionHandler('pause', () => togglePause());
        navigator.mediaSession.setActionHandler('previoustrack', () => handlePrevTrack());
        navigator.mediaSession.setActionHandler('nexttrack', () => handleNextTrack());
        
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';

        // Sync position state (helps with lock screen seeking and duration display)
        if (durationMs > 0 && 'setPositionState' in navigator.mediaSession) {
          navigator.mediaSession.setPositionState({
            duration: durationMs / 1000,
            playbackRate: 1,
            position: positionMs / 1000
          });
        }
      } catch (err) {
        invoke('log_frontend', { msg: `MediaSession Error: ${err}` }).catch(() => {});
      }
    }
  }, [playerTrack, isPlaying, coverArt]);

  // Find active lyric index
  let activeLyricIndex = -1;
  const adjustedPositionMs = positionMs - lyricsOffsetMs;
  for (let i = 0; i < parsedLyrics.length; i++) {
    if (adjustedPositionMs >= parsedLyrics[i].timeMs) {
      activeLyricIndex = i;
    } else {
      break;
    }
  }

  // Auto-scroll lyrics
  useEffect(() => {
    if (isExpanded && activeLyricIndex !== -1) {
      const activeEl = document.getElementById(`lyric-${activeLyricIndex}`);
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [activeLyricIndex, isExpanded]);

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!playerTrack) return;
    const bounds = e.currentTarget.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width));
    seek(Math.floor(percent * (durationMs || playerTrack.duration_ms)));
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
    <div className="flex flex-col md:flex-row h-screen w-full bg-[#050505] text-white overflow-hidden font-sans select-none relative main-container">
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
      {/* Silent audio to trigger browser media session */}
      <audio ref={silentAudioRef} loop muted style={{ display: 'none' }} src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=" />
      
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
        className="glass-panel z-50 flex flex-col md:w-64
                   fixed md:relative bottom-0 inset-x-0 md:inset-auto md:h-full 
                   flex-row md:flex-col items-center md:items-start justify-around md:justify-start 
                   pt-3 pb-8 px-2 md:pt-8 md:pb-32 h-20 md:h-auto
                   bg-zinc-900/30 backdrop-blur-[40px] border-r border-white/5"
      >
        <div className="hidden md:flex items-center gap-3 px-4 mb-10">
          <div className="w-8 h-8 rounded-xl bg-transparent flex items-center justify-center overflow-hidden shadow-[0_0_15px_rgba(255,255,255,0.1)]">
            <img src={logoImg} alt="Nekobeat Logo" className="w-full h-full object-cover" />
          </div>
          <span className="font-display font-bold tracking-tight text-xl text-white">Nekobeat</span>
        </div>

        <nav className="flex flex-row md:flex-col gap-1 md:gap-2 w-full justify-around md:justify-start">
          <NavItem icon={<Home size={22} />} label="Listen" active={activeTab === 'listen'} onClick={() => setActiveTab('listen')} hideLabelOnMobile />
          <NavItem icon={<Search size={22} />} label="Browse" active={activeTab === 'browse'} onClick={() => setActiveTab('browse')} hideLabelOnMobile />
          <NavItem icon={<Library size={22} />} label="Library" active={activeTab === 'library'} onClick={() => setActiveTab('library')} hideLabelOnMobile />
          <NavItem icon={<Heart size={22} />} label="Liked Songs" active={activeTab === 'liked'} onClick={() => setActiveTab('liked')} hideLabelOnMobile />
        </nav>
      </motion.aside>

      {/* Main Content Area */}
      <main className="flex-1 z-10 overflow-y-auto px-4 md:px-8 py-8 pb-48 md:pb-32 pt-12 md:pt-8 w-full block scroll-smooth no-scrollbar">
        <AnimatePresence mode="wait">
          {activeTab === 'library' ? (
            <motion.div
              key="library"
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -20, opacity: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8">
                <h1 className="text-4xl md:text-5xl font-display font-black text-white tracking-tighter leading-none">Your Library</h1>
                <div className="flex items-center gap-3">
                  <ViewToggle viewMode={viewMode} onChange={setViewMode} />
                  <button
                    onClick={handleScanClick}
                    disabled={isScanning}
                    className="flex-1 md:flex-none flex items-center justify-center gap-2 px-5 py-3 bg-gradient-to-b from-[var(--color-neon-yellow)] to-[#c4e600] text-black rounded-xl transition-all font-bold text-sm disabled:opacity-50 shadow-[inset_0_2px_4px_rgba(255,255,255,0.6),0_10px_30px_rgba(219,255,0,0.4)] hover:shadow-[inset_0_2px_4px_rgba(255,255,255,0.6),0_15px_40px_rgba(219,255,0,0.6)] hover:-translate-y-1"
                  >
                    <FolderOpen size={16} />
                    <span>{isScanning ? "Scanning..." : "Add Folder"}</span>
                  </button>
                </div>
              </div>

              {tracks.length === 0 ? (
                <div className="py-20 text-center text-neutral-500">
                  <Library size={48} className="mx-auto mb-4 opacity-50" />
                  <p className="font-medium">No tracks found. Add a folder to start scanning.</p>
                </div>
              ) : viewMode === 'grid' ? (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 md:gap-6">
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
                        artwork_url: track.artwork_url || `https://picsum.photos/seed/${track.title}/200`,
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
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8">
                <h1 className="text-4xl md:text-5xl font-display font-black text-[var(--color-neon-yellow)] drop-shadow-[0_0_15px_rgba(219,255,0,0.5)] tracking-tighter leading-none">Liked Songs</h1>
                <ViewToggle viewMode={viewMode} onChange={setViewMode} />
              </div>
              
              {likedTracks.length === 0 ? (
                <div className="py-20 text-center text-neutral-500">
                  <Heart size={48} className="mx-auto mb-4 opacity-50" />
                  <p className="font-medium">You haven't liked any songs yet.</p>
                </div>
              ) : viewMode === 'grid' ? (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 md:gap-6">
                  {likedTracks.map((track, i) => (
                    <AlbumCard
                      key={track.id + i}
                      index={i}
                      title={track.title}
                      artist={track.artist}
                      artworkUrl={track.artwork_url}
                      onClick={() => handleStreamExternalAudio(track, 'liked')}
                      isPlaying={(playerTrack?.id || currentTrackPath) === track.id && isPlaying}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {likedTracks.map((track, i) => (
                    <TrackResult key={track.id + i} track={track as any} onPlay={() => handleStreamExternalAudio(track, 'liked')} currentTrackId={playerTrack?.id || currentTrackPath} isCurrentlyPlaying={isPlaying} />
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
              className={`space-y-12 transition-all duration-700 ${(!searchQuery && !isSearchFocused) ? 'h-full flex flex-col justify-center' : ''}`}
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


              {searchQuery && (
                <div className="space-y-8 pb-12">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                    <h2 className="text-3xl font-display font-black text-white tracking-tight leading-none">Search Results</h2>
                    <ViewToggle viewMode={viewMode} onChange={setViewMode} />
                  </div>
                  {isSearching ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                      {[1, 2, 3, 4, 5, 6].map(i => <SkeletonTrack key={i} />)}
                    </div>
                  ) : searchResults.length > 0 ? (
                    viewMode === 'grid' ? (
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 md:gap-6">
                        {searchResults.map((track, i) => (
                          <AlbumCard
                            key={track.id}
                            index={i}
                            title={track.title}
                            artist={track.artist}
                            artworkUrl={track.artwork_url}
                            onClick={() => {
                              const url = track.stream_url || (
                                track.source === 'youtube' ? `https://www.youtube.com/watch?v=${track.id.split('-')[1] || track.id}` :
                                  track.source === 'soundcloud' ? `https://api-v2.soundcloud.com/tracks/${track.id.split('-')[1]}` :
                                    track.id
                              );
                              const streamUrl = track.stream_url || url;
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
                            const url = track.stream_url || (
                              track.source === 'youtube' ? `https://www.youtube.com/watch?v=${track.id.split('-')[1] || track.id}` :
                                track.source === 'soundcloud' ? `https://api-v2.soundcloud.com/tracks/${track.id.split('-')[1]}` :
                                  track.id
                            );
                            const streamUrl = track.stream_url || url;
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
                    <div className="py-20 text-center text-neutral-500">
                      <p>No results found for "{searchQuery}"</p>
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
              className="space-y-8 pb-32"
            >
              <h2 className="text-3xl font-display font-black text-white tracking-tight">Settings</h2>

              <div className="bg-white/5 rounded-3xl p-6 md:p-8 border border-white/10 space-y-6">
                <h3 className="text-xl font-bold text-white mb-2">Active Search Sources</h3>
                <p className="text-neutral-400 text-sm mb-6">Select which platforms to query when searching for music. Make sure to restart the app if you toggle new backends.</p>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {Object.entries(activeSources).map(([source, isActive]) => (
                    <button
                      key={source}
                      onClick={() => {
                        const newSources = { ...activeSources, [source]: !isActive };
                        setActiveSources(newSources);
                        // If we disable the currently selected source, switch back to youtube
                        if (isActive && searchSource === source) setSearchSource('youtube');
                      }}
                      className={`flex items-center justify-between p-4 rounded-2xl transition-all border ${isActive
                        ? 'bg-white/10 border-[var(--color-neon-yellow)] shadow-[0_0_15px_-5px_rgba(219,255,0,0.3)]'
                        : 'bg-black/20 border-white/5 hover:bg-white/5'
                        }`}
                    >
                      <span className="capitalize font-bold text-white">{source}</span>
                      <div className={`w-12 h-6 rounded-full transition-colors relative ${isActive ? 'bg-[var(--color-neon-yellow)]' : 'bg-neutral-800'}`}>
                        <div className={`absolute top-1 w-4 h-4 rounded-full transition-all ${isActive ? 'left-7 bg-black' : 'left-1 bg-neutral-400'}`} />
                      </div>
                    </button>
                  ))}
                </div>

                <h3 className="text-xl font-bold text-white mb-2 pt-6">Audio & DSP</h3>
                <p className="text-neutral-400 text-sm mb-6">Fine-tune your sound experience.</p>
                <div className="mb-8">
                  <Equalizer />
                </div>

                <h3 className="text-xl font-bold text-white mb-2 pt-6">Playback Settings</h3>
                <p className="text-neutral-400 text-sm mb-6">Customize how your music plays back.</p>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  <button
                    onClick={() => setAutoLoopLiked(!autoLoopLiked)}
                    className={`flex items-center justify-between p-4 rounded-2xl transition-all border ${autoLoopLiked
                      ? 'bg-white/10 border-[var(--color-neon-yellow)] shadow-[0_0_15px_-5px_rgba(219,255,0,0.3)]'
                      : 'bg-black/20 border-white/5 hover:bg-white/5'
                      }`}
                  >
                    <span className="font-bold text-white">Auto-Loop Liked Songs</span>
                    <div className={`w-12 h-6 rounded-full transition-colors relative ${autoLoopLiked ? 'bg-[var(--color-neon-yellow)]' : 'bg-neutral-800'}`}>
                      <div className={`absolute top-1 w-4 h-4 rounded-full transition-all ${autoLoopLiked ? 'left-7 bg-black' : 'left-1 bg-neutral-400'}`} />
                    </div>
                  </button>
                </div>
              </div>
            </motion.div>
          ) : (
            <MusicNews 
              viewMode={viewMode}
              setViewMode={setViewMode}
              onSelect={(track) => {
                setSearchQuery(`${track.title} ${track.artist}`);
                setActiveTab('browse');
              }} 
            />
          )}
        </AnimatePresence>
      </main>

      {/* Mini-Player / Desktop Bottom Player */}
      <motion.div
        initial={{ y: 100 }}
        animate={{ y: 0 }}
        transition={{ type: "spring", stiffness: 200, damping: 25 }}
        className="glass-panel absolute z-[60] flex items-center justify-between px-4 md:px-8
                   md:bottom-0 md:inset-x-0 md:h-24 md:border-t md:border-white/10 md:rounded-none md:bg-[var(--color-surface-glass-heavy)]
                   bottom-24 inset-x-4 h-16 rounded-2xl shadow-[0_20px_40px_rgba(0,0,0,0.5)] bg-black/40 backdrop-blur-[40px] border border-white/10"
      >
        <div
          onClick={() => playerTrack && setIsExpanded(true)}
          className="flex items-center gap-3 md:gap-4 w-1/2 md:w-1/3 overflow-hidden cursor-pointer group hover:bg-white/5 rounded-xl p-2 -ml-2 transition-colors"
        >
          <div className="w-10 h-10 md:w-14 md:h-14 rounded-full md:rounded-md shadow-2xl bg-zinc-800 overflow-hidden shrink-0 relative">
            {coverArt && <img src={coverArt} className="w-full h-full object-cover group-hover:blur-sm transition-all" />}
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <Maximize2 size={16} className="text-white drop-shadow-md" />
            </div>
          </div>
          <div className="flex flex-col truncate w-full flex-1">
            <span className="font-semibold text-white truncate text-shadow-sm font-display text-sm md:text-base">{playerTrack ? stripExtension(playerTrack.title) : "Not Playing"}</span>
            <span className="text-xs md:text-sm text-[var(--color-neon-green)] truncate font-medium">{playerTrack ? playerTrack.artist : "Select a track"}</span>
          </div>
          {playerTrack && (
            <button 
              onClick={(e) => { e.stopPropagation(); toggleLike(playerTrack, lyricsData?.syncedLyrics || lyricsData?.plainLyrics); }}
              className="ml-auto p-2 focus:outline-none hover:scale-110 active:scale-95 transition-transform"
            >
              {isLiking[playerTrack.id || playerTrack.stream_url || ''] ? (
                 <div className="w-5 h-5 border-2 border-[var(--color-neon-green)] border-t-transparent rounded-full animate-spin" />
              ) : (
                 <Heart size={20} fill={likedTracks.some(t => t.id === (playerTrack.id || playerTrack.stream_url)) ? "var(--color-neon-green)" : "none"} className={likedTracks.some(t => t.id === (playerTrack.id || playerTrack.stream_url)) ? "text-[var(--color-neon-green)] drop-shadow-[0_0_10px_rgba(219,255,0,0.5)]" : "text-neutral-400 hover:text-[var(--color-neon-green)]"} />
              )}
            </button>
          )}
        </div>

        <div className="hidden md:flex flex-col items-center justify-center w-1/3 gap-2">
          <div className="flex items-center gap-6">
            <button
              onClick={handlePrevTrack}
              disabled={!currentTrackPath}
              aria-label="Previous Track"
              className="text-neutral-400 hover:text-white transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white rounded-md p-1"
            >
              <SkipBack size={24} fill="currentColor" />
            </button>
            <button
              onClick={togglePause}
              disabled={!currentTrackPath}
              aria-label={isPlaying ? "Pause" : "Play"}
              aria-pressed={isPlaying}
              className={`w-12 h-12 rounded-full flex items-center justify-center transition-all shadow-lg 
                        ${isBuffering ? 'bg-[var(--color-neon-yellow)]/30 animate-pulse' : 'bg-[var(--color-neon-yellow)] text-black hover:scale-105 active:scale-95'}`}
            >
              {isBuffering ? (
                <div className="w-5 h-5 border-2 border-black border-t-transparent rounded-full animate-spin" />
              ) : isPlaying ? (
                <Pause size={24} fill="currentColor" />
              ) : (
                <Play size={24} fill="currentColor" className="ml-1" />
              )}
            </button>
            <button
              onClick={handleNextTrack}
              disabled={!currentTrackPath}
              aria-label="Next Track"
              className="text-neutral-400 hover:text-white transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white rounded-md p-1"
            >
              <SkipForward size={24} fill="currentColor" />
            </button>
          </div>
          {/* Progress Bar mapped out for memoization */}
          <ProgressBar positionMs={positionMs} durationMs={(playerTrack?.duration_ms && playerTrack.duration_ms > 0) ? playerTrack.duration_ms : durationMs} onSeek={handleSeek} />
        </div>

        <div className="hidden md:flex w-1/3 justify-end relative items-center gap-2">
          <button
            onClick={toggleMiniplayerMode}
            className={`transition-colors p-2 rounded-full hover:bg-white/10 text-neutral-400 hover:text-white`}
            title="Miniplayer">
            <Minimize2 size={20} />
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`transition-colors p-2 rounded-full hover:bg-white/10 ${activeTab === 'settings' ? 'text-white bg-white/10' : 'text-neutral-400 hover:text-white'}`}>
            <Settings size={20} />
          </button>
          
          <VolumeControl volume={volume} onChange={setVolume} />
        </div>

        <div className="md:hidden flex items-center justify-end w-1/2 gap-4">
          <button
            onClick={() => setActiveTab('settings')}
            className={`transition-colors p-2 rounded-full hover:bg-white/10 ${activeTab === 'settings' ? 'text-white bg-white/10' : 'text-neutral-400 hover:text-white'}`}>
            <Settings size={20} />
          </button>
          <button
            onClick={togglePause}
            disabled={!currentTrackPath}
            aria-label={isPlaying ? "Pause" : "Play"}
            aria-pressed={isPlaying}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all 
                      ${isBuffering ? 'bg-white/20 animate-pulse' : 'bg-white text-black hover:scale-105 active:scale-95 shadow-lg'}`}
          >
            {isBuffering ? (
              <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
            ) : isPlaying ? (
              <Pause size={18} fill="currentColor" />
            ) : (
              <Play size={18} fill="currentColor" className="ml-0.5" />
            )}
          </button>
        </div>
      </motion.div>

      {/* Expanded Player Overlay */}
      <AnimatePresence>
        {isExpanded && playerTrack && (
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", bounce: 0, duration: 0.4 }}
            className="fixed inset-0 z-[100] bg-zinc-950 overflow-hidden flex"
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
              {/* Replaced heavy backdrop-blur with a lightweight gradient overlay */}
              <div className="absolute inset-0 bg-gradient-to-b from-[#09090b]/40 to-[#09090b]/80 pointer-events-none" />
            </div>
            <div className="absolute top-8 inset-x-8 z-50 flex justify-between items-center pointer-events-none">
              <button
                onClick={() => setIsExpanded(false)}
                className="p-3 rounded-full bg-white/10 hover:bg-white/20 transition-colors text-white pointer-events-auto"
              >
                <ChevronDown size={28} />
              </button>

              <button
                onClick={() => setShowMobileLyrics(!showMobileLyrics)}
                className={`md:hidden p-3 rounded-full transition-colors pointer-events-auto shadow-lg ${showMobileLyrics ? 'bg-[var(--color-neon-yellow)] text-black shadow-[0_0_15px_rgba(219,255,0,0.4)]' : 'bg-white/10 hover:bg-white/20 text-white'}`}
              >
                <ListMusic size={24} />
              </button>
            </div>

            <div className="flex flex-col md:flex-row w-full h-full max-w-7xl mx-auto z-10 px-6 md:px-12 pb-32 pt-32 md:pt-24">
              {/* Left Side: Art & Controls */}
              <div className={`w-full md:w-1/2 flex-col items-center justify-center md:pr-12 mt-6 md:mt-0 overflow-y-auto md:overflow-visible no-scrollbar gap-8 md:gap-12 ${showMobileLyrics ? 'hidden md:flex' : 'flex'}`}>
                <div className="relative flex items-center justify-center w-[220px] md:w-[320px] lg:w-[380px] aspect-square shrink-0 mt-auto md:mt-0 mb-auto md:mb-10 contain-strict" style={{ transform: 'translateZ(0)' }}>
                  {/* Premium Ambient Aura (The Glow) */}
                  <div
                    className="absolute inset-x-4 bottom-[-10%] top-4 opacity-60 blur-[40px] z-0 pointer-events-none"
                    style={{
                      willChange: 'transform, opacity',
                      backgroundImage: `url(${coverArt || ""})`,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                      borderRadius: '2rem'
                    }}
                  />

                  {/* The Glowing Squircle Album Art */}
                  <motion.div
                    layoutId="album-art"
                    whileHover={{ scale: 1.02 }}
                    className={`relative z-10 w-full h-full rounded-[2.5rem] md:rounded-[3.5rem] shadow-2xl overflow-hidden border border-white/10 transition-all duration-700 ${isPlaying ? 'scale-100' : 'scale-95 opacity-90'}`}
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
                </div>

                <div className="w-full max-w-[350px] flex items-center justify-between text-left shrink-0 relative z-20 mt-4 mb-2 md:m-0">
                  <div className="truncate flex-1 min-w-0 pr-2">
                    <h2 className="text-xl md:text-3xl font-display font-bold text-white mb-2 truncate drop-shadow-md tracking-tight">{stripExtension(playerTrack.title)}</h2>
                    <p className="text-xs md:text-base text-[var(--color-neon-yellow)] font-medium font-sans truncate drop-shadow-sm uppercase tracking-widest opacity-80">{playerTrack.artist}</p>
                  </div>
                  <button 
                    onClick={() => toggleLike(playerTrack, lyricsData?.syncedLyrics || lyricsData?.plainLyrics)}
                    className="p-3 ml-2 focus:outline-none hover:scale-110 active:scale-95 transition-transform bg-white/5 hover:bg-white/10 rounded-full"
                  >
                    {isLiking[playerTrack.id || playerTrack.stream_url || ''] ? (
                       <div className="w-6 h-6 border-2 border-[var(--color-neon-yellow)] border-t-transparent rounded-full animate-spin" />
                    ) : (
                       <Heart size={24} fill={likedTracks.some(t => t.id === (playerTrack.id || playerTrack.stream_url)) ? "var(--color-neon-yellow)" : "none"} className={likedTracks.some(t => t.id === (playerTrack.id || playerTrack.stream_url)) ? "text-[var(--color-neon-yellow)] drop-shadow-[0_0_15px_rgba(219,255,0,0.8)]" : "text-white/80 hover:text-white"} />
                    )}
                  </button>
                </div>

                {/* Controls inside Expanded View */}
                <div className="w-full md:max-w-[400px] mx-auto flex flex-col items-center justify-center gap-4 md:gap-5 mt-4 md:mt-6 px-4 md:px-0 shadow-[0_-40px_40px_rgba(0,0,0,0.5)] md:shadow-none bg-[var(--color-surface-glass-heavy)] md:bg-transparent backdrop-blur-xl md:backdrop-blur-none rounded-t-3xl md:rounded-none pt-6 md:pt-0 pb-10 md:pb-0 fixed md:relative bottom-0 inset-x-0 z-50 md:z-20 shrink-0 landscape:relative landscape:bottom-auto landscape:pt-4 landscape:pb-8 landscape:shadow-none">
                  <ExpandedProgressBar positionMs={positionMs} durationMs={(playerTrack?.duration_ms && playerTrack.duration_ms > 0) ? playerTrack.duration_ms : durationMs} onSeek={handleSeek} />
                  <div className="flex items-center gap-4 md:gap-6">
                    <button onClick={handlePrevTrack} disabled={!currentTrackPath} aria-label="Previous" className="text-white/60 hover:text-white transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white rounded-md p-1"><SkipBack size={20} className="md:w-6 md:h-6" fill="currentColor" /></button>
                    <button
                      onClick={togglePause}
                      disabled={!currentTrackPath}
                      aria-label={isPlaying ? "Pause" : "Play"}
                      aria-pressed={isPlaying}
                      className={`w-12 h-12 md:w-14 md:h-14 rounded-full flex items-center justify-center transition-all shadow-lg
                             ${isBuffering ? 'bg-[var(--color-neon-green)]/30 animate-pulse' : 'bg-[var(--color-neon-green)] text-black hover:scale-105 active:scale-95'}`}
                    >
                      {isBuffering ? (
                        <div className="w-6 h-6 border-3 border-black border-t-transparent rounded-full animate-spin" />
                      ) : isPlaying ? (
                        <Pause size={20} fill="currentColor" />
                      ) : (
                        <Play size={20} fill="currentColor" className="ml-1" />
                      )}
                    </button>
                    <button onClick={handleNextTrack} disabled={!currentTrackPath} aria-label="Next" className="text-white/60 hover:text-white transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white rounded-md p-1"><SkipForward size={20} className="md:w-6 md:h-6" fill="currentColor" /></button>
                  </div>
                  
                  <div className="mt-2 scale-125 hidden md:flex">
                    <VolumeControl volume={volume} onChange={setVolume} />
                  </div>
                </div>
              </div>

              {/* Right Side: Lyrics */}
              <div className={`w-full md:w-1/2 flex-col h-full relative ${showMobileLyrics ? 'flex' : 'hidden md:flex'}`}>
                <LyricsDisplay
                  parsedLyrics={parsedLyrics}
                  activeLyricIndex={activeLyricIndex}
                  hasPlainLyrics={hasPlainLyrics}
                  plainLyricsText={plainLyricsText}
                  lyricsOffsetMs={lyricsOffsetMs}
                  onOffsetChange={setLyricsOffsetMs}
                  onUploadLyrics={handleUploadLyrics}
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function NavItem({ icon, label, active = false, hideLabelOnMobile = false, onClick }: { icon: React.ReactNode; label: string; active?: boolean; hideLabelOnMobile?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col md:flex-row items-center justify-center md:justify-start gap-1 md:gap-3 px-2 md:px-4 py-2 md:py-2.5 rounded-xl transition-all font-medium w-full ${active ? 'md:bg-white/5 md:text-white shadow-sm' : 'text-neutral-500 md:text-neutral-400 hover:text-white hover:bg-white/5'}`}
    >
      <span className={active ? "text-[var(--color-neon-yellow)] drop-shadow-[0_0_10px_rgba(219,255,0,0.5)]" : ""}>{icon}</span>
      <span className={`text-[10px] md:text-base font-bold ${hideLabelOnMobile ? 'hidden md:inline' : ''} ${active ? 'text-white drop-shadow-sm' : ''}`}>{label}</span>
    </button>
  );
}

function HeroSearch({ value, onChange, isSearching, source, onSourceChange, activeSources, onFocus, onBlur }: { value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; isSearching: boolean, source: string, onSourceChange: (s: any) => void, activeSources: Record<string, boolean>, onFocus: () => void, onBlur: () => void }) {
  const getBrandColor = (_s: string) => {
    return 'bg-white text-black';
  };

  const getBrandTextColor = (_s: string) => {
    return 'text-white';
  };

  return (
    <motion.div 
      layout
      transition={{ type: "spring", stiffness: 200, damping: 25 }}
      className="relative w-full max-w-4xl mx-auto px-4 flex flex-col gap-8"
    >
      <motion.div layout className="relative group">
        <div className="absolute inset-y-0 left-6 flex items-center pointer-events-none">
          <Search className={`transition-colors duration-300 ${isSearching ? 'text-[var(--color-neon-yellow)] animate-pulse' : 'text-white/40'}`} size={24} />
        </div>
        <input
          type="text"
          value={value}
          onChange={onChange}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={`Search on ${source.charAt(0).toUpperCase() + source.slice(1)}...`}
          className="w-full bg-zinc-900/40 backdrop-blur-xl border border-white/10 shadow-inner shadow-white/5 rounded-2xl py-6 pl-16 pr-6 text-xl md:text-2xl text-white placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-[var(--color-neon-yellow)] focus:border-transparent transition-all duration-300 shadow-2xl"
        />
      </motion.div>

      <motion.div layout className="flex flex-wrap items-center justify-center gap-3">
        {Object.entries(activeSources).filter(([_, isActive]) => isActive).map(([s, _]) => {
          const brandColor = getBrandColor(s);
          const textColor = getBrandTextColor(s);
          const isSelected = source === s;

          return (
            <button
              key={s}
              onClick={() => onSourceChange(s as any)}
              style={isSelected ? { background: `linear-gradient(180deg, ${brandColor}, color-mix(in srgb, ${brandColor} 85%, black))`, borderColor: brandColor, color: textColor, boxShadow: `inset 0 2px 4px rgba(255,255,255,0.6), 0 10px 20px -5px ${brandColor}60` } : {}}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-xl font-bold transition-all border capitalize ${isSelected ? '' : 'bg-white/5 text-neutral-400 border-white/5 hover:bg-white/10 hover:text-white'}`}
            >
              {s}
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
        {track.source === 'youtube' && (
          <div className="absolute top-1 right-1 bg-red-600 rounded-md p-0.5 shadow-lg">
            <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
          </div>
        )}
      </div>
      <div className="flex-1 truncate">
        <h4 className={`font-black truncate ${isCurrentTrack ? 'text-[var(--color-neon-yellow)]' : 'text-white'}`}>{stripExtension(track.title)}</h4>
        <p className="text-xs text-white/50 tracking-wide font-medium truncate">{track.artist}</p>
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

function AlbumCard({ index, title, artist, onClick, isPlaying, artworkUrl }: { index: number; title: string; artist: string; onClick: () => void; isPlaying: boolean; artworkUrl?: string }) {
  const [imgUrl, setImgUrl] = useState(artworkUrl || `https://picsum.photos/seed/${title}/400`);

  useEffect(() => {
    if (artworkUrl) {
      setImgUrl(artworkUrl);
      return;
    }
    fetchAlbumArt(title, artist).then((url) => {
      if (url) setImgUrl(url);
    });
  }, [title, artist, artworkUrl]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: Math.min(index * 0.02, 0.5), type: "spring", stiffness: 300, damping: 25 }}
      whileHover={{ y: -6 }}
      onClick={onClick}
      className="group cursor-pointer flex flex-col gap-3"
    >
      <div className={`aspect-square rounded-2xl md:rounded-xl bg-zinc-800/30 overflow-hidden relative border border-white/10 transition-all duration-300 shadow-[0_15px_35px_rgba(0,0,0,0.4)] group-hover:shadow-[0_25px_50px_rgba(0,0,0,0.6)] group-hover:border-white/20`}>
        <img src={imgUrl} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700 ease-out" />
        <div className={`absolute inset-0 bg-[#09090b]/50 transition-opacity flex items-center justify-center backdrop-blur-[2px] ${isPlaying ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
          <div className="w-14 h-14 bg-[var(--color-neon-yellow)] shadow-[0_0_20px_rgba(219,255,0,0.5)] rounded-full flex items-center justify-center border border-white/20">
            {isPlaying ? (
              <div className="flex gap-1 items-center justify-center h-5">
                <div className="w-1 h-3 bg-black animate-pulse" style={{ animationDelay: '0ms' }} />
                <div className="w-1 h-5 bg-black animate-pulse" style={{ animationDelay: '150ms' }} />
                <div className="w-1 h-2 bg-black animate-pulse" style={{ animationDelay: '300ms' }} />
              </div>
            ) : (
              <Play size={24} fill="black" className="text-black ml-1" />
            )}
          </div>
        </div>
      </div>
      <div>
        <div className="flex items-center gap-2">
          <h3 className={`font-display font-bold tracking-tight truncate text-base md:text-lg text-white ${isPlaying ? 'drop-shadow-[0_0_10px_rgba(255,255,255,0.3)]' : ''}`}>{title}</h3>
        </div>
        <p className="text-xs md:text-sm text-neutral-400 truncate font-sans">{artist}</p>
      </div>
    </motion.div>
  );
}


function MusicNews({ onSelect, viewMode, setViewMode }: { onSelect: (track: NewsTrack) => void, viewMode: 'grid' | 'list', setViewMode: (mode: 'grid' | 'list') => void }) {
  const [news, setNews] = useState<NewsTrack[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    invoke<NewsTrack[]>('get_music_news')
      .then(data => {
        setNews(data);
        setLoading(false);
      })
      .catch(err => {
        console.error("Failed to fetch news:", err);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <h1 className="text-4xl md:text-5xl font-display font-black text-white tracking-tighter leading-none">New Releases</h1>
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
      className="flex flex-col gap-8 pb-32"
    >
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-4xl md:text-5xl font-display font-black text-white tracking-tighter leading-none">Latest Releases</h1>
          <p className="text-neutral-400 mt-2 font-medium">Trending tracks and popular new music from across the globe.</p>
        </div>
        <ViewToggle viewMode={viewMode} onChange={setViewMode} />
      </div>

      {viewMode === 'grid' ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 md:gap-6">
          {news.map((track, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: i * 0.02, type: "spring", stiffness: 300, damping: 25 }}
              whileHover={{ y: -6 }}
              onClick={() => onSelect(track)}
              className="group cursor-pointer flex flex-col gap-3"
            >
              <div className="aspect-square rounded-2xl md:rounded-[2rem] bg-zinc-800/30 overflow-hidden relative border border-white/10 transition-all duration-300 shadow-xl group-hover:shadow-2xl group-hover:border-white/20 group-hover:scale-105">
                <img src={track.artwork_url} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" alt={track.title} />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center backdrop-blur-[2px]">
                  <div className="bg-[var(--color-neon-yellow)] text-black font-black px-6 py-2.5 rounded-2xl text-xs uppercase tracking-widest shadow-2xl scale-90 group-hover:scale-100 transition-transform">
                    Find Track
                  </div>
                </div>
              </div>
              <div className="px-1">
                <h3 className="font-display font-bold tracking-tight truncate text-base md:text-lg text-white group-hover:text-[var(--color-neon-yellow)] transition-colors">{track.title}</h3>
                <div className="flex flex-col gap-0.5">
                  <p className="text-xs md:text-sm text-neutral-400 truncate font-sans font-medium">{track.artist}</p>
                  <p className="text-[11px] text-[var(--color-neon-yellow)] font-black uppercase tracking-widest opacity-90 drop-shadow-[0_0_8px_rgba(219,255,0,0.3)]">{track.release_date}</p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {news.map((track, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.01 }}
              onClick={() => onSelect(track)}
              className="group flex items-center gap-4 p-3 rounded-2xl bg-zinc-900/20 hover:bg-white/5 border border-transparent hover:border-white/10 transition-all cursor-pointer relative"
            >
              <div className="w-16 h-16 rounded-2xl overflow-hidden shrink-0 relative bg-zinc-800">
                <img src={track.artwork_url} className="w-full h-full object-cover" alt={track.title} />
              </div>
              <div className="flex-1 truncate">
                <h4 className="font-black text-white truncate group-hover:text-[var(--color-neon-yellow)] transition-colors">{track.title}</h4>
                <div className="flex items-center gap-3">
                  <p className="text-xs text-white/50 tracking-wide font-medium">{track.artist}</p>
                  <span className="w-1 h-1 rounded-full bg-white/20" />
                  <p className="text-[10px] text-[var(--color-neon-yellow)] font-bold uppercase tracking-widest">{track.release_date}</p>
                </div>
              </div>
              <div className="bg-[var(--color-neon-yellow)] text-black font-black px-4 py-2 rounded-xl text-[10px] uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity">
                Find
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </motion.div>
  );
}

export default App;
