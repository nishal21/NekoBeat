import { Compass, Flame, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import type { TrackMeta } from "../lib/types";
import { usePlayer } from "../player/PlayerContext";
import { TrackList } from "./TrackList";
import "./explore.css";

const GENRES = [
  "Pop",
  "Hip-Hop",
  "R&B",
  "Electronic",
  "Indie",
  "Jazz",
  "Rock",
  "Metal",
  "Lo-fi",
  "Classical",
  "Afrobeats",
  "K-Pop",
];

const HOT = [
  { q: "new music friday", label: "New This Week" },
  { q: "viral hits", label: "Viral" },
  { q: "chart toppers", label: "Charts" },
  { q: "underground hip hop", label: "Underground" },
  { q: "chill electronic", label: "Chill" },
  { q: "jazz piano", label: "Late Night Jazz" },
];

export function ExplorePage() {
  const navigate = useNavigate();
  const { playTrack, current } = usePlayer();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [title, setTitle] = useState("Hot & New");
  const [results, setResults] = useState<TrackMeta[]>([]);
  const [picked, setPicked] = useState<string | null>(null);

  const load = async (query: string, label: string) => {
    setBusy(true);
    setErr(null);
    setTitle(label);
    setPicked(query);
    try {
      const rows = await api.searchStream(query);
      setResults(rows);
      if (rows[0]) {
        window.setTimeout(() => {
          void api.resolveStream(rows[0]).catch(() => {});
        }, 350);
      }
    } catch (e) {
      setErr(String(e));
      setResults([]);
    } finally {
      setBusy(false);
    }
  };

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return "Morning finds";
    if (h < 18) return "Afternoon heat";
    return "Night discoveries";
  }, []);

  return (
    <section className="nb-explore">
      <header className="nb-explore-hero">
        <p className="nb-explore-kicker">
          <Compass size={14} /> Explore
        </p>
        <h1 className="nb-page-title">{greeting}</h1>
        <p className="nb-page-sub">
          Hot picks, genres, and fresh drops — tap a lane to stream.
        </p>
      </header>

      <div className="nb-explore-section">
        <h2>
          <Flame size={16} /> Hot & New
        </h2>
        <div className="nb-explore-cards">
          {HOT.map((c) => (
            <button
              key={c.q}
              type="button"
              className={`nb-explore-card${picked === c.q ? " is-on" : ""}`}
              onClick={() => void load(c.q, c.label)}
            >
              <strong>{c.label}</strong>
              <span>Stream now</span>
            </button>
          ))}
        </div>
      </div>

      <div className="nb-explore-section">
        <h2>
          <Sparkles size={16} /> Genres
        </h2>
        <div className="nb-explore-genres">
          {GENRES.map((g) => (
            <button
              key={g}
              type="button"
              className={`nb-explore-genre${picked === g ? " is-on" : ""}`}
              onClick={() => void load(g, g)}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      <div className="nb-explore-results">
        <div className="nb-explore-results-head">
          <h2>{title}</h2>
          {results.length ? (
            <button
              type="button"
              className="nb-tap-link"
              onClick={() =>
                navigate(`/browse?q=${encodeURIComponent(picked || title)}`)
              }
            >
              Open in Browse
            </button>
          ) : null}
        </div>

        {err ? <p className="nb-inline-error">{err}</p> : null}
        {busy ? (
          <div className="nb-browse-skel" aria-busy="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="nb-browse-skel-row">
                <div className="nb-skeleton nb-browse-skel-art" />
                <div className="nb-browse-skel-meta">
                  <div className="nb-skeleton nb-browse-skel-line" />
                  <div className="nb-skeleton nb-browse-skel-line sm" />
                </div>
              </div>
            ))}
          </div>
        ) : results.length ? (
          <TrackList
            tracks={results}
            onPlay={(t) => void playTrack(t, results)}
            activeId={current?.id}
          />
        ) : (
          <div className="nb-empty">
            Pick Hot & New or a genre to load tracks.
          </div>
        )}
      </div>
    </section>
  );
}
