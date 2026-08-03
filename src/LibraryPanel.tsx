import { Play, Shuffle, Music, User, Disc3, ArrowLeft, FolderOpen, FolderSearch, Settings, Library, Tags, ListMusic, Plus, Pencil, Trash2, Heart, RefreshCw } from "lucide-react";
import { motion } from "framer-motion";
import logoImg from "./assets/logo.png";
import { coverSrcForUi, TrackData, type PlaylistSummary } from "./hooks";
import { groupByArtist, groupByAlbum, groupByGenre, findArtistTracks, findAlbumTracks, findGenreTracks, sortLibraryTracks } from "./libraryGroup";
import type { LibrarySort, LibrarySubTab } from "./prefs";

type LibraryFocus =
  | null
  | { kind: 'artist'; name: string }
  | { kind: 'album'; name: string; artist: string }
  | { kind: 'genre'; name: string }
  | { kind: 'playlist'; id: number; name: string; isHistory: boolean };

type Props = {
  tracks: TrackData[];
  isScanning: boolean;
  isMobileOs: boolean;
  isAndroidOs: boolean;
  isPlaying: boolean;
  currentTrackPath: string | null;
  viewMode: 'grid' | 'list';
  setViewMode: (m: 'grid' | 'list') => void;
  librarySubTab: LibrarySubTab;
  setLibrarySubTab: (t: LibrarySubTab) => void;
  librarySort: LibrarySort;
  setLibrarySort: (sort: LibrarySort) => void;
  libraryFocus: LibraryFocus;
  setLibraryFocus: (f: LibraryFocus) => void;
  techLabel: (t: TrackData) => string;
  coverFallback: boolean;
  showAudioFormat: boolean;
  onScan: () => void;
  onRefresh: () => void;
  onAddSongs: () => void;
  onPlayAll: (shuffle?: boolean) => void;
  onPlayTrackList: (list: TrackData[], shuffle?: boolean, startPath?: string) => void;
  onPlayLocal: (filepath: string) => void;
  onPlayNext: (track: TrackData) => void;
  onAddQueue: (track: TrackData) => void;
  onStreamExternal: (track: any) => void;
  onOpenArtist: (artist: string) => void;
  onOpenAlbum: (album: string, artist: string) => void;
  onOpenSettings: () => void;
  onOpenLiked: () => void;
  onArtResolved: (filepath: string, url: string) => void;
  playlists: PlaylistSummary[];
  playlistTracks: TrackData[];
  onCreatePlaylist: (name: string) => Promise<void>;
  onRenamePlaylist: (id: number, name: string) => Promise<void>;
  onDeletePlaylist: (id: number) => Promise<void>;
  onOpenPlaylist: (playlist: PlaylistSummary) => Promise<void>;
  onAddToPlaylist: (playlistId: number, filepath: string) => Promise<void>;
  onRemoveFromPlaylist: (playlistId: number, filepath: string) => Promise<void>;
  onAddCurrentToPlaylist: (playlistId: number) => Promise<void>;
  stripExtension: (t: string) => string;
  ViewToggle: React.ComponentType<{ viewMode: 'grid' | 'list'; onChange: (m: 'grid' | 'list') => void }>;
  AlbumCard: React.ComponentType<any>;
  TrackResult: React.ComponentType<any>;
};

export function LibraryPanel(props: Props) {
  const {
    tracks, isScanning, isMobileOs, isAndroidOs, isPlaying, currentTrackPath,
    viewMode, setViewMode, librarySubTab, setLibrarySubTab,
    librarySort, setLibrarySort, libraryFocus, setLibraryFocus, techLabel, coverFallback, showAudioFormat,
    onScan, onRefresh, onAddSongs, onPlayAll, onPlayTrackList, onPlayLocal, onPlayNext, onAddQueue, onStreamExternal,
    onOpenArtist, onOpenAlbum, onOpenSettings, onOpenLiked, onArtResolved,
    playlists, playlistTracks, onCreatePlaylist, onRenamePlaylist, onDeletePlaylist,
    onOpenPlaylist, onAddToPlaylist, onRemoveFromPlaylist, onAddCurrentToPlaylist,
    stripExtension, ViewToggle, AlbumCard, TrackResult,
  } = props;

  const title =
    libraryFocus?.kind === 'artist'
      ? libraryFocus.name
      : libraryFocus?.kind === 'album'
        ? libraryFocus.name
        : libraryFocus?.kind === 'genre'
          ? libraryFocus.name
          : libraryFocus?.kind === 'playlist'
            ? libraryFocus.name
        : isAndroidOs
          ? ({ tracks: 'Songs', artists: 'Artists', albums: 'Albums', genres: 'Genres', playlists: 'Playlists' } as const)[librarySubTab]
          : 'Your Library';
  const sortedTracks = sortLibraryTracks(tracks, librarySort);
  const showLibraryActions = !libraryFocus && librarySubTab !== 'playlists';
  const showPlayActions = tracks.length > 0 && !libraryFocus && librarySubTab === 'tracks';

  return (
    <>
      <header className="library-header mb-5 md:mb-7">
        <div className="flex items-end justify-between gap-4 mb-4 md:mb-5">
          <div className="min-w-0">
            <h1 className="text-3xl sm:text-4xl md:text-5xl font-display font-black text-white tracking-tighter leading-none truncate">
              {title}
            </h1>
            {showLibraryActions && tracks.length > 0 && (
              <p className="mt-2 text-xs sm:text-sm text-[var(--color-ink-muted)] font-medium">
                {tracks.length.toLocaleString()} song{tracks.length === 1 ? '' : 's'}
                {isScanning ? ' · updating…' : ''}
              </p>
            )}
          </div>
          {!libraryFocus && <ViewToggle viewMode={viewMode} onChange={setViewMode} />}
        </div>

        {showLibraryActions && (
          <div className="library-toolbar">
            <div className="library-toolbar-row">
              <div className="library-toolbar-group">
                <label className="library-sort">
                  <span className="sr-only">Sort library</span>
                  <select
                    value={librarySort}
                    onChange={(event) => setLibrarySort(event.target.value as LibrarySort)}
                    aria-label="Sort library"
                    className="library-btn library-btn-ghost library-select"
                  >
                    <option value="az">A–Z</option>
                    <option value="date_added">Date added</option>
                    <option value="year">Year</option>
                    <option value="album_artist">Album artist</option>
                  </select>
                </label>
              </div>

              {showPlayActions && (
                <div className="library-toolbar-group library-toolbar-group-end">
                  <button type="button" onClick={() => onPlayAll(false)} className="library-btn library-btn-primary" title="Play all">
                    <Play size={15} fill="currentColor" className="shrink-0" />
                    <span>Play all</span>
                  </button>
                  <button type="button" onClick={() => onPlayAll(true)} className="library-btn library-btn-ghost" title="Shuffle all">
                    <Shuffle size={15} className="shrink-0" />
                    <span>Shuffle</span>
                  </button>
                </div>
              )}
            </div>

            <div className="library-toolbar-row library-toolbar-row-actions">
              <div className="library-toolbar-group library-toolbar-group-stretch">
                {tracks.length > 0 && (
                  <button
                    type="button"
                    onClick={onRefresh}
                    disabled={isScanning}
                    className="library-btn library-btn-accent"
                    title="Look for new songs in your music folders"
                  >
                    <RefreshCw size={15} className={`shrink-0 ${isScanning ? 'animate-spin' : ''}`} />
                    <span>{isScanning ? 'Refreshing…' : 'Refresh'}</span>
                  </button>
                )}
                {isMobileOs ? (
                  <>
                    <button
                      type="button"
                      onClick={tracks.length > 0 ? onAddSongs : onScan}
                      disabled={isScanning}
                      className={`library-btn ${tracks.length > 0 ? 'library-btn-ghost' : 'library-btn-accent'}`}
                      title={tracks.length > 0 ? 'Import selected files' : 'Scan Music and Download'}
                    >
                      {tracks.length > 0 ? <Music size={15} className="shrink-0" /> : <FolderSearch size={15} className="shrink-0" />}
                      <span>
                        {isScanning
                          ? 'Scanning…'
                          : tracks.length > 0
                            ? 'Add songs'
                            : 'Scan music'}
                      </span>
                    </button>
                    {tracks.length > 0 && (
                      <button
                        type="button"
                        onClick={onScan}
                        disabled={isScanning}
                        className="library-btn library-btn-ghost library-btn-icon"
                        title="Full device scan"
                        aria-label="Full device scan"
                      >
                        <FolderSearch size={16} />
                      </button>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={onScan}
                    disabled={isScanning}
                    className={`library-btn ${tracks.length > 0 ? 'library-btn-ghost' : 'library-btn-accent'}`}
                    title="Add a music folder"
                  >
                    <FolderOpen size={16} className="shrink-0" />
                    <span>{isScanning ? 'Scanning…' : 'Add folder'}</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </header>

      {!isAndroidOs && (
        <div className="flex items-center gap-1 mb-5 p-1 rounded-xl bg-white/5 border border-white/10 w-fit max-w-full overflow-x-auto">
          {([
            { id: 'tracks' as const, label: 'Tracks', icon: <Music size={14} /> },
            { id: 'artists' as const, label: 'Artists', icon: <User size={14} /> },
            { id: 'albums' as const, label: 'Albums', icon: <Disc3 size={14} /> },
            { id: 'genres' as const, label: 'Genres', icon: <Tags size={14} /> },
            { id: 'playlists' as const, label: 'Playlists', icon: <ListMusic size={14} /> },
          ]).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => { setLibrarySubTab(tab.id); setLibraryFocus(null); }}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
                librarySubTab === tab.id && !libraryFocus
                  ? 'bg-[var(--color-neon-yellow)] text-black'
                  : libraryFocus && librarySubTab === tab.id
                    ? 'bg-white/15 text-white'
                    : 'text-neutral-400 hover:text-white'
              }`}
            >
              {tab.icon}{tab.label}
            </button>
          ))}
        </div>
      )}

      {tracks.length === 0 && librarySubTab !== 'playlists' ? (
        <div className="py-16 px-5 text-center max-w-md mx-auto">
          <Library size={44} className="mx-auto mb-4 text-[var(--color-neon-yellow)]/75" />
          <h2 className="text-xl font-display font-black text-white tracking-tight mb-2">Your library is empty</h2>
          <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed mb-6">
            {isMobileOs
              ? "Allow audio access, then scan Music / Download — or add individual songs."
              : "Add a folder of MP3, FLAC, or WAV files to play offline from this device."}
          </p>
          <div className="library-empty-actions">
            <button type="button" onClick={onScan} disabled={isScanning} className="library-btn library-btn-accent library-btn-lg">
              {isMobileOs ? <FolderSearch size={16} /> : <FolderOpen size={16} />}
              {isScanning ? "Scanning…" : isMobileOs ? "Scan device music" : "Add a music folder"}
            </button>
            {isMobileOs && (
              <button type="button" onClick={onAddSongs} disabled={isScanning} className="library-btn library-btn-ghost library-btn-lg">
                <Music size={16} /> Add songs
              </button>
            )}
            <button type="button" onClick={onOpenSettings} className="library-btn library-btn-ghost library-btn-lg">
              <Settings size={16} /> Settings
            </button>
          </div>
        </div>
      ) : libraryFocus?.kind === 'artist' ? (
        <ArtistDetail
          name={libraryFocus.name}
          tracks={findArtistTracks(tracks, libraryFocus.name)}
          currentTrackPath={currentTrackPath}
          techLabel={techLabel}
          stripExtension={stripExtension}
          onBack={() => setLibraryFocus(null)}
          onPlayList={onPlayTrackList}
          onOpenAlbum={onOpenAlbum}
        />
      ) : libraryFocus?.kind === 'album' ? (
        <AlbumDetail
          name={libraryFocus.name}
          artist={libraryFocus.artist}
          tracks={findAlbumTracks(tracks, libraryFocus.name, libraryFocus.artist)}
          currentTrackPath={currentTrackPath}
          techLabel={techLabel}
          stripExtension={stripExtension}
          onBack={() => setLibraryFocus(null)}
          onPlayList={onPlayTrackList}
          onOpenArtist={onOpenArtist}
        />
      ) : libraryFocus?.kind === 'genre' ? (
        <CollectionDetail
          label="Genre"
          backLabel="Genres"
          name={libraryFocus.name}
          tracks={findGenreTracks(tracks, libraryFocus.name)}
          currentTrackPath={currentTrackPath}
          techLabel={techLabel}
          stripExtension={stripExtension}
          onBack={() => setLibraryFocus(null)}
          onPlayList={onPlayTrackList}
        />
      ) : libraryFocus?.kind === 'playlist' ? (
        <CollectionDetail
          label={libraryFocus.isHistory ? "History" : "Playlist"}
          backLabel="Playlists"
          name={libraryFocus.name}
          tracks={playlistTracks}
          currentTrackPath={currentTrackPath}
          techLabel={techLabel}
          stripExtension={stripExtension}
          onBack={() => setLibraryFocus(null)}
          onPlayList={onPlayTrackList}
          onRemove={libraryFocus.isHistory ? undefined : (filepath) => onRemoveFromPlaylist(libraryFocus.id, filepath)}
          onAddCurrent={libraryFocus.isHistory ? undefined : () => onAddCurrentToPlaylist(libraryFocus.id)}
        />
      ) : librarySubTab === 'artists' ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 md:gap-6">
          {groupByArtist(tracks).map((artist, i) => (
            <motion.button
              key={artist.name}
              type="button"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.03, 0.4) }}
              onClick={() => setLibraryFocus({ kind: 'artist', name: artist.name })}
              className="group flex flex-col items-center gap-3 text-center"
            >
              <div className="w-full aspect-square max-w-[11rem] rounded-full bg-zinc-800/70 border border-white/10 flex items-center justify-center group-hover:border-[var(--color-neon-yellow)]/40 transition-all shadow-[0_12px_30px_rgba(0,0,0,0.35)]">
                <User size={48} className="text-white/30 group-hover:text-[var(--color-neon-yellow)]/80 transition-colors" strokeWidth={1.25} />
              </div>
              <div className="min-w-0 w-full px-1">
                <p className="font-display font-bold text-white truncate text-sm md:text-base">{artist.name}</p>
                <p className="text-[11px] text-neutral-500">{artist.tracks.length === 1 ? '1 track' : `${artist.tracks.length} tracks`}</p>
              </div>
            </motion.button>
          ))}
        </div>
      ) : librarySubTab === 'albums' ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4 md:gap-6">
          {groupByAlbum(tracks).map((album, i) => (
            <AlbumCard
              key={`${album.name}-${album.artist}`}
              index={i}
              title={album.name}
              artist={album.artist}
              album={album.name}
              artworkUrl={album.artwork_url}
              source="local"
              coverFallback={coverFallback}
              onClick={() => setLibraryFocus({ kind: 'album', name: album.name, artist: album.artist })}
              isPlaying={album.tracks.some((t) => t.filepath === currentTrackPath && isPlaying)}
            />
          ))}
        </div>
      ) : librarySubTab === 'genres' ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 md:gap-6">
          {groupByGenre(tracks).map((genre) => (
            <button key={genre.name} type="button" onClick={() => setLibraryFocus({ kind: 'genre', name: genre.name })} className="rounded-2xl border border-white/10 bg-white/5 p-5 text-left hover:border-[var(--color-neon-yellow)]/50">
              <Tags size={34} className="mb-8 text-[var(--color-neon-yellow)]" />
              <p className="font-display font-bold text-white truncate">{genre.name}</p>
              <p className="text-xs text-neutral-500">{genre.tracks.length} track{genre.tracks.length === 1 ? '' : 's'}</p>
            </button>
          ))}
        </div>
      ) : librarySubTab === 'playlists' ? (
        <PlaylistBrowser
          playlists={playlists}
          onOpenLiked={onOpenLiked}
          onCreate={onCreatePlaylist}
          onRename={onRenamePlaylist}
          onDelete={onDeletePlaylist}
          onOpen={onOpenPlaylist}
        />
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4 md:gap-6">
          {sortedTracks.map((track, i) => (
            <AlbumCard
              key={track.filepath}
              index={i}
              title={track.title}
              artist={track.artist}
              album={track.album}
              artworkUrl={track.artwork_url}
              source={track.source || 'local'}
              formatLabel={techLabel(track)}
              coverFallback={coverFallback}
              onArtResolved={(url: string) => onArtResolved(track.filepath, url)}
              onArtistClick={() => onOpenArtist(track.artist)}
              onClick={() => (!track.source || track.source === 'local') ? onPlayLocal(track.filepath) : onStreamExternal(track)}
              isPlaying={currentTrackPath === track.filepath && isPlaying}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2 sm:gap-2.5">
          {sortedTracks.map((track) => (
            <div key={track.filepath} className="flex items-center gap-2">
            <div className="min-w-0 flex-1"><TrackResult
              key={track.filepath}
              track={{
                id: track.id || track.filepath,
                title: track.title,
                artist: track.artist,
                album: track.album,
                album_artist: track.album_artist,
                duration_ms: track.duration_ms,
                artwork_url: track.artwork_url || '',
                source: track.source || 'local',
                stream_url: track.filepath,
                format: track.format,
                bitrate_kbps: track.bitrate_kbps,
                sample_rate_hz: track.sample_rate_hz,
                channels: track.channels,
                local_lyrics: track.local_lyrics,
                genre: track.genre,
                track_number: track.track_number,
                disc_number: track.disc_number,
                year: track.year,
                date_added: track.date_added,
                replaygain_track_gain: track.replaygain_track_gain,
                replaygain_track_peak: track.replaygain_track_peak,
                replaygain_album_gain: track.replaygain_album_gain,
                replaygain_album_peak: track.replaygain_album_peak,
              }}
              showFormat={showAudioFormat}
              coverFallback={coverFallback}
              onArtResolved={(url: string) => onArtResolved(track.filepath, url)}
              onArtistClick={() => onOpenArtist(track.artist)}
              onPlayNext={() => onPlayNext(track)}
              onAddQueue={() => onAddQueue(track)}
              onPlay={() => (!track.source || track.source === 'local') ? onPlayLocal(track.filepath) : onStreamExternal(track)}
              currentTrackId={currentTrackPath}
              isCurrentlyPlaying={isPlaying && currentTrackPath === track.filepath}
            /></div>
            {playlists.some((playlist) => !playlist.is_history) && (
              <select
                defaultValue=""
                aria-label={`Add ${track.title} to playlist`}
                onChange={(event) => {
                  const id = Number(event.target.value);
                  if (id) void onAddToPlaylist(id, track.filepath);
                  event.target.value = "";
                }}
                className="max-w-32 rounded-lg border border-white/10 bg-zinc-900 px-2 py-2 text-xs text-white"
              >
                <option value="">Add to…</option>
                {playlists.filter((playlist) => !playlist.is_history).map((playlist) => (
                  <option key={playlist.id} value={playlist.id}>{playlist.name}</option>
                ))}
              </select>
            )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ArtistDetail({
  name, tracks, currentTrackPath, techLabel, stripExtension, onBack, onPlayList, onOpenAlbum,
}: {
  name: string;
  tracks: TrackData[];
  currentTrackPath: string | null;
  techLabel: (t: TrackData) => string;
  stripExtension: (t: string) => string;
  onBack: () => void;
  onPlayList: (list: TrackData[], shuffle?: boolean, startPath?: string) => void;
  onOpenAlbum: (album: string, artist: string) => void;
}) {
  return (
    <div className="space-y-6">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-2 text-sm font-bold text-[var(--color-ink-muted)] hover:text-[var(--color-neon-yellow)]">
        <ArrowLeft size={16} /> Artists
      </button>
      <div className="flex flex-col sm:flex-row items-center sm:items-end gap-5">
        <div className="w-36 h-36 sm:w-44 sm:h-44 rounded-full bg-zinc-800/80 border border-white/10 flex items-center justify-center shadow-[0_20px_50px_rgba(0,0,0,0.45)]">
          <User size={64} className="text-white/35" strokeWidth={1.25} />
        </div>
        <div className="text-center sm:text-left flex-1 min-w-0 space-y-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-[var(--color-neon-yellow)]">Artist</p>
          <h2 className="text-3xl sm:text-4xl font-display font-black text-white tracking-tight truncate">{name}</h2>
          <p className="text-sm text-[var(--color-ink-muted)]">{tracks.length === 1 ? '1 track' : `${tracks.length} tracks`}</p>
          <div className="flex flex-wrap justify-center sm:justify-start gap-2">
            <button type="button" onClick={() => onPlayList(tracks, false)} className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[var(--color-neon-yellow)] text-black font-bold text-sm">
              <Play size={14} fill="black" /> Play all
            </button>
            <button type="button" onClick={() => onPlayList(tracks, true)} className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-white/10 border border-white/15 text-white font-bold text-sm">
              <Shuffle size={14} /> Shuffle
            </button>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {tracks.map((track, i) => (
          <div
            key={track.filepath}
            role="button"
            tabIndex={0}
            onClick={() => onPlayList(tracks, false, track.filepath)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onPlayList(tracks, false, track.filepath);
              }
            }}
            className={`flex items-center gap-3 p-3 rounded-2xl text-left transition-all border ${
              currentTrackPath === track.filepath ? 'border-[var(--color-neon-yellow)]/50 bg-white/5' : 'border-transparent hover:bg-white/5'
            }`}
          >
            <span className="w-8 text-center text-xs font-bold text-white/30 tabular-nums">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className={`font-bold truncate ${currentTrackPath === track.filepath ? 'text-[var(--color-neon-yellow)]' : 'text-white'}`}>{stripExtension(track.title)}</p>
              <button type="button" className="text-xs text-white/45 hover:text-[var(--color-neon-yellow)] truncate" onClick={(e) => { e.stopPropagation(); onOpenAlbum(track.album, track.artist); }}>
                {track.album || 'Unknown Album'}
              </button>
              {techLabel(track) && <p className="text-[10px] text-white/30 font-mono truncate">{techLabel(track)}</p>}
            </div>
            <Play size={16} className="text-white/40 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

function AlbumDetail({
  name, artist, tracks, currentTrackPath, techLabel, stripExtension, onBack, onPlayList, onOpenArtist,
}: {
  name: string;
  artist: string;
  tracks: TrackData[];
  currentTrackPath: string | null;
  techLabel: (t: TrackData) => string;
  stripExtension: (t: string) => string;
  onBack: () => void;
  onPlayList: (list: TrackData[], shuffle?: boolean, startPath?: string) => void;
  onOpenArtist: (artist: string) => void;
}) {
  const art = tracks.find((t) => t.artwork_url)?.artwork_url;
  return (
    <div className="space-y-6">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-2 text-sm font-bold text-[var(--color-ink-muted)] hover:text-[var(--color-neon-yellow)]">
        <ArrowLeft size={16} /> Albums
      </button>
      <div className="flex flex-col sm:flex-row items-center sm:items-end gap-5">
        <div className="w-40 h-40 sm:w-48 sm:h-48 rounded-2xl overflow-hidden bg-zinc-800 border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.45)]">
          <img src={coverSrcForUi(art) || logoImg} alt="" className="w-full h-full object-cover" />
        </div>
        <div className="text-center sm:text-left flex-1 min-w-0 space-y-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-[var(--color-neon-yellow)]">Album</p>
          <h2 className="text-3xl sm:text-4xl font-display font-black text-white tracking-tight truncate">{name}</h2>
          <button type="button" onClick={() => onOpenArtist(artist)} className="text-sm text-[var(--color-neon-yellow)] font-medium hover:underline">{artist}</button>
          <p className="text-sm text-[var(--color-ink-muted)]">{tracks.length === 1 ? '1 track' : `${tracks.length} tracks`}</p>
          <div className="flex flex-wrap justify-center sm:justify-start gap-2">
            <button type="button" onClick={() => onPlayList(tracks, false)} className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[var(--color-neon-yellow)] text-black font-bold text-sm">
              <Play size={14} fill="black" /> Play all
            </button>
            <button type="button" onClick={() => onPlayList(tracks, true)} className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-white/10 border border-white/15 text-white font-bold text-sm">
              <Shuffle size={14} /> Shuffle
            </button>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {tracks.map((track, i) => (
          <div
            key={track.filepath}
            role="button"
            tabIndex={0}
            onClick={() => onPlayList(tracks, false, track.filepath)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onPlayList(tracks, false, track.filepath);
              }
            }}
            className={`flex items-center gap-3 p-3 rounded-2xl text-left transition-all border ${
              currentTrackPath === track.filepath ? 'border-[var(--color-neon-yellow)]/50 bg-white/5' : 'border-transparent hover:bg-white/5'
            }`}
          >
            <span className="w-8 text-center text-xs font-bold text-white/30 tabular-nums">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className={`font-bold truncate ${currentTrackPath === track.filepath ? 'text-[var(--color-neon-yellow)]' : 'text-white'}`}>{stripExtension(track.title)}</p>
              {techLabel(track) && <p className="text-[10px] text-white/30 font-mono truncate">{techLabel(track)}</p>}
            </div>
            <Play size={16} className="text-white/40 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

function PlaylistBrowser({
  playlists, onOpenLiked, onCreate, onRename, onDelete, onOpen,
}: {
  playlists: PlaylistSummary[];
  onOpenLiked: () => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (id: number, name: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onOpen: (playlist: PlaylistSummary) => Promise<void>;
}) {
  const create = async () => {
    const name = window.prompt('Playlist name');
    if (name?.trim()) await onCreate(name.trim());
  };
  return (
    <div className="space-y-4">
      <button type="button" onClick={() => void create()} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[var(--color-neon-yellow)] px-4 py-2 text-sm font-bold text-black">
        <Plus size={16} /> New playlist
      </button>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <button type="button" onClick={onOpenLiked} className="flex min-h-[76px] items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 text-left">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[var(--color-neon-yellow)]/12 text-[var(--color-neon-yellow)]"><Heart size={20} fill="currentColor" /></span>
          <span className="min-w-0">
            <span className="block truncate font-display font-bold text-white">Liked Songs</span>
            <span className="block text-xs text-neutral-500">Your saved favourites</span>
          </span>
        </button>
        {playlists.map((playlist) => (
          <div key={playlist.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
            <button type="button" onClick={() => void onOpen(playlist)} className="min-w-0 flex-1 text-left">
              <p className="truncate font-display font-bold text-white">{playlist.name}</p>
              <p className="text-xs text-neutral-500">{playlist.track_count} track{playlist.track_count === 1 ? '' : 's'}</p>
            </button>
            {!playlist.is_history && (
              <>
                <button type="button" aria-label={`Rename ${playlist.name}`} onClick={() => {
                  const name = window.prompt('Rename playlist', playlist.name);
                  if (name?.trim() && name.trim() !== playlist.name) void onRename(playlist.id, name.trim());
                }} className="rounded-lg p-2 text-white/55 hover:bg-white/10 hover:text-white"><Pencil size={15} /></button>
                <button type="button" aria-label={`Delete ${playlist.name}`} onClick={() => {
                  if (window.confirm(`Delete "${playlist.name}"? Tracks and audio files will not be deleted.`)) void onDelete(playlist.id);
                }} className="rounded-lg p-2 text-red-300/70 hover:bg-red-500/10 hover:text-red-300"><Trash2 size={15} /></button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CollectionDetail({
  label, backLabel, name, tracks, currentTrackPath, techLabel, stripExtension,
  onBack, onPlayList, onRemove,
  onAddCurrent,
}: {
  label: string;
  backLabel: string;
  name: string;
  tracks: TrackData[];
  currentTrackPath: string | null;
  techLabel: (track: TrackData) => string;
  stripExtension: (title: string) => string;
  onBack: () => void;
  onPlayList: (list: TrackData[], shuffle?: boolean, startPath?: string) => void;
  onRemove?: (filepath: string) => Promise<void>;
  onAddCurrent?: () => Promise<void>;
}) {
  return (
    <div className="space-y-6">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-2 text-sm font-bold text-[var(--color-ink-muted)] hover:text-[var(--color-neon-yellow)]">
        <ArrowLeft size={16} /> {backLabel}
      </button>
      <div className="space-y-3">
        <p className="text-[10px] font-black uppercase tracking-widest text-[var(--color-neon-yellow)]">{label}</p>
        <h2 className="text-3xl font-display font-black text-white">{name}</h2>
        <p className="text-sm text-[var(--color-ink-muted)]">{tracks.length} track{tracks.length === 1 ? '' : 's'}</p>
        <div className="flex gap-2">
          <button type="button" disabled={!tracks.length} onClick={() => onPlayList(tracks)} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[var(--color-neon-yellow)] px-4 text-sm font-bold text-black disabled:opacity-40"><Play size={14} fill="black" /> Play all</button>
          <button type="button" disabled={!tracks.length} onClick={() => onPlayList(tracks, true)} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/15 bg-white/10 px-4 text-sm font-bold text-white disabled:opacity-40"><Shuffle size={14} /> Shuffle</button>
          {onAddCurrent && <button type="button" onClick={() => void onAddCurrent()} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 text-sm font-bold text-white"><Plus size={14} /> Add current</button>}
        </div>
      </div>
      <div className="space-y-2">
        {tracks.map((track, index) => (
          <div key={track.filepath} className={`flex items-center gap-3 rounded-xl border p-3 ${currentTrackPath === track.filepath ? 'border-[var(--color-neon-yellow)]/50 bg-white/5' : 'border-transparent hover:bg-white/5'}`}>
            <button type="button" onClick={() => onPlayList(tracks, false, track.filepath)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
              <span className="w-7 text-center text-xs text-white/30">{track.track_number || index + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-bold text-white">{stripExtension(track.title)}</span>
                <span className="block truncate text-xs text-white/45">{track.artist}{track.year ? ` · ${track.year}` : ''}</span>
                {techLabel(track) && <span className="block truncate text-[10px] font-mono text-white/30">{techLabel(track)}</span>}
              </span>
              <Play size={15} className="text-white/40" />
            </button>
            {onRemove && <button type="button" aria-label={`Remove ${track.title}`} onClick={() => void onRemove(track.filepath)} className="rounded-lg p-2 text-red-300/70 hover:bg-red-500/10"><Trash2 size={15} /></button>}
          </div>
        ))}
      </div>
    </div>
  );
}
