import {
  ChevronDown,
  Disc3,
  ExternalLink,
  Heart,
  ListMusic,
  Pause,
  Play,
  Radio,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { fetchArtistBio, type ArtistBio } from "../lib/artistBio";
import { api } from "../lib/api";
import { groupAlbums, isTauri } from "../lib/libraryHelpers";
import { useMediaQuery } from "../lib/useMediaQuery";
import type { TrackMeta } from "../lib/types";
import { CoverArt } from "../ui/CoverArt";
import { MotionCover, MotionLyricLine, MotionRail } from "./npMotion";
import { usePlayer } from "./PlayerContext";
import { QueuePanel } from "./QueuePanel";
import { splitArtists } from "./splitArtists";
import { TappableArtists } from "./TappableArtists";

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

/** Circular progress ring — stroke only captures clicks so art stays tappable. */
function CircularSeek({
  pct,
  duration,
  position,
  onSeek,
  children,
}: {
  pct: number;
  duration: number;
  position: number;
  onSeek: (ms: number) => void;
  children: ReactNode;
}) {
  const r = 47;
  const c = 2 * Math.PI * r;
  const offset = c - (Math.min(100, Math.max(0, pct)) / 100) * c;

  const onPointer = (e: PointerEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const ang = Math.atan2(e.clientY - cy, e.clientX - cx);
    let t = (ang + Math.PI / 2) / (2 * Math.PI);
    if (t < 0) t += 1;
    onSeek(Math.round(t * Math.max(duration, 1)));
  };

  return (
    <div className="nb-np-ring-wrap">
      <div className="nb-np-ring-art">{children}</div>
      <svg
        className="nb-np-ring"
        viewBox="0 0 100 100"
        aria-label="Seek"
        role="slider"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={position}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          onPointer(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons) onPointer(e);
        }}
      >
        <circle className="nb-np-ring-hit" cx="50" cy="50" r={r} />
        <circle className="nb-np-ring-track" cx="50" cy="50" r={r} />
        <circle
          className="nb-np-ring-fill"
          cx="50"
          cy="50"
          r={r}
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
    </div>
  );
}

export function ExpandedPlayer() {
  const navigate = useNavigate();
  const isMobile = useMediaQuery("(max-width: 900px)");
  const {
    current,
    playing,
    positionMs,
    durationMs,
    coverSrc,
    lyrics,
    lyricsStatus,
    shuffle,
    repeat,
    radio,
    liked,
    queue,
    index,
    toggle,
    next,
    prev,
    seek,
    likeCurrent,
    setExpanded,
    toggleShuffle,
    cycleRepeat,
    toggleRadio,
    playTrack,
    jumpTo,
  } = usePlayer();

  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const [side, setSide] = useState<"closed" | "queue" | "artist">("queue");
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [artistTracks, setArtistTracks] = useState<TrackMeta[]>([]);
  const [popular, setPopular] = useState<TrackMeta[]>([]);
  const [popularBusy, setPopularBusy] = useState(false);
  const [bio, setBio] = useState<ArtistBio | null>(null);
  const [bioOpen, setBioOpen] = useState(false);

  const synced = lyrics.some((l) => l.timeMs > 0);
  const activeIdx = (() => {
    if (!synced) return -1;
    let i = 0;
    for (let n = 0; n < lyrics.length; n++) {
      if (lyrics[n].timeMs <= positionMs) i = n;
      else break;
    }
    return i;
  })();

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.classList.add("nb-np-open");
    return () => {
      document.body.style.overflow = prevOverflow;
      document.documentElement.classList.remove("nb-np-open");
    };
  }, []);

  useEffect(() => {
    const el = activeRef.current;
    const box = listRef.current;
    if (!el || !box || activeIdx < 0 || !current) return;
    const top = el.offsetTop - box.clientHeight * 0.42;
    box.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [activeIdx, current?.id, lyricsOpen, isMobile]);

  useEffect(() => {
    if (!current?.artist || !isTauri()) {
      setArtistTracks([]);
      return;
    }
    let cancelled = false;
    const names = splitArtists(current.artist).map((n) => n.toLowerCase());
    api
      .libraryList()
      .then((all) => {
        if (cancelled) return;
        const related = all.filter((t) => {
          if (t.id === current.id) return false;
          const a = (t.artist || "").toLowerCase();
          return names.some(
            (n) =>
              a === n ||
              a.includes(n) ||
              n.includes(a.split(/[,&/]/)[0]?.trim() || ""),
          );
        });
        setArtistTracks(related.slice(0, 36));
      })
      .catch(() => {
        if (!cancelled) setArtistTracks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [current?.id, current?.artist]);

  useEffect(() => {
    const name = splitArtists(current?.artist || "")[0] || current?.artist;
    if (!name || side !== "artist") return;
    let cancelled = false;
    setBio(null);
    setBioOpen(false);
    fetchArtistBio(name)
      .then((b) => {
        if (!cancelled) setBio(b);
      })
      .catch(() => {
        if (!cancelled) setBio(null);
      });
    setPopularBusy(true);
    api
      .searchStream(name)
      .then((rows) => {
        if (!cancelled) setPopular(rows.slice(0, 10));
      })
      .catch(() => {
        if (!cancelled) setPopular([]);
      })
      .finally(() => {
        if (!cancelled) setPopularBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [current?.artist, side]);

  const artistAlbums = useMemo(
    () => groupAlbums(artistTracks).slice(0, 16),
    [artistTracks],
  );
  const upNext = useMemo(
    () => queue.slice(index + 1, index + 7),
    [queue, index],
  );
  const primaryArtist =
    splitArtists(current?.artist || "")[0] || current?.artist || "";

  if (!current) return null;

  const dur = Math.max(
    durationMs >= 1000 ? durationMs : 0,
    current.durationMs || 0,
    1,
  );
  const pct = Math.min(100, (positionMs / dur) * 100);
  const bg =
    coverSrc && (coverSrc.startsWith("http") || coverSrc.startsWith("data:"))
      ? { backgroundImage: `url("${coverSrc.replace(/"/g, "")}")` }
      : undefined;

  const goArtist = (name: string) => {
    setExpanded(false);
    navigate(`/artist?name=${encodeURIComponent(name)}`);
  };
  const goAlbum = (album: string, artist: string) => {
    setExpanded(false);
    navigate(
      `/?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`,
    );
  };
  const goBrowseArtist = () => {
    setExpanded(false);
    navigate(`/artist?name=${encodeURIComponent(primaryArtist)}`);
  };

  const RepeatIcon = repeat === "one" ? Repeat1 : Repeat;
  const sideOpen = side !== "closed";

  const renderLyrics = (sheet?: boolean) => (
    <div
      className={`nb-np-lyrics${sheet ? " is-sheet" : ""}`}
      ref={listRef}
      aria-label="Lyrics"
    >
      {lyricsStatus === "loading" ? (
        <p className="nb-np-lyrics-empty">Fetching lyrics…</p>
      ) : lyrics.length ? (
        synced ? (
          lyrics.map((l, i) => (
            <MotionLyricLine
              key={`${l.timeMs}-${i}`}
              active={i === activeIdx}
              past={i < activeIdx}
              lineRef={i === activeIdx ? (el) => {
                activeRef.current = el;
              } : undefined}
              onClick={() => void seek(l.timeMs)}
            >
              {l.text}
            </MotionLyricLine>
          ))
        ) : (
          lyrics.map((l, i) => (
            <p key={`plain-${i}`} className="nb-np-line is-plain">
              {l.text}
            </p>
          ))
        )
      ) : (
        <div className="nb-np-lyrics-empty">
          <p>No lyrics</p>
          <span>Synced lines show here when available</span>
        </div>
      )}
    </div>
  );

  const transport = (
    <div className="nb-np-transport">
      <button
        type="button"
        className={`nb-np-ghost${shuffle ? " is-on" : ""}`}
        aria-label="Shuffle"
        aria-pressed={shuffle}
        onClick={toggleShuffle}
      >
        <Shuffle size={18} />
      </button>
      <button type="button" onClick={() => void prev()} aria-label="Previous">
        <SkipBack size={26} fill="currentColor" />
      </button>
      <button
        type="button"
        className={`nb-np-play${playing ? " is-playing" : ""}`}
        onClick={() => void toggle()}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? (
          <Pause size={28} fill="currentColor" />
        ) : (
          <Play size={28} fill="currentColor" />
        )}
      </button>
      <button type="button" onClick={() => void next()} aria-label="Next">
        <SkipForward size={26} fill="currentColor" />
      </button>
      <button
        type="button"
        className={`nb-np-ghost${repeat !== "off" ? " is-on" : ""}`}
        aria-label={`Repeat ${repeat}`}
        aria-pressed={repeat !== "off"}
        onClick={cycleRepeat}
      >
        <RepeatIcon size={18} />
      </button>
      {isMobile ? (
        <button
          type="button"
          className={`nb-np-ghost${radio ? " is-on" : ""}`}
          aria-label="Recommendation radio"
          aria-pressed={radio}
          onClick={toggleRadio}
        >
          <Radio size={18} />
        </button>
      ) : null}
    </div>
  );

  /* ——— Mobile: circular stage + lyrics bottom sheet ——— */
  if (isMobile) {
    return (
      <div
        className="nb-np nb-np-mobile"
        role="dialog"
        aria-modal="true"
        aria-label="Now playing"
      >
        <div className="nb-np-bg" style={bg} />
        <div className="nb-np-mesh" aria-hidden />
        <div className="nb-np-scrim" />

        <header className="nb-np-top">
          <button
            type="button"
            className="nb-np-icon-btn"
            onClick={() => setExpanded(false)}
            aria-label="Close"
          >
            <ChevronDown size={22} />
          </button>
          <div className="nb-np-top-center">
            <span>Now playing</span>
            <strong>{current.album || "NekoBeat"}</strong>
          </div>
          <button
            type="button"
            className={`nb-np-icon-btn${liked ? " is-on" : ""}`}
            onClick={() => void likeCurrent()}
            aria-label={liked ? "Unlike" : "Like"}
            aria-pressed={liked}
          >
            <Heart size={18} fill={liked ? "currentColor" : "none"} />
          </button>
        </header>

        <div className="nb-np-stage">
          <div className="nb-np-stage-meta">
            <h2>{current.title || "Unknown"}</h2>
            <p>
              <TappableArtists
                artist={current.artist || "Unknown artist"}
                onArtist={goArtist}
              />
            </p>
          </div>

          <CircularSeek
            pct={pct}
            duration={dur}
            position={positionMs}
            onSeek={(ms) => void seek(ms)}
          >
            <div className={`nb-np-cover nb-np-cover-round${playing ? " is-anim" : ""}`} aria-hidden>
              <CoverArt
                track={current}
                className="nb-np-cover-art"
                size={240}
                eager
              />
            </div>
          </CircularSeek>

          <p className="nb-np-stage-time">{fmt(positionMs)}</p>

          {transport}

          {upNext[0] ? (
            <button
              type="button"
              className="nb-np-nextup"
              onClick={() => void jumpTo(index + 1)}
            >
              <CoverArt
                track={upNext[0]}
                className="nb-np-nextup-art"
                size={40}
              />
              <span>
                <em>Next songs</em>
                <strong>{upNext[0].title}</strong>
              </span>
              <span className="nb-np-nextup-dur">
                {fmt(upNext[0].durationMs || 0)}
              </span>
            </button>
          ) : null}

          <button
            type="button"
            className="nb-np-lyrics-tab"
            onClick={() => setLyricsOpen(true)}
          >
            Lyrics
          </button>
        </div>

        {lyricsOpen ? (
          <div className="nb-np-lyrics-drawer" role="dialog" aria-label="Lyrics">
            <header className="nb-np-lyrics-drawer-head">
              <div>
                <strong>{current.title}</strong>
                <span>{current.artist}</span>
              </div>
              <button
                type="button"
                className="nb-np-icon-btn"
                onClick={() => setLyricsOpen(false)}
                aria-label="Close lyrics"
              >
                <X size={20} />
              </button>
            </header>
            {renderLyrics(true)}
            <div className="nb-np-lyrics-drawer-foot">{transport}</div>
          </div>
        ) : null}

        {side === "queue" ? (
          <div className="nb-np-mobile-sheet">
            <QueuePanel open onClose={() => setSide("closed")} />
          </div>
        ) : null}
      </div>
    );
  }

  /* ——— Desktop: lyrics theatre + dock ——— */
  return (
    <div className="nb-np" role="dialog" aria-modal="true" aria-label="Now playing">
      <div className="nb-np-bg" style={bg} />
      <div className="nb-np-mesh" aria-hidden />
      <div className="nb-np-scrim" />

      <header className="nb-np-top">
        <button
          type="button"
          className="nb-np-icon-btn"
          onClick={() => setExpanded(false)}
          aria-label="Close"
        >
          <ChevronDown size={22} />
        </button>
        <div className="nb-np-top-center">
          <span>Now playing</span>
          <strong>{current.album || current.title || "NekoBeat"}</strong>
        </div>
        <div className="nb-np-top-actions">
          <button
            type="button"
            className={`nb-np-icon-btn${side === "queue" ? " is-on" : ""}`}
            onClick={() =>
              setSide((s) => (s === "queue" ? "closed" : "queue"))
            }
            aria-label="Queue"
            aria-pressed={side === "queue"}
          >
            <ListMusic size={18} />
          </button>
          <button
            type="button"
            className={`nb-np-icon-btn${side === "artist" ? " is-on" : ""}`}
            onClick={() =>
              setSide((s) => (s === "artist" ? "closed" : "artist"))
            }
            aria-label="More from artist"
            aria-pressed={side === "artist"}
          >
            <Disc3 size={18} />
          </button>
          <button
            type="button"
            className={`nb-np-icon-btn${radio ? " is-on" : ""}`}
            onClick={toggleRadio}
            aria-label="Recommendation radio"
            aria-pressed={radio}
            title="Keep finding similar tracks"
          >
            <Radio size={18} />
          </button>
          <button
            type="button"
            className={`nb-np-icon-btn${liked ? " is-on" : ""}`}
            onClick={() => void likeCurrent()}
            aria-label={liked ? "Unlike" : "Like"}
            aria-pressed={liked}
          >
            <Heart size={18} fill={liked ? "currentColor" : "none"} />
          </button>
        </div>
      </header>

      <div className={`nb-np-mid${sideOpen ? " has-rail" : ""}`}>
        <div className="nb-np-main">
          <div className={`nb-np-body${sideOpen ? " has-side" : ""}`}>
            {renderLyrics()}
          </div>

          <footer className="nb-np-dock">
            <div className="nb-np-dock-left">
              <MotionCover
                playing={playing}
                className={`nb-np-cover${playing ? " is-anim" : ""}`}
                onClick={() => setSide("artist")}
                label="Open artist"
              >
                <CoverArt
                  track={current}
                  className="nb-np-cover-art"
                  size={64}
                  eager
                />
              </MotionCover>
              <div className="nb-np-dock-meta">
                <h2>{current.title || "Unknown"}</h2>
                <p>
                  <TappableArtists
                    artist={current.artist || "Unknown artist"}
                    album={current.album}
                    onArtist={goArtist}
                    onAlbum={goAlbum}
                  />
                </p>
              </div>
            </div>

            <div className="nb-np-dock-center">
              {transport}
              <div className="nb-np-seek">
                <span>{fmt(positionMs)}</span>
                <div className="nb-np-seek-track">
                  <div className="nb-np-seek-fill" style={{ width: `${pct}%` }} />
                  <input
                    type="range"
                    min={0}
                    max={dur}
                    value={Math.min(positionMs, Math.max(dur, 1))}
                    onChange={(e) => void seek(Number(e.target.value))}
                    aria-label="Seek"
                  />
                </div>
                <span>
                  {fmt(
                    durationMs >= 1000
                      ? durationMs
                      : current.durationMs || durationMs || 0,
                  )}
                </span>
              </div>
            </div>

            <div className="nb-np-dock-right" aria-hidden />
          </footer>
        </div>

        {sideOpen ? (
          <aside className="nb-np-rail" aria-label={side === "queue" ? "Queue" : "Artist"}>
            {side === "queue" ? (
              <QueuePanel
                open
                embedded
                onClose={() => setSide("closed")}
              />
            ) : null}

            {side === "artist" ? (
              <div className="nb-np-side nb-np-artist-panel">
                <header className="nb-np-artist-hero">
                  {bio?.imageUrl ? (
                    <img
                      className="nb-np-artist-photo"
                      src={bio.imageUrl}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <div className="nb-np-artist-photo is-fallback" aria-hidden>
                      {(primaryArtist || "?").slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="nb-np-artist-hero-text">
                    <span>Artist</span>
                    <strong>{bio?.name || primaryArtist}</strong>
                    {bio?.tags?.length ? (
                      <div className="nb-np-artist-tags">
                        {bio.tags.slice(0, 3).map((t) => (
                          <em key={t}>{t}</em>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="nb-np-side-link"
                    onClick={goBrowseArtist}
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    className="nb-np-icon-btn nb-np-rail-close"
                    onClick={() => setSide("closed")}
                    aria-label="Close"
                  >
                    <X size={16} />
                  </button>
                </header>

                <div className="nb-np-side-scroll">
                  <div className="nb-np-side-block">
                    <h3>Popular</h3>
                    {popularBusy ? (
                      <p className="nb-np-side-empty">Loading…</p>
                    ) : popular.length ? (
                      <ul className="nb-np-side-list">
                        {popular.map((t, i) => (
                          <li key={t.id}>
                            <button
                              type="button"
                              className={`nb-np-side-row${
                                current.id === t.id ? " is-on" : ""
                              }`}
                              onClick={() => void playTrack(t, popular)}
                            >
                              <span className="nb-np-side-num">{i + 1}</span>
                              <CoverArt
                                track={t}
                                className="nb-np-side-cover"
                                size={40}
                              />
                              <span>
                                <strong>{t.title}</strong>
                                <em>{t.album || t.artist}</em>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="nb-np-side-empty">
                        No popular tracks yet.
                      </p>
                    )}
                  </div>

                  {bio?.summary ? (
                    <div className="nb-np-side-block">
                      <h3>About</h3>
                      <p className="nb-np-bio-text">
                        {bioOpen || bio.summary.length <= 160
                          ? bio.summary
                          : `${bio.summary.slice(0, 160)}…`}
                      </p>
                      {bio.summary.length > 160 ? (
                        <button
                          type="button"
                          className="nb-np-bio-more"
                          onClick={() => setBioOpen((v) => !v)}
                        >
                          {bioOpen ? "Show less" : "Read more"}
                        </button>
                      ) : null}
                      {bio.links.length ? (
                        <div className="nb-np-bio-links">
                          {bio.links.slice(0, 4).map((l) => (
                            <a
                              key={l.url}
                              href={l.url}
                              target="_blank"
                              rel="noreferrer"
                              className="nb-np-bio-link"
                            >
                              {l.label}
                              <ExternalLink size={11} />
                            </a>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {artistAlbums.length || artistTracks.length ? (
                    <div className="nb-np-side-block">
                      <h3>
                        Library
                        {artistAlbums.length
                          ? ` · ${artistAlbums.length}`
                          : ` · ${artistTracks.length}`}
                      </h3>
                      <div className="nb-np-side-grid">
                        {artistAlbums.length
                          ? artistAlbums.slice(0, 6).map((a) => (
                              <button
                                key={a.key}
                                type="button"
                                className="nb-np-artist-item"
                                onClick={() => {
                                  if (a.tracks[0])
                                    void playTrack(a.tracks[0], a.tracks);
                                }}
                              >
                                <CoverArt
                                  track={{
                                    id: a.tracks[0]?.id || a.key,
                                    title: a.album,
                                    artist: a.artist,
                                    coverUrl:
                                      a.coverUrl || a.tracks[0]?.coverUrl,
                                    path: a.tracks[0]?.path,
                                    album: a.album,
                                  }}
                                  className="nb-np-artist-cover"
                                  size={88}
                                />
                                <strong>{a.album}</strong>
                                <span>
                                  {a.tracks.length} track
                                  {a.tracks.length === 1 ? "" : "s"}
                                </span>
                              </button>
                            ))
                          : artistTracks.slice(0, 6).map((t) => (
                              <button
                                key={t.id}
                                type="button"
                                className="nb-np-artist-item"
                                onClick={() => void playTrack(t, artistTracks)}
                              >
                                <CoverArt
                                  track={t}
                                  className="nb-np-artist-cover"
                                  size={88}
                                />
                                <strong>{t.title}</strong>
                                <span>{t.album || t.artist}</span>
                              </button>
                            ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
