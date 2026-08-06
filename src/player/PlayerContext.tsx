import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../lib/api";
import { getCoverSrc } from "../lib/coverCache";
import { isTauri } from "../lib/libraryHelpers";
import { pushRecentlyPlayed } from "../lib/recentlyPlayed";
import {
  DEFAULT_SETTINGS,
  type AccentPreset,
  type AppSettings,
  type LyricLine,
  type QueueItem,
  type RepeatMode,
  type TrackMeta,
} from "../lib/types";

type PlayerCtx = {
  queue: QueueItem[];
  index: number;
  current: QueueItem | null;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  volume: number;
  expanded: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  radio: boolean;
  liked: boolean;
  lyrics: LyricLine[];
  lyricsStatus: "idle" | "loading" | "ready" | "empty";
  coverSrc: string | null;
  settings: AppSettings;
  setSettings: (s: AppSettings) => void;
  setExpanded: (v: boolean) => void;
  playTrack: (track: TrackMeta, queue?: TrackMeta[]) => Promise<void>;
  toggle: () => Promise<void>;
  next: () => Promise<void>;
  prev: () => Promise<void>;
  seek: (ms: number) => Promise<void>;
  setVolume: (v: number) => Promise<void>;
  likeCurrent: () => Promise<void>;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  toggleRadio: () => void;
  jumpTo: (i: number) => Promise<void>;
  removeAt: (i: number) => void;
  moveQueueItem: (from: number, to: number) => void;
};

const Ctx = createContext<PlayerCtx | null>(null);

function qkey(t: TrackMeta, i: number) {
  return `${t.id}-${i}-${Date.now()}`;
}

function pickShuffledIndex(len: number, current: number): number {
  if (len <= 1) return current;
  let n = current;
  for (let tries = 0; tries < 8 && n === current; tries++) {
    n = Math.floor(Math.random() * len);
  }
  return n === current ? (current + 1) % len : n;
}

function sleep(ms: number) {
  return new Promise<void>((r) => window.setTimeout(r, ms));
}

async function rampVolume(from: number, to: number, durationMs: number) {
  if (durationMs <= 0 || Math.abs(from - to) < 0.001) {
    await api.setVolume(to).catch(() => {});
    return;
  }
  const steps = Math.max(8, Math.round(durationMs / 40));
  const stepMs = durationMs / steps;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const v = from + (to - from) * t;
    await api.setVolume(v).catch(() => {});
    await sleep(stepMs);
  }
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [volume, setVol] = useState(0.85);
  const [expanded, setExpanded] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const [radio, setRadio] = useState(() => {
    try {
      return localStorage.getItem("nb-radio") === "1";
    } catch {
      return false;
    }
  });
  const [liked, setLiked] = useState(false);
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [lyricsStatus, setLyricsStatus] = useState<
    "idle" | "loading" | "ready" | "empty"
  >("idle");
  const [coverSrc, setCoverSrc] = useState<string | null>(null);
  const [settings, setSettingsState] = useState<AppSettings>(DEFAULT_SETTINGS);
  const endedGuard = useRef(false);
  const userPaused = useRef(false);
  const wasPlaying = useRef(false);
  const lastNotifLine = useRef("");
  const queueRef = useRef(queue);
  const indexRef = useRef(index);
  const shuffleRef = useRef(shuffle);
  const repeatRef = useRef(repeat);
  const radioRef = useRef(radio);
  const volumeRef = useRef(volume);
  const settingsRef = useRef(settings);
  const transitioning = useRef(false);
  const playUriRef = useRef<(t: TrackMeta) => Promise<void>>(async () => {});

  queueRef.current = queue;
  indexRef.current = index;
  shuffleRef.current = shuffle;
  repeatRef.current = repeat;
  radioRef.current = radio;
  volumeRef.current = volume;
  settingsRef.current = settings;

  const current = queue[index] ?? null;

  useEffect(() => {
    api
      .settingsGet()
      .then((s) => {
        const merged: AppSettings = {
          ...DEFAULT_SETTINGS,
          ...s,
          accentPreset: (s.accentPreset ||
            DEFAULT_SETTINGS.accentPreset) as AccentPreset,
        };
        try {
          if (
            !localStorage.getItem("nb-design-neon-v1") &&
            merged.theme === "light"
          ) {
            localStorage.setItem("nb-design-neon-v1", "1");
            const next = { ...merged, theme: "dark" as const };
            setSettingsState(next);
            api.settingsSet(next).catch(() => {});
            return;
          }
        } catch {
          /* ignore */
        }
        setSettingsState(merged);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const apply = (mode: "light" | "dark") => {
      root.setAttribute("data-theme", mode);
    };
    if (settings.theme === "light") {
      apply("light");
    } else if (settings.theme === "dark") {
      apply("dark");
    } else {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const sync = () => apply(mq.matches ? "dark" : "light");
      sync();
      mq.addEventListener("change", sync);
      return () => mq.removeEventListener("change", sync);
    }
  }, [settings.theme]);

  useEffect(() => {
    const accent = settings.accentPreset || "coral";
    document.documentElement.setAttribute("data-accent", accent);
  }, [settings.accentPreset]);

  useEffect(() => {
    if (!isTauri()) return;
    let fails = 0;
    let tick = expanded ? 400 : 1200;
    const id = window.setInterval(() => {
      api
        .getStatus()
        .then((s) => {
          fails = 0;
          setPlaying((prev) => (prev === s.playing ? prev : s.playing));
          setPositionMs((prev) =>
            Math.abs(prev - s.positionMs) < 80 ? prev : s.positionMs,
          );
          setDurationMs((prev) => {
            const meta = queueRef.current[indexRef.current]?.durationMs || 0;
            // Prefer real metadata; never adopt tiny "live fake" durations
            if (s.durationMs >= 5_000) {
              return prev === s.durationMs ? prev : Math.max(prev, s.durationMs);
            }
            if (meta >= 5_000) return prev === meta ? prev : meta;
            if (s.durationMs > 0 && prev === 0) return s.durationMs;
            return prev;
          });
        })
        .catch(() => {
          fails += 1;
          if (fails > 8) window.clearInterval(id);
        });
    }, tick);
    return () => clearInterval(id);
  }, [expanded]);

  useEffect(() => {
    if (!current) {
      setLyrics([]);
      setLyricsStatus("idle");
      setCoverSrc(null);
      setLiked(false);
      return;
    }
    let cancelled = false;
    setLyricsStatus("loading");
    setLiked(false);
    api
      .libraryLiked()
      .then((rows) => {
        if (!cancelled) setLiked(rows.some((t) => t.id === current.id));
      })
      .catch(() => {});
    getCoverSrc(current).then((url) => {
      if (!cancelled) setCoverSrc(url);
    });
    const t = window.setTimeout(() => {
      getCoverSrc(current).then((url) => {
        if (!cancelled && url) setCoverSrc(url);
      });
    }, 800);
    api
      .getLyrics(current)
      .then((r) => {
        if (cancelled) return;
        const lines = r.lines ?? [];
        setLyrics(lines);
        setLyricsStatus(lines.length ? "ready" : "empty");
      })
      .catch(() => {
        if (cancelled) return;
        setLyrics([]);
        setLyricsStatus("empty");
      });
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [current?.id, current?.path, current?.coverUrl, current?.title, current?.artist]);

  useEffect(() => {
    if (!settings.discordRichPresence) return;
    if (!current) {
      api.discordClear().catch(() => {});
      return;
    }
    api.discordUpdate(current, playing, positionMs).catch(() => {});
  }, [current?.id, playing, settings.discordRichPresence]);

  useEffect(() => {
    if (!settings.notificationLyrics || !current || !lyrics.length) return;
    const line =
      [...lyrics].reverse().find((l) => l.timeMs <= positionMs)?.text ?? "";
    if (!line) return;
    const key = `${current.id}|${line}`;
    if (lastNotifLine.current === key) return;
    lastNotifLine.current = key;
    api
      .lyricsNotifShow(current.title, current.artist, line)
      .catch(() => {});
  }, [positionMs, lyrics, current?.id, current?.title, current?.artist, settings.notificationLyrics]);

  const playUri = useCallback(async (track: TrackMeta) => {
    let playMeta = { ...track };
    let uri = track.path || "";
    const needsResolve =
      track.source === "stream" ||
      track.source === "hifi" ||
      !uri ||
      uri.startsWith("http");

    const resolveAndPlay = async (invalidateFirst: boolean) => {
      if (invalidateFirst) {
        await api.invalidateStream(track.id).catch(() => {});
      }
      if (needsResolve || invalidateFirst) {
        const resolved = await api.resolveStream(track);
        uri = resolved.proxyUrl;
        playMeta = {
          ...track,
          ...resolved.track,
          coverUrl: resolved.track.coverUrl || track.coverUrl,
          title: resolved.track.title || track.title,
          artist: resolved.track.artist || track.artist,
        };
        if (!uri.startsWith("http")) {
          playMeta = { ...playMeta, path: uri };
        }
      }
      if (!uri) throw new Error("No playable URI");
      userPaused.current = false;
      wasPlaying.current = true;
      setPlaying(true);
      setPositionMs(0);
      await api.play(uri, playMeta);
    };

    try {
      await resolveAndPlay(false);
    } catch (e) {
      const msg = String(e);
      if (
        /rodio|corrupt|Unsupported|WebM|decoder panic|bad cache|incomplete|Ogg|M4A|Prefer MP3|remux|Unrecognized/i.test(
          msg,
        )
      ) {
        try {
          await resolveAndPlay(true);
        } catch (e2) {
          setPlaying(false);
          throw e2;
        }
      } else {
        setPlaying(false);
        throw e;
      }
    }

    setQueue((prev) => {
      const next = [...prev];
      const i = next.findIndex((t) => t.id === track.id);
      if (i >= 0) next[i] = { ...next[i], ...playMeta };
      return next;
    });
    if (playMeta.durationMs) setDurationMs(playMeta.durationMs);
    void getCoverSrc(playMeta).then(setCoverSrc);
    endedGuard.current = false;

    // Monochrome-style next-track warm: resolve next queue stream quietly.
    const q = queueRef.current;
    const i = indexRef.current;
    const nxt = q[i + 1];
    if (
      nxt &&
      (nxt.source === "stream" ||
        nxt.source === "hifi" ||
        !nxt.path ||
        nxt.path.startsWith("http"))
    ) {
      window.setTimeout(() => {
        void api.resolveStream(nxt).catch(() => {});
      }, 600);
    }
  }, []);

  playUriRef.current = playUri;

  const playTrack = useCallback(
    async (track: TrackMeta, list?: TrackMeta[]) => {
      pushRecentlyPlayed(track);
      const q = (list ?? [track]).map((t, i) => ({
        ...t,
        queueKey: qkey(t, i),
      }));
      const idx = Math.max(
        0,
        q.findIndex((t) => t.id === track.id),
      );
      setQueue(q);
      setIndex(idx);
      setPlaying(false);
      setPositionMs(0);
      if (track.durationMs) setDurationMs(track.durationMs);
      try {
        await playUri(q[idx]);
        const uv = volumeRef.current;
        await api.setVolume(uv).catch(() => {});
      } catch (e) {
        console.error("play failed", e);
        setPlaying(false);
        throw e instanceof Error ? e : new Error(String(e));
      }
    },
    [playUri],
  );

  const toggle = useCallback(async () => {
    if (playing) {
      userPaused.current = true;
      await api.pause();
      setPlaying(false);
    } else {
      userPaused.current = false;
      await api.resume();
      setPlaying(true);
    }
  }, [playing]);

  const advanceTo = useCallback(async (n: number) => {
    const q = queueRef.current;
    if (n < 0 || n >= q.length) return;
    setIndex(n);
    setPositionMs(0);
    userPaused.current = false;
    endedGuard.current = false;
    const t = q[n];
    setDurationMs(t.durationMs || 0);
    pushRecentlyPlayed(t);
    await playUriRef.current(t);
  }, []);

  const advanceWithFade = useCallback(
    async (n: number) => {
      if (transitioning.current) return;
      const xf = Number(settingsRef.current.crossfadeSeconds) || 0;
      if (xf <= 0) {
        await advanceTo(n);
        return;
      }
      transitioning.current = true;
      const uv = volumeRef.current;
      const half = (xf * 1000) / 2;
      try {
        await rampVolume(uv, 0, half);
        await advanceTo(n);
        await rampVolume(0, uv, half);
      } finally {
        transitioning.current = false;
        endedGuard.current = false;
        await api.setVolume(uv).catch(() => {});
      }
    },
    [advanceTo],
  );

  const next = useCallback(async () => {
    const q = queueRef.current;
    const i = indexRef.current;
    const mode = repeatRef.current;
    if (!q.length) return;
    if (mode === "one") {
      await api.seek(0);
      setPositionMs(0);
      await api.resume().catch(() => {});
      setPlaying(true);
      return;
    }
    if (shuffleRef.current && !(i >= q.length - 1 && radioRef.current)) {
      await advanceWithFade(pickShuffledIndex(q.length, i));
      return;
    }
    if (i >= q.length - 1) {
      if (radioRef.current) {
        const seed = q[i];
        const query = [seed?.artist, seed?.album || "similar"]
          .filter(Boolean)
          .join(" ")
          .trim();
        try {
          const found = await api.searchStream(query || seed?.title || "music");
          const known = new Set(q.map((t) => t.id));
          const fresh = found
            .filter((t) => t.id && !known.has(t.id))
            .slice(0, 12)
            .map((t, j) => ({
              ...t,
              queueKey: qkey(t, q.length + j),
            }));
          if (fresh.length) {
            const nextQ = [...q, ...fresh];
            setQueue(nextQ);
            await advanceWithFade(i + 1);
            return;
          }
        } catch {
          /* fall through */
        }
      }
      if (mode === "all") await advanceWithFade(0);
      return;
    }
    await advanceWithFade(i + 1);
  }, [advanceWithFade]);

  const prev = useCallback(async () => {
    if (positionMs > 3000) {
      await api.seek(0);
      setPositionMs(0);
      return;
    }
    const q = queueRef.current;
    const i = indexRef.current;
    if (i <= 0) {
      if (repeatRef.current === "all" && q.length)
        await advanceWithFade(q.length - 1);
      return;
    }
    await advanceWithFade(i - 1);
  }, [advanceWithFade, positionMs]);

  // Auto-advance near end — only with a trusted duration (streams often report 0)
  useEffect(() => {
    if (!playing || transitioning.current) return;
    const trusted =
      durationMs >= 8_000 &&
      !(durationMs <= positionMs + 2_500 && durationMs < 30_000);
    if (!trusted) return;
    const xfMs = (Number(settings.crossfadeSeconds) || 0) * 1000;
    const threshold = xfMs > 0 ? Math.max(500, xfMs) : 400;
    if (positionMs < durationMs - threshold) {
      endedGuard.current = false;
      return;
    }
    if (endedGuard.current) return;
    endedGuard.current = true;
    void next();
  }, [positionMs, durationMs, playing, next, settings.crossfadeSeconds]);

  // Natural end when duration unknown (live stream): backend reports not playing
  useEffect(() => {
    if (playing) {
      wasPlaying.current = true;
      return;
    }
    if (!wasPlaying.current || userPaused.current || transitioning.current) {
      return;
    }
    wasPlaying.current = false;
    if (positionMs < 2_500) return;
    if (endedGuard.current) return;
    const trusted = durationMs >= 8_000;
    if (trusted && positionMs < durationMs - 1_500) return;
    endedGuard.current = true;
    void next();
  }, [playing, positionMs, durationMs, next]);

  const seek = useCallback(async (ms: number) => {
    await api.seek(ms);
    setPositionMs(ms);
  }, []);

  const setVolume = useCallback(async (v: number) => {
    setVol(v);
    await api.setVolume(v);
  }, []);

  const likeCurrent = useCallback(async () => {
    if (!current) return;
    const nextLiked = !liked;
    setLiked(nextLiked);
    try {
      await api.libraryLike(current.id, nextLiked);
    } catch {
      setLiked(!nextLiked);
    }
  }, [current, liked]);

  const toggleShuffle = useCallback(() => setShuffle((s) => !s), []);
  const cycleRepeat = useCallback(() => {
    setRepeat((r) => (r === "off" ? "all" : r === "all" ? "one" : "off"));
  }, []);
  const toggleRadio = useCallback(() => {
    setRadio((r) => {
      const next = !r;
      try {
        localStorage.setItem("nb-radio", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const jumpTo = useCallback(
    async (i: number) => {
      await advanceWithFade(i);
    },
    [advanceWithFade],
  );

  const removeAt = useCallback((i: number) => {
    const q = queueRef.current;
    const cur = indexRef.current;
    if (i < 0 || i >= q.length) return;
    const nextQ = q.filter((_, idx) => idx !== i);
    let nextIdx = cur;
    if (i < cur) nextIdx = cur - 1;
    else if (i === cur) nextIdx = Math.min(cur, Math.max(0, nextQ.length - 1));
    setQueue(nextQ);
    setIndex(nextIdx);
    if (i === cur && nextQ[nextIdx]) {
      void playUriRef.current(nextQ[nextIdx]);
    }
  }, []);

  const moveQueueItem = useCallback((from: number, to: number) => {
    const q = [...queueRef.current];
    if (
      from < 0 ||
      to < 0 ||
      from >= q.length ||
      to >= q.length ||
      from === to
    ) {
      return;
    }
    const [item] = q.splice(from, 1);
    q.splice(to, 0, item);
    let cur = indexRef.current;
    if (from === cur) cur = to;
    else if (from < cur && to >= cur) cur -= 1;
    else if (from > cur && to <= cur) cur += 1;
    setQueue(q);
    setIndex(cur);
  }, []);

  const setSettings = useCallback((s: AppSettings) => {
    setSettingsState(s);
    api.settingsSet(s).catch(() => {});
  }, []);

  const value = useMemo(
    () => ({
      queue,
      index,
      current,
      playing,
      positionMs,
      durationMs,
      volume,
      expanded,
      shuffle,
      repeat,
      radio,
      liked,
      lyrics,
      lyricsStatus,
      coverSrc,
      settings,
      setSettings,
      setExpanded,
      playTrack,
      toggle,
      next,
      prev,
      seek,
      setVolume,
      likeCurrent,
      toggleShuffle,
      cycleRepeat,
      toggleRadio,
      jumpTo,
      removeAt,
      moveQueueItem,
    }),
    [
      queue,
      index,
      current,
      playing,
      positionMs,
      durationMs,
      volume,
      expanded,
      shuffle,
      repeat,
      radio,
      liked,
      lyrics,
      lyricsStatus,
      coverSrc,
      settings,
      setSettings,
      playTrack,
      toggle,
      next,
      prev,
      seek,
      setVolume,
      likeCurrent,
      toggleShuffle,
      cycleRepeat,
      toggleRadio,
      jumpTo,
      removeAt,
      moveQueueItem,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlayer() {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePlayer outside provider");
  return v;
}
