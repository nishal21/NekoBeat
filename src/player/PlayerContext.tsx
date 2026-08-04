import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api } from "../lib/api";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type LyricLine,
  type QueueItem,
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
  lyrics: LyricLine[];
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
};

const Ctx = createContext<PlayerCtx | null>(null);

function qkey(t: TrackMeta, i: number) {
  return `${t.id}-${i}-${Date.now()}`;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [volume, setVol] = useState(0.85);
  const [expanded, setExpanded] = useState(false);
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [coverSrc, setCoverSrc] = useState<string | null>(null);
  const [settings, setSettingsState] = useState<AppSettings>(DEFAULT_SETTINGS);

  const current = queue[index] ?? null;

  useEffect(() => {
    api.settingsGet().then(setSettingsState).catch(() => {});
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    const id = window.setInterval(() => {
      api
        .getStatus()
        .then((s) => {
          setPlaying(s.playing);
          setPositionMs(s.positionMs);
          setDurationMs(s.durationMs);
        })
        .catch(() => {});
    }, 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!current) {
      setLyrics([]);
      setCoverSrc(null);
      return;
    }
    api
      .resolveCover(current)
      .then(setCoverSrc)
      .catch(() => setCoverSrc(current.coverUrl ?? null));
    api
      .getLyrics(current)
      .then((r) => setLyrics(r.lines ?? []))
      .catch(() => setLyrics([]));
  }, [current?.id, current?.path, current?.coverUrl]);

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
    api
      .lyricsNotifShow(current.title, current.artist, line)
      .catch(() => {});
  }, [positionMs, lyrics, current?.id, settings.notificationLyrics]);

  const playUri = useCallback(async (track: TrackMeta) => {
    let uri = track.path || track.streamUrl || "";
    if (!uri && track.source !== "local") {
      const resolved = await api.resolveStream(track);
      uri = resolved.proxyUrl;
      track = { ...track, ...resolved.track, streamUrl: uri };
    }
    await api.play(uri, track);
    setPlaying(true);
  }, []);

  const playTrack = useCallback(
    async (track: TrackMeta, list?: TrackMeta[]) => {
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
      await playUri(q[idx]);
    },
    [playUri],
  );

  const toggle = useCallback(async () => {
    if (playing) await api.pause();
    else await api.resume();
    setPlaying(!playing);
  }, [playing]);

  const next = useCallback(async () => {
    if (index >= queue.length - 1) return;
    const n = index + 1;
    setIndex(n);
    await playUri(queue[n]);
  }, [index, queue, playUri]);

  const prev = useCallback(async () => {
    if (positionMs > 3000) {
      await api.seek(0);
      setPositionMs(0);
      return;
    }
    if (index <= 0) return;
    const n = index - 1;
    setIndex(n);
    await playUri(queue[n]);
  }, [index, queue, playUri, positionMs]);

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
    await api.libraryLike(current.id, true);
  }, [current]);

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
      lyrics,
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
      lyrics,
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
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlayer() {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePlayer outside provider");
  return v;
}
