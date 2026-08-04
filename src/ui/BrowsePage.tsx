import { useState } from "react";
import { api } from "../lib/api";
import type { TrackMeta } from "../lib/types";
import { usePlayer } from "../player/PlayerContext";
import { TrackList } from "./TrackList";

export function BrowsePage() {
  const { playTrack } = usePlayer();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<TrackMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const rows = await api.searchStream(q.trim());
      setResults(rows);
    } catch (e) {
      setErr(String(e));
      setResults([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h1 className="nb-page-title">Browse</h1>
      <p className="nb-page-sub">
        Spotube-style search → resolve → stream through libmpv.
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          className="nb-input"
          placeholder="Search songs, artists…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
        />
        <button type="button" className="nb-btn" onClick={search} disabled={busy}>
          {busy ? "…" : "Search"}
        </button>
      </div>
      {err ? <p style={{ color: "var(--nb-danger)" }}>{err}</p> : null}
      {results.length ? (
        <TrackList tracks={results} onPlay={(t) => playTrack(t, results)} />
      ) : (
        <div className="nb-empty">Search to stream. Same metadata feeds covers and lyrics.</div>
      )}
    </section>
  );
}
