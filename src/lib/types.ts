/** Shared track metadata — one object from search → play → download. */
export type TrackMeta = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  coverUrl?: string;
  isrc?: string;
  spotifyId?: string;
  source?: "local" | "stream" | "hifi";
  path?: string;
  streamUrl?: string;
  qualityLabel?: string;
};

export type LyricLine = {
  timeMs: number;
  text: string;
};

export type QueueItem = TrackMeta & { queueKey: string };

/** SpotiFLAC Mobile–parity download + app settings */
export type AppSettings = {
  theme: "system" | "light" | "dark";
  discordRichPresence: boolean;
  notificationLyrics: boolean;
  sleepTimerMinutes: number | null;
  extensionRegistryUrl: string;
  metadataProviderPriority: string[];
  downloadProviderPriority: string[];
  hifiQuality: "LOSSLESS" | "HI_RES" | "HI_RES_LOSSLESS" | "HIGH";
  /** Preferred download extension/service id (tidal-web, amazon, qobuz-web…) */
  preferredDownloadService: string;
  askBeforeDownload: boolean;
  autoFallback: boolean;
  wifiOnlyDownloads: boolean;
  concurrentDownloads: number;
  songlinkRegion: string;
  embedMetadata: boolean;
  embedLyrics: boolean;
  embedMaxQualityCover: boolean;
  embedReplayGain: boolean;
  lyricsMode: "embed" | "sidecar" | "both";
  artistTagMode: string;
  filenameFormat: string;
  folderOrganization: "none" | "artist" | "album" | "artist_album";
  allowQualityVariants: boolean;
  skipDuplicates: boolean;
  tidalHighFormat: string;
  /** SpotiFLAC cloud API — default https://api.zarz.moe */
  zarzApiBase: string;
  scrobbleEnabled: boolean;
  gapless: boolean;
  crossfadeSeconds: number;
  eqBands: number[];
};

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  discordRichPresence: true,
  notificationLyrics: true,
  sleepTimerMinutes: null,
  extensionRegistryUrl: "https://github.com/zarzet/SpotiFLAC-Extension",
  metadataProviderPriority: ["spotify-web"],
  downloadProviderPriority: ["tidal-web", "amazon", "qobuz-web"],
  hifiQuality: "LOSSLESS",
  preferredDownloadService: "tidal-web",
  askBeforeDownload: true,
  autoFallback: true,
  wifiOnlyDownloads: false,
  concurrentDownloads: 2,
  songlinkRegion: "US",
  embedMetadata: true,
  embedLyrics: true,
  embedMaxQualityCover: true,
  embedReplayGain: false,
  lyricsMode: "both",
  artistTagMode: "default",
  filenameFormat: "{artist} - {title}",
  folderOrganization: "artist_album",
  allowQualityVariants: true,
  skipDuplicates: true,
  tidalHighFormat: "mp3_320",
  zarzApiBase: "https://api.zarz.moe",
  scrobbleEnabled: false,
  gapless: true,
  crossfadeSeconds: 0,
  eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};

export type ExtensionSettingField = {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "select" | "button" | "secret";
  value?: string | number | boolean;
  options?: { id: string; label: string }[];
  /** SpotiFLAC oauth_login_url pattern */
  oauthLoginUrl?: string;
  secret?: boolean;
};

export type ExtensionEntry = {
  id: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  category: string;
  downloadUrl: string;
  sha256?: string;
  installed?: boolean;
  enabled?: boolean;
  /** Logged-in / session present for download providers */
  loggedIn?: boolean;
  needsAuth?: boolean;
  settings?: ExtensionSettingField[];
};

export type ExtensionAuthPending = {
  extensionId: string;
  authUrl: string;
  hint?: string;
};

export type DownloadJob = {
  id: string;
  track: TrackMeta;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  filePath?: string;
  error?: string;
  measuredFormat?: string;
  requestedQuality?: string;
  bitDepth?: number;
  sampleRateHz?: number;
  service?: string;
  needsLogin?: boolean;
};
