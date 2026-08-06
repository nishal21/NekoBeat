import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  DownloadJob,
  ExtensionEntry,
  LyricLine,
  TrackMeta,
} from "./types";

export const api = {
  play: (uri: string, meta?: TrackMeta) =>
    invoke("playback_play", { uri, meta }),
  pause: () => invoke("playback_pause"),
  resume: () => invoke("playback_resume"),
  stop: () => invoke("playback_stop"),
  seek: (positionMs: number) => invoke("playback_seek", { positionMs }),
  setVolume: (volume: number) => invoke("playback_set_volume", { volume }),
  getStatus: () =>
    invoke<{
      playing: boolean;
      positionMs: number;
      durationMs: number;
      uri: string | null;
    }>("playback_status"),

  libraryScan: (paths: string[]) => invoke<TrackMeta[]>("library_scan", { paths }),
  libraryList: () => invoke<TrackMeta[]>("library_list"),
  libraryLike: (id: string, liked: boolean) =>
    invoke("library_like", { id, liked }),
  libraryLiked: () => invoke<TrackMeta[]>("library_liked"),

  searchStream: async (query: string) => {
    try {
      const rows = await invoke<TrackMeta[]>("stream_search", { query });
      if (rows?.length) return rows;
    } catch {
      /* failover */
    }
    try {
      return await invoke<TrackMeta[]>("hifi_search", { query });
    } catch {
      return [];
    }
  },
  resolveStream: (track: TrackMeta) =>
    invoke<{ proxyUrl: string; track: TrackMeta }>("stream_resolve", { track }),
  invalidateStream: (trackId: string) =>
    invoke("stream_invalidate", { trackId }),

  searchHifi: (query: string) => invoke<TrackMeta[]>("hifi_search", { query }),
  enqueueHifi: (track: TrackMeta) =>
    invoke<DownloadJob>("hifi_enqueue", { track }),
  hifiJobs: () => invoke<DownloadJob[]>("hifi_jobs"),
  hifiDownloadDir: () => invoke<string>("hifi_download_dir"),
  openPath: async (path: string) => {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(path);
  },

  getLyrics: (track: TrackMeta) =>
    invoke<{ lines: LyricLine[]; plain?: string }>("lyrics_get", { track }),
  resolveCover: (track: TrackMeta) =>
    invoke<string>("cover_resolve", { track }),

  extensionsList: () => invoke<ExtensionEntry[]>("extensions_list"),
  extensionsRefresh: () => invoke<ExtensionEntry[]>("extensions_refresh"),
  extensionsInstall: (id: string) => invoke("extensions_install", { id }),
  extensionsSetRegistry: (url: string) =>
    invoke("extensions_set_registry", { url }),
  extensionsSetPriority: (kind: string, ids: string[]) =>
    invoke("extensions_set_priority", { kind, ids }),
  extensionsGetSettings: (id: string) =>
    invoke<import("./types").ExtensionSettingField[]>(
      "extensions_get_settings",
      { id },
    ),
  extensionsSetSettings: (id: string, settings: Record<string, unknown>) =>
    invoke("extensions_set_settings", { id, settings }),
  extensionsStartLogin: (id: string) =>
    invoke<import("./types").ExtensionAuthPending>("extensions_start_login", {
      id,
    }),
  extensionsCompleteLogin: (id: string, authCode?: string) =>
    invoke("extensions_complete_login", { id, authCode }),
  extensionsLogout: (id: string) => invoke("extensions_logout", { id }),
  extensionsPendingAuth: () =>
    invoke<import("./types").ExtensionAuthPending | null>(
      "extensions_pending_auth",
    ),

  settingsGet: () => invoke<AppSettings>("settings_get"),
  settingsSet: (settings: AppSettings) =>
    invoke("settings_set", { settings }),

  discordUpdate: (track: TrackMeta | null, playing: boolean, positionMs: number) =>
    invoke("discord_update", { track, playing, positionMs }),
  discordClear: () => invoke("discord_clear"),

  lyricsNotifShow: (title: string, artist: string, line: string) =>
    invoke("lyrics_notif_show", { title, artist, line }),
  lyricsNotifHide: () => invoke("lyrics_notif_hide"),

  setEq: (bands: number[]) => invoke("playback_set_eq", { bands }),
  setSleepTimer: (minutes: number | null) =>
    invoke("playback_sleep_timer", { minutes }),

  zarzResolve: (args: { spotifyId?: string; url?: string }) =>
    invoke<{
      success: boolean;
      isrc?: string;
      spotifyId?: string;
      tidalId?: string;
      qobuzId?: string;
      deezerId?: string;
      songUrls: Record<string, string>;
      via?: string;
    }>("zarz_resolve", args),
  zarzConfig: () =>
    invoke<{
      announcementTitle?: string;
      announcementMessage?: string;
      ctaUrl?: string;
      ctaLabel?: string;
      announcementEnabled?: boolean;
      donateEnabled?: boolean;
      donateTitle?: string;
      donateMessage?: string;
    }>("zarz_config"),
  zarzDocsUrl: () => invoke<string>("zarz_docs_url"),
  zarzHealth: () =>
    invoke<{ status: string; version?: string }>("zarz_health"),
};
