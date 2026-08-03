/** NekoBeat playback / library prefs (Harmonoid-inspired, neon-branded). */

function boolPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return JSON.parse(v) === true;
  } catch {
    return fallback;
  }
}

export type LyricsAlign = 'left' | 'center' | 'right';
export type ReplayGainMode = 'off' | 'track' | 'album';
export type PlaylistQueueMode = 'replace' | 'append';
export type LyricsSize = 'small' | 'medium' | 'large';
export type AnimationIntensity = 'off' | 'reduced' | 'full';

export function loadPlaybackRate(): number {
  const value = Number(localStorage.getItem('nekobeat_playback_rate'));
  return Number.isFinite(value) ? Math.max(0.5, Math.min(2, value)) : 1;
}
export function savePlaybackRate(value: number) {
  localStorage.setItem('nekobeat_playback_rate', String(Math.max(0.5, Math.min(2, value))));
}

export function loadReplayGainMode(): ReplayGainMode {
  const value = localStorage.getItem('nekobeat_replay_gain_mode');
  return value === 'track' || value === 'album' ? value : 'off';
}
export function saveReplayGainMode(value: ReplayGainMode) {
  localStorage.setItem('nekobeat_replay_gain_mode', value);
}

export function loadReplayGainPreamp(): number {
  const value = Number(localStorage.getItem('nekobeat_replay_gain_preamp'));
  return Number.isFinite(value) ? Math.max(-12, Math.min(12, value)) : 0;
}
export function saveReplayGainPreamp(value: number) {
  localStorage.setItem('nekobeat_replay_gain_preamp', String(Math.max(-12, Math.min(12, value))));
}

export function loadShowAudioFormat(): boolean {
  return boolPref('nekobeat_show_audio_format', true);
}
export function saveShowAudioFormat(v: boolean) {
  localStorage.setItem('nekobeat_show_audio_format', JSON.stringify(v));
}

export function loadNotificationLyrics(): boolean {
  return boolPref('nekobeat_notification_lyrics', true);
}
export function saveNotificationLyrics(v: boolean) {
  localStorage.setItem('nekobeat_notification_lyrics', JSON.stringify(v));
}

export function loadCoverFallback(): boolean {
  return boolPref('nekobeat_cover_fallback', true);
}
export function saveCoverFallback(v: boolean) {
  localStorage.setItem('nekobeat_cover_fallback', JSON.stringify(v));
}

export function loadLrcFromDirectory(): boolean {
  return boolPref('nekobeat_lrc_from_directory', true);
}
export function saveLrcFromDirectory(v: boolean) {
  localStorage.setItem('nekobeat_lrc_from_directory', JSON.stringify(v));
}

export function loadExpandOnPlay(): boolean {
  return boolPref('nekobeat_expand_on_play', false);
}
export function saveExpandOnPlay(v: boolean) {
  localStorage.setItem('nekobeat_expand_on_play', JSON.stringify(v));
}

export function loadLyricsAlign(): LyricsAlign {
  const v = localStorage.getItem('nekobeat_lyrics_align');
  if (v === 'center' || v === 'right' || v === 'left') return v;
  return 'left';
}
export function saveLyricsAlign(v: LyricsAlign) {
  localStorage.setItem('nekobeat_lyrics_align', v);
}

export function loadRefreshAtStartup(): boolean {
  return boolPref('nekobeat_refresh_at_startup', false);
}
export function saveRefreshAtStartup(v: boolean) {
  localStorage.setItem('nekobeat_refresh_at_startup', JSON.stringify(v));
}

export function loadPlaylistQueueMode(): PlaylistQueueMode {
  return localStorage.getItem('nekobeat_playlist_queue_mode') === 'append' ? 'append' : 'replace';
}
export function savePlaylistQueueMode(v: PlaylistQueueMode) {
  localStorage.setItem('nekobeat_playlist_queue_mode', v);
}

export function loadPlaybackRestore(): boolean {
  return boolPref('nekobeat_playback_restore', true);
}
export function savePlaybackRestore(v: boolean) {
  localStorage.setItem('nekobeat_playback_restore', JSON.stringify(v));
}

export function loadWindowsTaskbarProgress(): boolean {
  return boolPref('nekobeat_windows_taskbar_progress', true);
}
export function saveWindowsTaskbarProgress(v: boolean) {
  localStorage.setItem('nekobeat_windows_taskbar_progress', JSON.stringify(v));
}

export function loadLyricsSize(): LyricsSize {
  const value = localStorage.getItem('nekobeat_lyrics_size');
  return value === 'small' || value === 'large' ? value : 'medium';
}
export function saveLyricsSize(v: LyricsSize) {
  localStorage.setItem('nekobeat_lyrics_size', v);
}

export function loadAnimationIntensity(): AnimationIntensity {
  const value = localStorage.getItem('nekobeat_animation_intensity');
  return value === 'off' || value === 'reduced' ? value : 'full';
}
export function saveAnimationIntensity(v: AnimationIntensity) {
  localStorage.setItem('nekobeat_animation_intensity', v);
}

export function loadAndroidOnlineOptIn(): boolean {
  return boolPref('nekobeat_android_online_opt_in', false);
}
export function saveAndroidOnlineOptIn(v: boolean) {
  localStorage.setItem('nekobeat_android_online_opt_in', JSON.stringify(v));
}

export type LibrarySubTab = 'tracks' | 'artists' | 'albums' | 'genres' | 'playlists';
export type LibrarySort = 'az' | 'date_added' | 'year' | 'album_artist';

export function loadLibrarySubTab(): LibrarySubTab {
  const v = localStorage.getItem('nekobeat_library_subtab');
  if (v === 'artists' || v === 'albums' || v === 'genres' || v === 'playlists' || v === 'tracks') return v;
  return 'tracks';
}

export function loadLibrarySort(): LibrarySort {
  const value = localStorage.getItem('nekobeat_library_sort');
  return value === 'date_added' || value === 'year' || value === 'album_artist' ? value : 'az';
}

export function saveLibrarySort(value: LibrarySort) {
  localStorage.setItem('nekobeat_library_sort', value);
}
export function saveLibrarySubTab(v: LibrarySubTab) {
  localStorage.setItem('nekobeat_library_subtab', v);
}
