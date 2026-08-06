import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, LayoutGrid, ListMusic, X } from "lucide-react";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import { peekLibraryCache, setLibraryCache } from "../lib/libraryCache";
import {
  groupAlbums,
  isTauri,
  type AlbumGroup,
} from "../lib/libraryHelpers";
import {
  clearRecentlyPlayed,
  getRecentlyPlayed,
} from "../lib/recentlyPlayed";
import type { TrackMeta } from "../lib/types";
import { usePlayer } from "../player/PlayerContext";
import { AlbumGrid } from "./AlbumGrid";
import { CoverArt } from "./CoverArt";
import { TrackList } from "./TrackList";
import "./listen-home.css";

type View = "albums" | "tracks";

export function ListenPage() {
  const { playTrack, current } = usePlayer();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const artistFilter = (params.get("artist") || "").trim();
  const albumFilter = (params.get("album") || "").trim();
  const cached = peekLibraryCache();
  const [tracks, setTracks] = useState<TrackMeta[]>(() => cached ?? []);
  const [loading, setLoading] = useState(!cached);
  const [scanning, setScanning] = useState(false);
  const [view, setView] = useState<View>(
    albumFilter || artistFilter ? "tracks" : "albums",
  );
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<TrackMeta[]>(() => getRecentlyPlayed());

  useEffect(() => {
    const sync = () => setRecent(getRecentlyPlayed());
    window.addEventListener("nb-recently-played", sync);
    return () => window.removeEventListener("nb-recently-played", sync);
  }, []);

  const reload = useCallback(async (opts?: { soft?: boolean }) => {
    if (!isTauri()) {
      setTracks([]);
      setLoading(false);
      setError(null);
      return;
    }
    if (!opts?.soft && !peekLibraryCache()) setLoading(true);
    try {
      const all = await api.libraryList();
      setLibraryCache(all);
      startTransition(() => {
        setTracks(all);
        setError(null);
        setLoading(false);
      });
    } catch (e) {
      setTracks([]);
      setError(String(e));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload({ soft: Boolean(peekLibraryCache()) });
  }, [reload]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("library-changed", () => {
      void reload({ soft: true });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [reload]);

  const filtered = useMemo(() => {
    let rows = tracks;
    if (artistFilter) {
      const q = artistFilter.toLowerCase();
      rows = rows.filter((t) => (t.artist || "").toLowerCase().includes(q));
    }
    if (albumFilter) {
      const q = albumFilter.toLowerCase();
      rows = rows.filter((t) => (t.album || "").toLowerCase().includes(q));
    }
    return rows;
  }, [tracks, artistFilter, albumFilter]);

  const albums = useMemo(() => groupAlbums(filtered), [filtered]);

  useEffect(() => {
    if (artistFilter || albumFilter) setView("tracks");
  }, [artistFilter, albumFilter]);

  const clearFilter = () => navigate("/");

  const scan = async () => {
    if (!isTauri()) return;
    setScanning(true);
    setError(null);
    try {
      const picked = await open({ directory: true, multiple: true });
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
      if (!paths.length) return;
      await api.libraryScan(paths);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  const playAlbum = (album: AlbumGroup) => {
    if (!album.tracks.length) return;
    void playTrack(album.tracks[0], album.tracks);
  };

  const empty = !loading && tracks.length === 0;
  const filterEmpty = !loading && !empty && filtered.length === 0;

  return (
    <section className="nb-listen">
      <header className="nb-listen-bar">
        <div>
          <h1 className="nb-page-title">
            {artistFilter || albumFilter
              ? albumFilter || artistFilter
              : empty
                ? "NekoBeat"
                : "Library"}
          </h1>
          {empty && !loading ? (
            <p className="nb-listen-count">any source · one beat</p>
          ) : !empty && !loading ? (
            <p className="nb-listen-count">
              {artistFilter || albumFilter
                ? `${filtered.length} tracks`
                : `${albums.length} albums · ${tracks.length} tracks`}
            </p>
          ) : null}
          {artistFilter || albumFilter ? (
            <button type="button" className="nb-chip" onClick={clearFilter}>
              <X size={14} /> Clear filter
            </button>
          ) : null}
        </div>
        <div className="nb-listen-tools">
          {!empty ? (
            <div className="nb-seg" role="tablist" aria-label="Library view">
              <button
                type="button"
                role="tab"
                aria-selected={view === "albums"}
                className={view === "albums" ? "is-on" : undefined}
                onClick={() => setView("albums")}
              >
                <LayoutGrid size={16} />
                Albums
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "tracks"}
                className={view === "tracks" ? "is-on" : undefined}
                onClick={() => setView("tracks")}
              >
                <ListMusic size={16} />
                Tracks
              </button>
            </div>
          ) : null}
          {isTauri() ? (
            <button
              type="button"
              className="nb-btn"
              onClick={() => void scan()}
              disabled={scanning}
            >
              <FolderOpen size={18} />
              {scanning ? "Scanning…" : empty ? "Add music" : "Add folder"}
            </button>
          ) : null}
        </div>
      </header>

      {error ? <p className="nb-inline-error">{error}</p> : null}

      {!artistFilter && !albumFilter && recent.length ? (
        <section className="nb-recent" aria-label="Recently played">
          <div className="nb-recent-head">
            <h2>Recently played</h2>
            <button
              type="button"
              className="nb-tap-link"
              onClick={() => clearRecentlyPlayed()}
            >
              Clear
            </button>
          </div>
          <div className="nb-recent-row">
            {recent.slice(0, 16).map((t) => (
              <button
                key={t.id}
                type="button"
                className={`nb-recent-card${current?.id === t.id ? " is-on" : ""}`}
                onClick={() => void playTrack(t, recent)}
              >
                <CoverArt track={t} className="nb-recent-cover" size={88} />
                <strong>{t.title}</strong>
                <span>{t.artist}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {loading ? (
        <div className="nb-album-grid">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="nb-skeleton nb-album-skel" />
          ))}
        </div>
      ) : empty ? (
        <div className="nb-library-empty">
          <div className="nb-vinyl" aria-hidden>
            <div className="nb-vinyl-disc" />
            <div className="nb-vinyl-sleeve" />
          </div>
          <h2>Continue listening</h2>
          <p>
            {isTauri()
              ? "Add a folder — covers and titles come from your files. Browse & HiFi for everything else."
              : "This is the Vite browser shell only. Start the desktop app to open local folders."}
          </p>
          {isTauri() ? (
            <button
              type="button"
              className="nb-btn lg"
              onClick={() => void scan()}
              disabled={scanning}
            >
              <FolderOpen size={20} />
              {scanning ? "Scanning…" : "Add music folder"}
            </button>
          ) : (
            <code className="nb-cmd">npm run tauri:dev</code>
          )}
        </div>
      ) : filterEmpty ? (
        <div className="nb-empty">
          No tracks match this artist/album in your library.
        </div>
      ) : view === "albums" ? (
        <AlbumGrid albums={albums} onOpen={playAlbum} />
      ) : (
        <TrackList
          tracks={filtered}
          onPlay={(t) => void playTrack(t, filtered)}
        />
      )}
    </section>
  );
}
