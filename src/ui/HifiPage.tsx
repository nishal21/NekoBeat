import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { DownloadJob, TrackMeta } from "../lib/types";
import { usePlayer } from "../player/PlayerContext";
import { QualityBadge } from "./QualityBadge";
import { TrackList } from "./TrackList";

const QUALITIES = ["LOSSLESS", "HI_RES", "HI_RES_LOSSLESS"] as const;

export function HifiPage() {
  const { playTrack, settings, setSettings } = usePlayer();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<TrackMeta[]>([]);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [busy, setBusy] = useState(false);

  const refreshJobs = () => api.hifiJobs().then(setJobs).catch(() => {});

  useEffect(() => {
    refreshJobs();
    const id = setInterval(refreshJobs, 1500);
    return () => clearInterval(id);
  }, []);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const rows = await api.searchHifi(q.trim());
      setResults(
        rows.map((r) => ({
          ...r,
          qualityLabel: settings.hifiQuality,
        })),
      );
    } finally {
      setBusy(false);
    }
  };

  const download = async (t: TrackMeta) => {
    if (settings.askBeforeDownload) {
      const ok = window.confirm(
        `Download FLAC as ${settings.hifiQuality} via ${settings.preferredDownloadService}?\n\nLogin required on that extension if not already connected.`,
      );
      if (!ok) return;
    }
    const job = await api.enqueueHifi({
      ...t,
      qualityLabel: settings.hifiQuality,
    });
    if (job.needsLogin) {
      window.alert(
        job.error ||
          `Login required for ${settings.preferredDownloadService}. Open Extensions → Login.`,
      );
    }
    await refreshJobs();
  };

  return (
    <section>
      <h1 className="nb-page-title">HiFi</h1>
      <p className="nb-page-sub">
        Paste a Spotify URL or search. Resolve uses{" "}
        <strong>api.zarz.moe/v1/resolve</strong> (same as SpotiFLAC Mobile).
        Login required on preferred provider. Service:{" "}
        <strong>{settings.preferredDownloadService}</strong> · Quality chips
        below.
      </p>

      <div className="nb-quality-picker" role="group" aria-label="Download quality">
        {QUALITIES.map((opt) => (
          <button
            key={opt}
            type="button"
            className={`nb-chip ${settings.hifiQuality === opt ? "is-on" : ""}`}
            onClick={() => setSettings({ ...settings, hifiQuality: opt })}
          >
            {opt === "LOSSLESS"
              ? "Lossless"
              : opt === "HI_RES"
                ? "Hi-Res"
                : "Hi-Res Lossless"}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          className="nb-input"
          placeholder="Spotify URL or search…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
        />
        <button type="button" className="nb-btn" onClick={search} disabled={busy}>
          Search
        </button>
      </div>

      <TrackList
        tracks={results}
        onPlay={(t) => playTrack({ ...t, source: "stream" }, results)}
        trailing={(t) => (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <QualityBadge requested={settings.hifiQuality} label={t.qualityLabel} />
            <button
              type="button"
              className="nb-btn ghost"
              onClick={() => download(t)}
            >
              Get FLAC
            </button>
          </div>
        )}
      />

      <h2 style={{ fontFamily: "var(--nb-font-display)", marginTop: 24 }}>
        Download queue
      </h2>
      {jobs.length ? (
        <div>
          {jobs.map((j) => (
            <div key={j.id} className="nb-track-row">
              <div className="nb-cover" />
              <div style={{ minWidth: 0 }}>
                <strong>
                  {j.track.title} — {j.status}
                </strong>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    flexWrap: "wrap",
                    marginTop: 4,
                  }}
                >
                  <QualityBadge
                    requested={j.requestedQuality || settings.hifiQuality}
                    label={j.measuredFormat}
                    bitDepth={j.bitDepth}
                    sampleRateHz={j.sampleRateHz}
                  />
                  {j.service ? (
                    <span className="nb-quality-badge tone-stream">
                      {j.service}
                      {j.needsLogin ? " · login" : ""}
                    </span>
                  ) : null}
                  <span style={{ color: "var(--nb-ink-muted)", fontSize: "0.85rem" }}>
                    {Math.round(j.progress * 100)}%
                    {j.error ? ` · ${j.error}` : ""}
                  </span>
                </div>
                {j.status === "running" ? (
                  <div className="nb-progress">
                    <i style={{ width: `${Math.round(j.progress * 100)}%` }} />
                  </div>
                ) : null}
              </div>
              {j.status === "done" && j.filePath ? (
                <button
                  type="button"
                  className="nb-btn ghost"
                  onClick={() =>
                    playTrack({
                      ...j.track,
                      path: j.filePath,
                      source: "local",
                      qualityLabel: j.measuredFormat || "FLAC",
                    })
                  }
                >
                  Play
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="nb-empty">Queue is empty — pick a quality, search, Get FLAC.</div>
      )}
    </section>
  );
}
