import { Clock, Loader2, Radio, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import {
  clearSearchHistory,
  getSearchHistory,
  pushSearchHistory,
} from "../lib/searchHistory";
import type { TrackMeta } from "../lib/types";
import { usePlayer } from "../player/PlayerContext";
import { TrackList } from "./TrackList";
import "./browse.css";

const SUGGESTIONS = [
  "Aurora",
  "Runaway",
  "Tate McRae",
  "lofi beats",
  "jazz",
  "Freddie Dredd",
];

type Tab = "tracks" | "artists" | "albums";

export function BrowsePage() {
  const { playTrack, current } = usePlayer();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") || "");
  const [results, setResults] = useState<TrackMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [searched, setSearched] = useState(Boolean(params.get("q")?.trim()));
  const [tab, setTab] = useState<Tab>("tracks");
  const [histOpen, setHistOpen] = useState(false);
  const [history, setHistory] = useState(() => getSearchHistory());
  const lastUrlQ = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);

  const search = async (query = q) => {
    const term = query.trim();
    if (!term) return;
    const id = ++reqId.current;
    setBusy(true);
    setErr(null);
    setSearched(true);
    setTab("tracks");
    setHistOpen(false);
    lastUrlQ.current = term;
    setQ(term);
    pushSearchHistory(term);
    setHistory(getSearchHistory());
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set("q", term);
      return next;
    });
    try {
      const rows = await api.searchStream(term);
      if (id !== reqId.current) return;
      setResults(rows);
      const first = rows[0];
      if (first) {
        window.setTimeout(() => {
          void api.resolveStream(first).catch(() => {});
        }, 400);
      }
    } catch (e) {
      if (id !== reqId.current) return;
      setErr(String(e));
      setResults([]);
    } finally {
      if (id === reqId.current) setBusy(false);
    }
  };

  useEffect(() => {
    const fromUrl = (params.get("q") || "").trim();
    if (!fromUrl || fromUrl === lastUrlQ.current) return;
    lastUrlQ.current = fromUrl;
    setQ(fromUrl);
    void search(fromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get("q")]);

  useEffect(() => {
    if (!searched && !results.length) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 180);
      return () => window.clearTimeout(t);
    }
  }, [searched, results.length]);

  const artists = useMemo(() => {
    const map = new Map<string, { name: string; coverUrl?: string; count: number }>();
    for (const t of results) {
      const name = (t.artist || "Unknown").trim();
      const key = name.toLowerCase();
      const prev = map.get(key);
      if (prev) prev.count += 1;
      else map.set(key, { name, coverUrl: t.coverUrl, count: 1 });
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [results]);

  const albums = useMemo(() => {
    const map = new Map<
      string,
      { album: string; artist: string; coverUrl?: string; tracks: TrackMeta[] }
    >();
    for (const t of results) {
      const album = (t.album || "").trim();
      if (!album) continue;
      const key = `${album.toLowerCase()}|${(t.artist || "").toLowerCase()}`;
      const prev = map.get(key);
      if (prev) prev.tracks.push(t);
      else
        map.set(key, {
          album,
          artist: t.artist || "",
          coverUrl: t.coverUrl,
          tracks: [t],
        });
    }
    return [...map.values()];
  }, [results]);

  const onPlay = (t: TrackMeta) => {
    setPlayingId(t.id);
    setErr(null);
    void playTrack(t, results)
      .catch((e) => {
        setErr(
          String(e).replace(/^Error:\s*/, "") ||
            "Play failed — try again in a moment.",
        );
      })
      .finally(() => setPlayingId(null));
  };

  const empty = !busy && !results.length && !err;
  const showHero = empty && !searched;

  const searchForm = (compact?: boolean) => (
    <div className={`nb-browse-search-wrap${compact ? " is-compact" : ""}`}>
      <form
        className={`nb-browse-search${compact ? " is-compact" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Search className="nb-browse-search-icon" size={compact ? 18 : 20} aria-hidden />
        <input
          ref={inputRef}
          className="nb-browse-input"
          placeholder="Songs, artists, albums…  ·  Ctrl+K"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setHistOpen(true)}
          onBlur={() => window.setTimeout(() => setHistOpen(false), 160)}
          aria-label="Search"
          autoComplete="off"
        />
        <button
          type="submit"
          className="nb-browse-go"
          disabled={busy || !q.trim()}
        >
          {busy ? <Loader2 size={18} className="nb-spin" /> : "Search"}
        </button>
      </form>

      {histOpen && history.length ? (
        <div className="nb-browse-history" role="listbox" aria-label="Recent searches">
          <div className="nb-browse-history-head">
            <span>
              <Clock size={13} /> Recent
            </span>
            <button
              type="button"
              className="nb-tap-link"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                clearSearchHistory();
                setHistory([]);
              }}
            >
              Clear
            </button>
          </div>
          {history.map((term) => (
            <button
              key={term}
              type="button"
              className="nb-browse-history-row"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void search(term)}
            >
              <Clock size={14} />
              {term}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <section className={`nb-browse${showHero ? " is-hero" : ""}`}>
      {showHero ? (
        <div className="nb-browse-hero">
          <div className="nb-browse-orb" aria-hidden />
          <div className="nb-browse-orb nb-browse-orb-2" aria-hidden />

          <p className="nb-browse-kicker">
            <Radio size={14} /> NekoBeat · Stream
          </p>
          <h1 className="nb-browse-brand">Find anything</h1>
          <p className="nb-browse-lead">
            Extensions first. Live play in a second. Cache builds quietly for
            next time.
          </p>

          {searchForm()}

          <div className="nb-browse-chips" aria-label="Suggestions">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className="nb-browse-chip"
                onClick={() => void search(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <header className="nb-browse-bar">
            <div>
              <h1 className="nb-page-title">Browse</h1>
              <p className="nb-page-sub">
                {busy
                  ? "Searching extensions…"
                  : results.length
                    ? `${results.length} track${results.length === 1 ? "" : "s"}`
                    : "Try another query"}
              </p>
            </div>
          </header>

          {searchForm(true)}

          {results.length || busy ? (
            <div className="nb-browse-tabs" role="tablist" aria-label="Result type">
              {(
                [
                  ["tracks", "Tracks", results.length],
                  ["artists", "Artists", artists.length],
                  ["albums", "Albums", albums.length],
                ] as const
              ).map(([id, label, count]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  className={`nb-browse-tab${tab === id ? " is-on" : ""}`}
                  onClick={() => setTab(id)}
                  disabled={busy && !results.length}
                >
                  {label}
                  {!busy && count ? <em>{count}</em> : null}
                </button>
              ))}
            </div>
          ) : null}

          {err ? <p className="nb-browse-err">{err}</p> : null}
          {playingId ? (
            <p className="nb-browse-status">Starting stream…</p>
          ) : null}

          {busy && !results.length ? (
            <div className="nb-browse-skel" aria-busy="true">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="nb-browse-skel-row">
                  <div className="nb-skeleton nb-browse-skel-art" />
                  <div className="nb-browse-skel-meta">
                    <div className="nb-skeleton nb-browse-skel-line" />
                    <div className="nb-skeleton nb-browse-skel-line sm" />
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {!busy && tab === "tracks" && results.length ? (
            <div className="nb-browse-results">
              <TrackList
                tracks={results}
                onPlay={onPlay}
                activeId={current?.id}
              />
            </div>
          ) : null}

          {!busy && tab === "artists" && artists.length ? (
            <div className="nb-browse-entity-grid">
              {artists.map((a) => (
                <button
                  key={a.name}
                  type="button"
                  className="nb-browse-entity"
                  onClick={() => void search(a.name)}
                >
                  <span className="nb-browse-entity-art is-round">
                    {a.coverUrl ? (
                      <img src={a.coverUrl} alt="" />
                    ) : (
                      <span>{a.name.charAt(0)}</span>
                    )}
                  </span>
                  <strong>{a.name}</strong>
                  <em>
                    {a.count} track{a.count === 1 ? "" : "s"}
                  </em>
                </button>
              ))}
            </div>
          ) : null}

          {!busy && tab === "albums" && albums.length ? (
            <div className="nb-browse-entity-grid">
              {albums.map((a) => (
                <button
                  key={`${a.album}-${a.artist}`}
                  type="button"
                  className="nb-browse-entity"
                  onClick={() => {
                    if (a.tracks[0]) onPlay(a.tracks[0]);
                  }}
                >
                  <span className="nb-browse-entity-art">
                    {a.coverUrl ? (
                      <img src={a.coverUrl} alt="" />
                    ) : (
                      <span>{a.album.charAt(0)}</span>
                    )}
                  </span>
                  <strong>{a.album}</strong>
                  <em>{a.artist}</em>
                </button>
              ))}
            </div>
          ) : null}

          {!busy && tab === "artists" && !artists.length && results.length ? (
            <div className="nb-browse-empty">
              <strong>No artist groups</strong>
            </div>
          ) : null}
          {!busy && tab === "albums" && !albums.length && results.length ? (
            <div className="nb-browse-empty">
              <strong>No album metadata on these hits</strong>
              <span>Try Tracks tab, or search an album title.</span>
            </div>
          ) : null}

          {searched && !busy && !err && !results.length ? (
            <div className="nb-browse-empty">
              <strong>No matches</strong>
              <span>Try a shorter title, or an artist name.</span>
              <div className="nb-browse-chips">
                {SUGGESTIONS.slice(0, 4).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="nb-browse-chip"
                    onClick={() => void search(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
