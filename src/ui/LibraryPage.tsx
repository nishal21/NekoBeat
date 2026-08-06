import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { TrackMeta } from "../lib/types";
import { usePlayer } from "../player/PlayerContext";
import { TrackList } from "./TrackList";

export function LibraryPage() {
  const { playTrack } = usePlayer();
  const [tracks, setTracks] = useState<TrackMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");

  const reload = () => api.libraryList().then(setTracks).catch(() => setTracks([]));

  useEffect(() => {
    reload();
  }, []);

  const scan = async () => {
    setBusy(true);
    try {
      const picked = await open({ directory: true, multiple: true });
      const paths = Array.isArray(picked)
        ? picked
        : picked
          ? [picked]
          : [];
      if (paths.length) {
        await api.libraryScan(paths);
        await reload();
      }
    } finally {
      setBusy(false);
    }
  };

  const filtered = tracks.filter(
    (t) =>
      !q ||
      t.title.toLowerCase().includes(q.toLowerCase()) ||
      t.artist.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <section>
      <h1 className="nb-page-title">Library</h1>
      <p className="nb-page-sub">
        Local folders, tags, and album art — scan once, play forever.
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <button type="button" className="nb-btn" onClick={scan} disabled={busy}>
          {busy ? "Scanning…" : "Scan folder"}
        </button>
        <input
          className="nb-input"
          style={{ maxWidth: 320 }}
          placeholder="Search library"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {filtered.length ? (
        <TrackList tracks={filtered} onPlay={(t) => playTrack(t, filtered)} />
      ) : (
        <div className="nb-empty">Scan a music folder to get started.</div>
      )}
    </section>
  );
}
