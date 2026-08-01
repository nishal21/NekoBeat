import { useState, useEffect, useRef, useSyncExternalStore, useCallback } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** External store so position polls don't re-render the whole App tree. */
type AudioClockSnapshot = { positionMs: number; durationMs: number };
let audioClock: AudioClockSnapshot = { positionMs: 0, durationMs: 0 };
const audioClockListeners = new Set<() => void>();

function emitAudioClock(next: AudioClockSnapshot) {
    if (next.positionMs === audioClock.positionMs && next.durationMs === audioClock.durationMs) return;
    audioClock = next;
    audioClockListeners.forEach((l) => l());
}

/** Ignore SMTC pause events for a moment after we intentionally resume. */
let resumeGuardUntil = 0;

export function isResumeGuarded(): boolean {
    return Date.now() < resumeGuardUntil;
}

function armResumeGuard(ms = 1000) {
    resumeGuardUntil = Date.now() + ms;
}
let lastGoodPosMs = 0;
let lastGoodDurMs = 0;
let zeroBlipStreak = 0;
/** After an intentional seek, ignore stale GST samples that would yank the thumb back. */
let seekGuardUntil = 0;
let seekGuardTarget = 0;
/** Wall-clock cap so a bad container / flaky query can't make the bar sprint ahead of audio. */
let wallOriginMs = 0;
let wallOriginPos = 0;
let wallTracking = false;

function resetStickyClock() {
    lastGoodPosMs = 0;
    lastGoodDurMs = 0;
    zeroBlipStreak = 0;
    seekGuardUntil = 0;
    seekGuardTarget = 0;
    wallOriginMs = 0;
    wallOriginPos = 0;
    wallTracking = false;
    emitAudioClock({ positionMs: 0, durationMs: 0 });
}

/** Seed duration from track metadata when GST hasn't reported one yet. */
export function seedAudioClockDuration(ms: number) {
    if (!(ms > 0)) return;
    if (lastGoodDurMs > 0) return;
    lastGoodDurMs = ms;
    emitAudioClock({ positionMs: lastGoodPosMs, durationMs: lastGoodDurMs });
}

export function setAudioClockWallTracking(playing: boolean) {
    if (playing) {
        wallOriginPos = lastGoodPosMs;
        wallOriginMs = performance.now();
        wallTracking = true;
    } else {
        wallTracking = false;
    }
}

/**
 * Apply a GStreamer clock sample.
 * - Ignore IPC timeouts (0,0) once we have a good sample
 * - Ignore 1–2 mid-track near-zero blips (prevents blink-to-start)
 * - Never let reported position run ahead of real wall time (fixes "bar moves too fast")
 */
function applyGstClockSample(pos: number, dur: number) {
    if (pos === 0 && dur === 0 && lastGoodPosMs > 0) {
        return;
    }

    // GST file duration always wins over Spotify/search metadata (preview vs full mismatch)
    if (dur > 0) {
        // If we seeded a long metadata duration but the file is a short preview, snap down
        if (lastGoodDurMs > 0 && dur + 5000 < lastGoodDurMs * 0.5) {
            lastGoodDurMs = dur;
        } else {
            lastGoodDurMs = dur;
        }
    }

    // Right after scrub/seek, GST can still report the old position — keep thumb where user put it
    if (performance.now() < seekGuardUntil && Math.abs(pos - seekGuardTarget) > 1500) {
        emitAudioClock({
            positionMs: lastGoodPosMs,
            durationMs: lastGoodDurMs || audioClock.durationMs,
        });
        return;
    }

    if (pos < 300 && lastGoodPosMs > 2000) {
        zeroBlipStreak += 1;
        if (zeroBlipStreak < 3) return;
    } else {
        zeroBlipStreak = 0;
    }

    let stablePos = Math.max(0, pos);
    if (wallTracking && wallOriginMs > 0) {
        const wallElapsed = performance.now() - wallOriginMs;
        const maxAllowed = wallOriginPos + wallElapsed + 750; // 0.75s slack for IPC jitter
        if (stablePos > maxAllowed) {
            stablePos = Math.floor(maxAllowed);
        }
    }

    lastGoodPosMs = stablePos;
    emitAudioClock({
        positionMs: lastGoodPosMs,
        durationMs: lastGoodDurMs || audioClock.durationMs,
    });
}

function seekClockTo(ms: number) {
    lastGoodPosMs = Math.max(0, ms);
    zeroBlipStreak = 0;
    wallOriginPos = lastGoodPosMs;
    wallOriginMs = performance.now();
    seekGuardUntil = performance.now() + 450;
    seekGuardTarget = lastGoodPosMs;
    emitAudioClock({
        positionMs: lastGoodPosMs,
        durationMs: lastGoodDurMs || audioClock.durationMs,
    });
}

function subscribeAudioClock(onStoreChange: () => void) {
    audioClockListeners.add(onStoreChange);
    return () => { audioClockListeners.delete(onStoreChange); };
}

function getAudioClockSnapshot() {
    return audioClock;
}

export function useAudioClock(): AudioClockSnapshot {
    return useSyncExternalStore(subscribeAudioClock, getAudioClockSnapshot, getAudioClockSnapshot);
}

export function getAudioClock(): AudioClockSnapshot {
    return audioClock;
}

const albumArtCache = new Map<string, string | null>();
const albumArtInflight = new Map<string, Promise<string | null>>();
let albumArtActive = 0;
const albumArtQueue: Array<() => void> = [];
const ALBUM_ART_CONCURRENCY = 3;

function runAlbumArtJob<T>(job: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        const start = () => {
            albumArtActive++;
            job()
                .then(resolve, reject)
                .finally(() => {
                    albumArtActive--;
                    const next = albumArtQueue.shift();
                    if (next) next();
                });
        };
        if (albumArtActive < ALBUM_ART_CONCURRENCY) start();
        else albumArtQueue.push(start);
    });
}

export function isRealArtworkUrl(url?: string | null): boolean {
    if (!url) return false;
    if (url.includes('picsum')) return false;
    if (url.startsWith('data:')) return false;
    if (/^https?:\/\//i.test(url) || url.startsWith('asset:') || url.startsWith('blob:')) return true;
    // Local disk path (Windows / Unix) — offline liked art
    if (/^[a-zA-Z]:[\\/]/.test(url) || url.startsWith('/') || url.startsWith('\\\\')) return true;
    return false;
}

/** Prefer remote https art when present; use local disk only when no remote URL. */
export function toDisplayArtUrl(remoteOrPath?: string | null, localPath?: string | null): string | undefined {
    const remote = (remoteOrPath && remoteOrPath.trim()) || '';
    const local = (localPath && localPath.trim()) || '';

    // Working CDN / already-converted URLs first (avoids broken convertFileSrc locals)
    if (/^https?:\/\//i.test(remote) || remote.startsWith('asset:') || remote.startsWith('blob:') || remote.startsWith('data:')) {
        return remote;
    }

    const tryLocal = (path: string): string | undefined => {
        if (/^https?:\/\//i.test(path) || path.startsWith('asset:') || path.startsWith('blob:') || path.startsWith('data:')) {
            return path;
        }
        if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\') || path.startsWith('file:')) {
            try {
                const cleaned = path.replace(/^file:\/\/\/?/i, '').replace(/^\\\\\?\\/, '');
                return convertFileSrc(cleaned);
            } catch {
                return undefined;
            }
        }
        return undefined;
    };

    if (local) {
        const fromLocal = tryLocal(local);
        if (fromLocal) return fromLocal;
    }
    if (remote) {
        const fromRemoteAsPath = tryLocal(remote);
        if (fromRemoteAsPath) return fromRemoteAsPath;
        return remote;
    }
    return undefined;
}

export async function fetchAlbumArt(title: string, artist: string): Promise<string | null> {
    const key = `${title.trim().toLowerCase()}|${artist.trim().toLowerCase()}`;
    if (albumArtCache.has(key)) return albumArtCache.get(key) ?? null;
    const existing = albumArtInflight.get(key);
    if (existing) return existing;

    const promise = runAlbumArtJob(async () => {
        try {
            const query = encodeURIComponent(`${title} ${artist}`);
            const res = await fetch(`https://itunes.apple.com/search?term=${query}&limit=1&media=music`);
            const data = await res.json();
            if (data.results && data.results.length > 0) {
                const url = data.results[0].artworkUrl100.replace('100x100bb', '600x600bb');
                albumArtCache.set(key, url);
                return url;
            }
            albumArtCache.set(key, null);
            return null;
        } catch (e) {
            console.warn("Failed to fetch album art from iTunes", e);
            return null;
        } finally {
            albumArtInflight.delete(key);
        }
    });

    albumArtInflight.set(key, promise);
    return promise;
}

export type LyricsData = {
    syncedLyrics?: string;
    plainLyrics?: string;
    source?: string;
};

export async function fetchLyrics(title: string, artist: string, album: string, durationMs: number, spotifyId?: string): Promise<LyricsData | null> {
    try {
        const result = await invoke<{ synced_lyrics?: string; plain_lyrics?: string; source?: string }>('get_lyrics', {
            title,
            artist,
            album,
            durationMs,
            spotifyId: spotifyId?.replace(/^sp-/, '') || null,
        });
        if (result && (result.synced_lyrics || result.plain_lyrics)) {
            return {
                syncedLyrics: result.synced_lyrics,
                plainLyrics: result.plain_lyrics,
                source: result.source,
            };
        }
    } catch (e) {
        console.warn("Unified lyrics fetch failed:", e);
    }
    return null;
}

export function useAudioPlayer(getTracks: () => TrackData[], onEnded?: () => void, likedTracks: any[] = []) {
    const onEndedRef = useRef(onEnded);
    useEffect(() => {
        onEndedRef.current = onEnded;
    }, [onEnded]);

    const likedTracksRef = useRef(likedTracks);
    useEffect(() => { likedTracksRef.current = likedTracks; }, [likedTracks]);

    const lastStreamRef = useRef<{ url: string; source: string; trackId?: string } | null>(null);
    const needsRestreamRef = useRef(false);
    const retryingStreamRef = useRef(false);
    const ytForbiddenRetriesRef = useRef(0);
    const currentExternalTrackIdRef = useRef<string | undefined>(undefined);
    /** Bumps on every play so stale async completions / seeks can't clobber the latest track. */
    const playEpochRef = useRef(0);

    const [isPlaying, setIsPlaying] = useState(false);
    const [isBuffering, setIsBuffering] = useState(false);
    const [currentTrackPath, setCurrentTrackPath] = useState<string | null>(null);
    const [durationMs, setDurationMs] = useState(0);
    const [volume, setVolumeState] = useState(() => {
        const saved = localStorage.getItem('nekobeat_volume');
        return saved ? parseFloat(saved) : 1.0;
    });

    const resetClock = useCallback(() => {
        resetStickyClock();
        setDurationMs(0);
    }, []);

    const setVolume = async (v: number) => {
        try {
            await invoke('set_volume', { volume: v });
            setVolumeState(v);
            localStorage.setItem('nekobeat_volume', v.toString());
        } catch (e) {
            console.error("Failed to set volume:", e);
        }
    };

    // Apply initial volume
    useEffect(() => {
        invoke('set_volume', { volume }).catch(() => {});
    }, []);

    const playTrack = async (path: string, trackId?: string) => {
        const epoch = ++playEpochRef.current;
        try {
            resetClock();
            if (trackId) {
                currentExternalTrackIdRef.current = trackId;
                lastStreamRef.current = { url: path, source: 'local', trackId };
            } else {
                currentExternalTrackIdRef.current = undefined;
                lastStreamRef.current = null;
            }
            await invoke('play_audio', { path });
            if (epoch !== playEpochRef.current) return; // newer play won
            setCurrentTrackPath(path);
            setIsPlaying(true);
            setIsBuffering(false);
            needsRestreamRef.current = false;
        } catch (e) {
            if (epoch !== playEpochRef.current) return;
            console.error("Failed to play track:", e);
        }
    };

    const streamExternalAudio = async (
        url: string,
        source: string,
        trackId?: string,
        title?: string,
        artist?: string,
    ) => {
        const epoch = ++playEpochRef.current;
        lastStreamRef.current = { url, source, trackId };
        currentExternalTrackIdRef.current = trackId;
        needsRestreamRef.current = false;
        ytForbiddenRetriesRef.current = 0;

        try {
            // Prefer liked offline file when present (all sources including Spotify)
            if (trackId) {
                const liked = likedTracksRef.current?.find(t => t.id === trackId);
                if (liked?.local_audio_path) {
                    try {
                        console.log("Offline: Playing from liked offline cache:", liked.local_audio_path);
                        resetClock();
                        await invoke('play_audio', { path: liked.local_audio_path });
                        if (epoch !== playEpochRef.current) return null;
                        setCurrentTrackPath(liked.local_audio_path);
                        setIsPlaying(true);
                        setIsBuffering(false);
                        return liked.local_audio_path;
                    } catch (cacheErr) {
                        console.warn("Offline cache unavailable, streaming instead:", cacheErr);
                    }
                }
            }

            setIsBuffering(true);
            resetClock();
            const resolvedUrl = await invoke<string>('stream_external_audio', {
                url,
                source,
                title: title || null,
                artist: artist || null,
            });
            if (epoch !== playEpochRef.current) return null;
            setCurrentTrackPath(resolvedUrl || url);
            setIsPlaying(true);
            return resolvedUrl;
        } catch (e) {
            if (epoch !== playEpochRef.current) return null;
            console.error("Failed to stream external audio:", e);
            setIsBuffering(false);
            needsRestreamRef.current = true;
            return null;
        }
    };

    const pausePlayback = async () => {
        if (isResumeGuarded()) {
            console.log("Ignoring pause — resume guard active");
            return;
        }
        try {
            await invoke('pause_audio');
            setIsPlaying(false);
        } catch (e) {
            console.error("Failed to pause:", e);
        }
    };

    const resumePlayback = async () => {
        try {
            if (!currentTrackPath && !lastStreamRef.current) return;

            armResumeGuard(1500);

            // Stuck at EOF (UI shows ~end + pause) — restart instead of silent resume
            if (lastGoodDurMs > 0 && lastGoodPosMs >= lastGoodDurMs - 1500) {
                const path = currentTrackPath;
                const trackId = currentExternalTrackIdRef.current;
                if (path && !/^https?:/i.test(path) && !path.includes('googlevideo')) {
                    await playTrack(path, trackId);
                    armResumeGuard(1500);
                    return;
                }
                if (lastStreamRef.current) {
                    const { url, source, trackId: tid } = lastStreamRef.current;
                    await streamExternalAudio(url, source, tid);
                    armResumeGuard(1500);
                    return;
                }
            }

            if (needsRestreamRef.current && lastStreamRef.current) {
                const { url, source, trackId } = lastStreamRef.current;
                await streamExternalAudio(url, source, trackId);
                armResumeGuard(1500);
                return;
            }

            const resumeAt = lastGoodPosMs;
            await invoke('resume_audio');
            if (resumeAt > 0) {
                seekClockTo(resumeAt);
            }
            setIsPlaying(true);
            setIsBuffering(false);
            armResumeGuard(1500);
        } catch (e) {
            console.error("Failed to resume:", e);
            needsRestreamRef.current = true;
            if (lastStreamRef.current) {
                const { url, source, trackId } = lastStreamRef.current;
                try {
                    await streamExternalAudio(url, source, trackId);
                    armResumeGuard(1500);
                } catch (re) {
                    console.error("Failed to restream after resume error:", re);
                }
            }
        }
    };

    const togglePause = async () => {
        if (isPlaying) {
            await pausePlayback();
        } else {
            await resumePlayback();
        }
    };

    const seek = async (ms: number) => {
        const epoch = playEpochRef.current;
        try {
            await invoke('seek_audio', { positionMs: ms });
            if (epoch !== playEpochRef.current) return; // track changed mid-seek
            seekClockTo(ms);
        } catch (e) {
            console.error("Failed to seek audio:", e);
        }
    };

    const playNext = (tracks: TrackData[]) => {
        if (!currentTrackPath || tracks.length === 0) return;
        const idx = tracks.findIndex(t => t.filepath === currentTrackPath);
        if (idx !== -1 && idx + 1 < tracks.length) {
            playTrack(tracks[idx + 1].filepath);
        } else if (tracks.length > 0) {
            playTrack(tracks[0].filepath);
        }
    };

    const playPrev = (tracks: TrackData[]) => {
        if (!currentTrackPath || tracks.length === 0) return;
        const idx = tracks.findIndex(t => t.filepath === currentTrackPath);
        if (idx > 0) {
            playTrack(tracks[idx - 1].filepath);
        } else if (tracks.length > 0) {
            playTrack(tracks[tracks.length - 1].filepath);
        }
    };

    // Listen for backend events
    useEffect(() => {
        let unlistenBuffering: () => void;
        let unlistenReady: () => void;
        let unlistenPlaying: () => void;
        let unlistenEnded: () => void;
        let unlistenError: () => void;
        let unlistenYtForbidden: () => void;
        let unlistenDownloaded: () => void;
        let unlistenPlayPause: () => void;
        let unlistenNext: () => void;
        let unlistenPrev: () => void;

        const setupListeners = async () => {
            const [
                uBuffering, uReady, uPlaying, uEnded, uError,
                uYtForbidden, uDownloaded, uPlayPause, uNext, uPrev,
            ] = await Promise.all([
                listen<boolean>('audio-buffering', (event) => {
                    setIsBuffering(event.payload);
                }),
                listen<boolean>('audio-ready', (_) => {
                    setIsBuffering(false);
                }),
                listen<string>('audio-playing', (event) => {
                    setIsPlaying(true);
                    setIsBuffering(false);
                    setCurrentTrackPath(event.payload);
                    // Immediate clock sample so the scrubber starts moving right away
                    invoke<{ position_ms: number; duration_ms: number }>('get_audio_clock')
                        .then((clock) => applyGstClockSample(clock.position_ms || 0, clock.duration_ms || 0))
                        .catch(() => {});
                }),
                listen<string>('audio-ended', (_) => {
                    setIsPlaying(false);
                    setIsBuffering(false);
                    if (onEndedRef.current) onEndedRef.current();
                }),
                listen<string>('audio-error', (event) => {
                    setIsPlaying(false);
                    setIsBuffering(false);
                    needsRestreamRef.current = true;
                    console.error('Audio error:', event.payload);
                    window.dispatchEvent(new CustomEvent('nekobeat-audio-error', { detail: event.payload }));
                }),
                listen('audio-youtube-forbidden', async () => {
                    if (retryingStreamRef.current || !lastStreamRef.current) return;
                    if (ytForbiddenRetriesRef.current >= 1) {
                        console.warn('YouTube stream failed after retry — giving up');
                        setIsBuffering(false);
                        setIsPlaying(false);
                        return;
                    }
                    ytForbiddenRetriesRef.current += 1;
                    retryingStreamRef.current = true;
                    const { url, source, trackId } = lastStreamRef.current;

                    if (trackId) {
                        try {
                            const liked = likedTracksRef.current.find((t: any) => t.id === trackId);
                            if (liked?.local_audio_path) {
                                await invoke('play_audio', { path: liked.local_audio_path });
                                setIsPlaying(true);
                                setIsBuffering(false);
                                needsRestreamRef.current = false;
                                retryingStreamRef.current = false;
                                return;
                            }
                        } catch { /* fall through to fresh stream */ }
                    }

                    setIsBuffering(true);
                    try {
                        await invoke<string>('stream_external_audio', {
                            url,
                            source,
                            title: null,
                            artist: null,
                        });
                        setIsPlaying(true);
                        needsRestreamRef.current = false;
                    } catch (e) {
                        console.error('YouTube re-stream failed:', e);
                        setIsBuffering(false);
                        setIsPlaying(false);
                    } finally {
                        retryingStreamRef.current = false;
                    }
                }),
                listen('liked-track-downloaded', async () => {
                    // Upgrade only while streaming the same track remotely — never yank a local liked play.
                    const trackId = currentExternalTrackIdRef.current;
                    const stream = lastStreamRef.current;
                    if (!trackId || !stream || stream.trackId !== trackId) return;
                    const remote = /^(https?:|spotify:)/i.test(stream.url)
                        || stream.url.includes('spotify.com')
                        || stream.url.includes('youtube.com')
                        || stream.url.includes('soundcloud');
                    if (!remote) return;
                    try {
                        const liked = likedTracksRef.current.find((t: any) => t.id === trackId);
                        if (!liked?.local_audio_path) return;
                        const epoch = ++playEpochRef.current;
                        resetClock();
                        await invoke('play_audio', { path: liked.local_audio_path });
                        if (epoch !== playEpochRef.current) return;
                        lastStreamRef.current = { url: liked.local_audio_path, source: 'local', trackId };
                        setCurrentTrackPath(liked.local_audio_path);
                        setIsPlaying(true);
                        setIsBuffering(false);
                        needsRestreamRef.current = false;
                    } catch (e) {
                        console.warn('Failed to switch to downloaded cache:', e);
                    }
                }),
                listen('shortcut-play-pause', () => {
                    // MediaSession ALSO handles play/pause on Windows — both fire for one
                    // media key. Never toggle: pause only if playing & not resume-guarded.
                    setIsPlaying(prev => {
                        if (prev) {
                            if (isResumeGuarded()) {
                                console.log("Ignoring shortcut pause — resume guard active");
                                return prev;
                            }
                            invoke('pause_audio').catch(() => {});
                            return false;
                        }
                        armResumeGuard(1200);
                        invoke('resume_audio')
                            .then(() => setIsBuffering(false))
                            .catch(() => {
                                needsRestreamRef.current = true;
                            });
                        return true;
                    });
                }),
                listen('shortcut-next', () => {
                    const tr = getTracks();
                    playNext(tr);
                }),
                listen('shortcut-prev', () => {
                    const tr = getTracks();
                    playPrev(tr);
                }),
            ]);
            unlistenBuffering = uBuffering;
            unlistenReady = uReady;
            unlistenPlaying = uPlaying;
            unlistenEnded = uEnded;
            unlistenError = uError;
            unlistenYtForbidden = uYtForbidden;
            unlistenDownloaded = uDownloaded;
            unlistenPlayPause = uPlayPause;
            unlistenNext = uNext;
            unlistenPrev = uPrev;
        };

        setupListeners();
        return () => {
            if (unlistenBuffering) unlistenBuffering();
            if (unlistenReady) unlistenReady();
            if (unlistenPlaying) unlistenPlaying();
            if (unlistenEnded) unlistenEnded();
            if (unlistenError) unlistenError();
            if (unlistenYtForbidden) unlistenYtForbidden();
            if (unlistenDownloaded) unlistenDownloaded();
            if (unlistenPlayPause) unlistenPlayPause();
            if (unlistenNext) unlistenNext();
            if (unlistenPrev) unlistenPrev();
        };
    }, []);

    // Poll GStreamer position while playing — UI shows GST truth only
    useEffect(() => {
        setAudioClockWallTracking(isPlaying);
    }, [isPlaying]);

    useEffect(() => {
        let interval: ReturnType<typeof setInterval> | undefined;
        let cancelled = false;
        let inFlight = false;

        const poll = async () => {
            if (inFlight || cancelled) return;
            inFlight = true;
            try {
                const clock = await invoke<{ position_ms: number; duration_ms: number }>('get_audio_clock');
                if (cancelled) return;
                const pos = clock.position_ms || 0;
                const dur = clock.duration_ms || 0;
                applyGstClockSample(pos, dur);
                if (dur > 0) {
                    setDurationMs((prev) => (prev === dur ? prev : dur));
                }
            } catch { /* ignore transient IPC */ }
            finally {
                inFlight = false;
            }
        };

        if (isPlaying) {
            poll(); // don't wait for first interval tick
            interval = setInterval(poll, 100);
        }
        return () => {
            cancelled = true;
            if (interval) clearInterval(interval);
        };
    }, [isPlaying, currentTrackPath]);

    return {
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
        playPrev,
    };
}

export type AggregatedTrack = {
    id: string;
    title: string;
    artist: string;
    album: string;
    duration_ms: number;
    artwork_url: string;
    source: string;
    stream_url?: string;
};

export function useAggregatorSearch() {
    const [results, setResults] = useState<AggregatedTrack[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
    const [hasMore, setHasMore] = useState(true);
    const pageRef = useRef(0);
    const lastQueryRef = useRef('');
    const lastSourceRef = useRef('youtube');

    const fetchPage = async (query: string, source: string, page: number): Promise<AggregatedTrack[]> => {
        if (source === 'all') {
            const [ytResults, scResults, spResults] = await Promise.allSettled([
                invoke<AggregatedTrack[]>('search_external', { query, source: 'youtube', page }),
                invoke<AggregatedTrack[]>('search_external', { query, source: 'soundcloud', page }),
                invoke<AggregatedTrack[]>('search_external', { query, source: 'spotify', page }),
            ]);

            const errs: Record<string, string> = {};
            const yt = ytResults.status === 'fulfilled' ? ytResults.value : [];
            const sc = scResults.status === 'fulfilled' ? scResults.value : [];
            const sp = spResults.status === 'fulfilled' ? spResults.value : [];
            if (ytResults.status === 'rejected') errs.youtube = String(ytResults.reason);
            if (scResults.status === 'rejected') errs.soundcloud = String(scResults.reason);
            if (spResults.status === 'rejected') {
                const reason = String(spResults.reason);
                // Soft-skip missing Spotify helper (esp. Android) — don't scare the user
                if (!/not found|unavailable|mobile|soft-skip/i.test(reason)) {
                    errs.spotify = reason;
                }
            }
            setSourceErrors(errs);

            // Interleave: prefer non-snipped SC (backend already sorts), 2 YT, 1 SC, 1 SP
            const merged: AggregatedTrack[] = [];
            let yi = 0, si = 0, pi = 0;
            while (yi < yt.length || si < sc.length || pi < sp.length) {
                if (yi < yt.length) merged.push(yt[yi++]);
                if (yi < yt.length) merged.push(yt[yi++]);
                if (si < sc.length) merged.push(sc[si++]);
                if (pi < sp.length) merged.push(sp[pi++]);
            }
            return merged;
        } else {
            setSourceErrors({});
            return await invoke<AggregatedTrack[]>('search_external', { query, source, page });
        }
    };

    const search = async (query: string, source: string = 'youtube') => {
        if (!query.trim()) {
            setResults([]);
            setHasMore(true);
            return;
        }

        pageRef.current = 0;
        lastQueryRef.current = query;
        lastSourceRef.current = source;
        setIsLoading(true);
        setError(null);
        setHasMore(true);

        try {
            const newResults = await fetchPage(query, source, 0);
            setResults(newResults);
            if (newResults.length === 0) setHasMore(false);
        } catch (e) {
            setError("Failed to fetch results from external sources.");
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    const loadMore = async () => {
        if (isLoadingMore || !hasMore || !lastQueryRef.current) return;
        
        setIsLoadingMore(true);
        pageRef.current += 1;

        try {
            const newResults = await fetchPage(lastQueryRef.current, lastSourceRef.current, pageRef.current);
            if (newResults.length === 0) {
                setHasMore(false);
            } else {
                // Deduplicate by ID before appending
                setResults(prev => {
                    const existingIds = new Set(prev.map(t => t.id));
                    const unique = newResults.filter(t => !existingIds.has(t.id));
                    if (unique.length === 0) setHasMore(false);
                    return [...prev, ...unique];
                });
            }
        } catch (e) {
            console.error("Failed to load more results:", e);
        } finally {
            setIsLoadingMore(false);
        }
    };

    return { results, isLoading, isLoadingMore, hasMore, error, sourceErrors, search, loadMore };
}

/** Explicit up-next queue for flagship playback (search / likes / Listen). */
export type QueueTrack = AggregatedTrack & {
    stream_url?: string;
    playbackContext?: 'search' | 'liked' | 'queue';
    local_audio_path?: string;
    local_artwork_path?: string;
    local_lyrics?: string;
};

export function usePlayQueue() {
    const [queue, setQueue] = useState<QueueTrack[]>([]);
    const [currentIndex, setCurrentIndex] = useState(-1);
    const [showQueue, setShowQueue] = useState(false);

    const replaceQueue = useCallback((tracks: QueueTrack[], startIndex = 0) => {
        setQueue(tracks);
        setCurrentIndex(tracks.length === 0 ? -1 : Math.max(0, Math.min(startIndex, tracks.length - 1)));
    }, []);

    const playFromList = useCallback((tracks: QueueTrack[], startId?: string) => {
        let idx = 0;
        if (startId) {
            const found = tracks.findIndex((t) => t.id === startId);
            idx = found >= 0 ? found : 0;
            if (found < 0) {
                console.warn('playFromList: startId not in queue, starting at 0', startId);
            }
        }
        setQueue(tracks);
        setCurrentIndex(tracks.length === 0 ? -1 : idx);
        return tracks[idx] ?? null;
    }, []);

    const enqueue = useCallback((track: QueueTrack) => {
        setQueue((prev) => {
            if (prev.some((t) => t.id === track.id)) return prev;
            return [...prev, track];
        });
    }, []);

    const clearQueue = useCallback(() => {
        setQueue([]);
        setCurrentIndex(-1);
    }, []);

    const peekNext = useCallback((loop = false): QueueTrack | null => {
        if (queue.length === 0 || currentIndex < 0) return null;
        if (currentIndex + 1 < queue.length) return queue[currentIndex + 1];
        if (loop && queue.length > 0) return queue[0];
        return null;
    }, [queue, currentIndex]);

    const peekPrev = useCallback((): QueueTrack | null => {
        if (currentIndex <= 0) return null;
        return queue[currentIndex - 1];
    }, [queue, currentIndex]);

    const advance = useCallback((loop = false): QueueTrack | null => {
        if (queue.length === 0) return null;
        let next = currentIndex + 1;
        if (next >= queue.length) {
            if (!loop) return null;
            next = 0;
        }
        setCurrentIndex(next);
        return queue[next];
    }, [queue, currentIndex]);

    const retreat = useCallback((): QueueTrack | null => {
        if (queue.length === 0 || currentIndex <= 0) return null;
        const prev = currentIndex - 1;
        setCurrentIndex(prev);
        return queue[prev];
    }, [queue, currentIndex]);

    /** Reorder by absolute queue indices; keeps current track identity. */
    const reorderQueue = useCallback((fromIndex: number, toIndex: number) => {
        if (fromIndex === toIndex) return;
        setQueue((prev) => {
            if (
                fromIndex < 0 || toIndex < 0 ||
                fromIndex >= prev.length || toIndex >= prev.length
            ) return prev;
            const next = [...prev];
            const [item] = next.splice(fromIndex, 1);
            next.splice(toIndex, 0, item);
            return next;
        });
        setCurrentIndex((ci) => {
            if (ci < 0) return ci;
            if (fromIndex === ci) return toIndex;
            if (fromIndex < ci && toIndex >= ci) return ci - 1;
            if (fromIndex > ci && toIndex <= ci) return ci + 1;
            return ci;
        });
    }, []);

    const moveQueueItem = useCallback((fromIndex: number, direction: -1 | 1) => {
        const toIndex = fromIndex + direction;
        reorderQueue(fromIndex, toIndex);
    }, [reorderQueue]);

    const current = currentIndex >= 0 ? queue[currentIndex] ?? null : null;
    const upNext = currentIndex >= 0 ? queue.slice(currentIndex + 1) : queue;

    /** Upcoming rows for UI — when loop is on, append wrap-around from the start. */
    const getUpcoming = useCallback((loop = false): Array<{ track: QueueTrack; queueIndex: number; looped: boolean }> => {
        if (queue.length === 0) return [];
        if (currentIndex < 0) {
            return queue.map((track, queueIndex) => ({ track, queueIndex, looped: false }));
        }
        const after = queue.slice(currentIndex + 1).map((track, i) => ({
            track,
            queueIndex: currentIndex + 1 + i,
            looped: false,
        }));
        if (!loop || queue.length <= 1) return after;
        const wrap = queue.slice(0, currentIndex).map((track, queueIndex) => ({
            track,
            queueIndex,
            looped: true,
        }));
        return [...after, ...wrap];
    }, [queue, currentIndex]);

    return {
        queue,
        currentIndex,
        current,
        upNext,
        getUpcoming,
        showQueue,
        setShowQueue,
        replaceQueue,
        playFromList,
        enqueue,
        clearQueue,
        peekNext,
        peekPrev,
        advance,
        retreat,
        reorderQueue,
        moveQueueItem,
        setCurrentIndex,
    };
}

export type TrackData = {
    id?: string;
    filepath: string;
    title: string;
    artist: string;
    album: string;
    duration_ms: number;
    artwork_url?: string;
    source?: string;
    stream_url?: string;
    local_audio_path?: string;
    local_lyrics?: string;
};

export function useLibrary() {
    const [tracks, setTracks] = useState<TrackData[]>([]);
    const [isScanning, setIsScanning] = useState(false);

    const loadCachedTracks = async () => {
        try {
            const cached = await invoke<TrackData[]>('get_cached_tracks');
            setTracks(cached);
        } catch (e) {
            console.error("Failed to load cached tracks:", e);
        }
    };

    const scanDirectory = async (directory: string) => {
        setIsScanning(true);
        try {
            const scanned = await invoke<TrackData[]>('scan_directory', { path: directory });
            setTracks(prev => {
                // Simple merge, avoiding duplicates based on filepath
                const map = new Map(prev.map(t => [t.filepath, t]));
                scanned.forEach(t => map.set(t.filepath, t));
                return Array.from(map.values());
            });
        } catch (e) {
            console.error("Failed to scan directory:", e);
        } finally {
            setIsScanning(false);
        }
    };

    const clearLibrary = async () => {
        try {
            await invoke<number>('clear_library');
            setTracks([]);
        } catch (e) {
            console.error("Failed to clear library:", e);
            throw e;
        }
    };

    useEffect(() => {
        loadCachedTracks();
    }, []);

    return {
        tracks,
        isScanning,
        scanDirectory,
        clearLibrary,
        loadCachedTracks
    };
}

export type LikedTrack = {
    id: string;
    title: string;
    artist: string;
    album: string;
    duration_ms: number;
    artwork_url: string;
    source: string;
    stream_url?: string;
    local_audio_path?: string;
    local_artwork_path?: string;
    local_lyrics?: string;
};

export function useLikedLibrary() {
    const [likedTracks, setLikedTracks] = useState<LikedTrack[]>([]);
    const [isLiking, setIsLiking] = useState<Record<string, boolean>>({});

    const loadLikedTracks = async () => {
        try {
            const tracks = await invoke<LikedTrack[]>('get_liked_tracks');
            setLikedTracks(tracks);
        } catch (e) {
            console.error("Failed to load liked tracks:", e);
        }
    };

    useEffect(() => {
        loadLikedTracks();
        
        // Listen for backend downloads completing so we can refresh
        const unlisten = listen('liked-track-downloaded', () => {
            loadLikedTracks();
        });

        return () => {
            unlisten.then(f => f());
        };
    }, []);

    const toggleLike = async (track: any, currentLyrics?: string, playingLocalPath?: string | null) => {
        const trackId = track.id || track.stream_url;
        if (!trackId) return;

        // Canonical source URL for re-resolve; prefer currently playing local file as stream_url
        // so offline copies the exact audio the user heard (correct YT match).
        const id = track.id || '';
        let canonicalUrl = track.stream_url;
        if (track.source === 'youtube' || id.startsWith('yt-')) {
            canonicalUrl = `https://www.youtube.com/watch?v=${id.replace('yt-', '')}`;
        } else if (track.source === 'soundcloud' || id.startsWith('sc-')) {
            canonicalUrl = `https://api-v2.soundcloud.com/tracks/${id.replace('sc-', '')}`;
        } else if (track.source === 'spotify' || id.startsWith('sp-')) {
            canonicalUrl = `https://open.spotify.com/track/${id.replace('sp-', '')}`;
        }

        let streamUrlForLike = canonicalUrl;
        let local = (playingLocalPath || '').trim();
        if (local && !/^https?:\/\//i.test(local) && !local.includes('googlevideo') && !local.includes('spotify.com')) {
            if (local.startsWith('file:')) {
                streamUrlForLike = local;
            } else if (/^[a-zA-Z]:[\\/]/.test(local) || local.startsWith('\\\\')) {
                // Windows absolute path → file:///C:/...
                const cleaned = local.replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
                streamUrlForLike = `file:///${cleaned}`;
            } else {
                // Unix/Android absolute path → file:///data/...
                const abs = local.startsWith('/') ? local : `/${local}`;
                streamUrlForLike = `file://${abs}`;
            }
        }

        setIsLiking(prev => ({ ...prev, [trackId]: true }));
        try {
            await invoke<boolean>('toggle_like', { 
                track: {
                    id: track.id,
                    title: track.title,
                    artist: track.artist,
                    album: track.album || "",
                    duration_ms: track.duration_ms || 0,
                    artwork_url: track.artwork_url || "",
                    source: track.source || "external",
                    stream_url: streamUrlForLike
                },
                lyrics: currentLyrics || null
            });
            await loadLikedTracks();
        } catch (e) {
            console.error("Failed to toggle like:", e);
        } finally {
            setIsLiking(prev => ({ ...prev, [trackId]: false }));
        }
    };

    return { likedTracks, isLiking, toggleLike, loadLikedTracks };
}

export function useEqualizer() {
    const [gains, setGains] = useState<number[]>(() => {
        const saved = localStorage.getItem('nekobeat_eq_gains');
        return saved ? JSON.parse(saved) : Array(10).fill(0);
    });

    const updateGain = (index: number, value: number) => {
        const newGains = [...gains];
        newGains[index] = value;
        setGains(newGains);
        localStorage.setItem('nekobeat_eq_gains', JSON.stringify(newGains));
        
        // Invoke backend
        invoke('set_eq_band', { band: index, gain: value }).catch(e => {
            console.error(`Failed to set EQ band ${index}:`, e);
        });
    };

    const resetGains = () => {
        applyPreset(Array(10).fill(0));
    };

    const applyPreset = (newGains: number[]) => {
        setGains(newGains);
        localStorage.setItem('nekobeat_eq_gains', JSON.stringify(newGains));
        
        newGains.forEach((gain, index) => {
            // Clamp for safety as usual
            const clamped = Math.max(-24, Math.min(12, gain));
            invoke('set_eq_band', { band: index, gain: clamped }).catch(() => {});
        });
    };

    // Apply all gains on init (if needed, or when GStreamer resets)
    useEffect(() => {
        gains.forEach((gain, index) => {
            if (gain !== 0) {
                const clamped = Math.max(-24, Math.min(12, gain));
                invoke('set_eq_band', { band: index, gain: clamped }).catch(() => {});
            }
        });
    }, []);

    return { gains, updateGain, resetGains, applyPreset };
}

export const EQ_PRESETS = {
    'Flat': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    'Bass Boost': [7, 6, 5, 2, 0, 0, 0, 0, 0, 0],
    'Treble Boost': [0, 0, 0, 0, 0, 2, 4, 6, 7, 8],
    'Electronic': [5, 4, 2, 0, -2, 0, 2, 4, 5, 6],
    'Rock': [5, 4.5, 3, 1, -1, 0, 2, 3.5, 4.5, 5],
    'Pop': [-1.5, -1, 0, 2, 4, 4, 2, 0, -1, -1.5],
    'Vocal': [-3, -2, -1, 1, 3, 4, 4, 3, 1, -1],
    'Classical': [5, 4, 3, 2, -1, -1, 0, 2, 3, 4],
    'Jazz': [4, 3, 1, 2, -2, -2, 0, 1, 3, 4],
};
