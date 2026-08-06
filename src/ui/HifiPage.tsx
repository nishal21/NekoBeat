import { listen } from "@tauri-apps/api/event";
import {
  Download,
  FolderOpen,
  Headphones,
  Loader2,
  Search,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { DownloadJob, TrackMeta } from "../lib/types";
import { usePlayer } from "../player/PlayerContext";
import { CoverArt } from "./CoverArt";
import { QualityBadge } from "./QualityBadge";
import { TrackList } from "./TrackList";
import "./hifi.css";

const QUALITIES = [
  {
    id: "LOSSLESS" as const,
    label: "Lossless",
    hint: "CD · 16-bit",
  },
  {
    id: "HI_RES" as const,
    label: "Hi-Res",
    hint: "24-bit",
  },
  {
    id: "HI_RES_LOSSLESS" as const,
    label: "Max",
    hint: "Studio",
  },
];

const SUGGESTIONS = [
  "Aurora Runaway",
  "Tate McRae",
  "Freddie Dredd",
  "lofi jazz",
];

function fmtBytes(n?: number) {
  if (n == null || n <= 0) return "";
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function jobPct(j: DownloadJob) {
  return Math.max(0, Math.min(100, Math.round((j.progress || 0) * 100)));
}

function shortPath(p: string) {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  if (parts.length <= 2) return p;
  return parts.slice(-2).join(" · ");
}

export function HifiPage() {
  const { playTrack, settings, setSettings, current } = usePlayer();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<TrackMeta[]>([]);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [downloadDir, setDownloadDir] = useState("");
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refreshJobs = () => api.hifiJobs().then(setJobs).catch(() => {});

  useEffect(() => {
    refreshJobs();
    api.hifiDownloadDir().then(setDownloadDir).catch(() => {});
    let unlisten: (() => void) | undefined;
    listen<DownloadJob>("hifi-job-update", (ev) => {
      const job = ev.payload;
      setJobs((prev) => {
        const i = prev.findIndex((j) => j.id === job.id);
        if (i < 0) return [job, ...prev];
        const next = [...prev];
        next[i] = job;
        return next;
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    api.hifiDownloadDir().then(setDownloadDir).catch(() => {});
  }, [settings.downloadDir]);

  useEffect(() => {
    if (!searched && !results.length && !jobs.length) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 180);
      return () => window.clearTimeout(t);
    }
  }, [searched, results.length, jobs.length]);

  const activeJobs = useMemo(
    () => jobs.filter((j) => j.status === "queued" || j.status === "running"),
    [jobs],
  );

  // Poll only while downloads are active — events cover most updates; idle = no interval.
  useEffect(() => {
    if (!activeJobs.length) return;
    const id = window.setInterval(refreshJobs, 800);
    return () => window.clearInterval(id);
  }, [activeJobs.length]);

  const doneCount = useMemo(
    () => jobs.filter((j) => j.status === "done").length,
    [jobs],
  );

  // Hero whenever there's nothing to show yet (jobs alone shouldn't hide Studio FLAC).
  const showHero = !searched && !results.length && !busy;

  const search = async (query = q) => {
    const term = query.trim();
    if (!term) return;
    setBusy(true);
    setResults([]);
    setErr(null);
    setSearched(true);
    setQ(term);
    try {
      const rows = await api.searchHifi(term);
      setResults(
        rows.map((r) => ({
          ...r,
          qualityLabel: settings.hifiQuality,
        })),
      );
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const playPreview = (t: TrackMeta) => {
    setPlayingId(t.id);
    setErr(null);
    void playTrack(
      {
        ...t,
        source: "stream",
        streamUrl: t.streamUrl,
      },
      results,
    )
      .catch((e) => {
        setErr(
          String(e).replace(/^Error:\s*/, "") ||
            "Preview failed — first play remuxes to MP3 (needs ffmpeg).",
        );
      })
      .finally(() => setPlayingId(null));
  };

  const playDownloaded = (j: DownloadJob) => {
    if (!j.filePath) return;
    setErr(null);
    void playTrack({
      ...j.track,
      path: j.filePath,
      source: "local",
      qualityLabel: j.measuredFormat || "FLAC",
    }).catch((e) => {
      setErr(String(e).replace(/^Error:\s*/, ""));
    });
  };

  const download = async (t: TrackMeta) => {
    if (settings.askBeforeDownload) {
      const ok = window.confirm(
        `Download FLAC as ${settings.hifiQuality} via ${settings.preferredDownloadService}? Metadata & cover will be embedded.`,
      );
      if (!ok) return;
    }
    await api.enqueueHifi({
      ...t,
      qualityLabel: settings.hifiQuality,
    });
    await refreshJobs();
    requestAnimationFrame(() => {
      document.getElementById("nb-hifi-queue")?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    });
  };

  const qualityPicker = (
    <div className="nb-hifi-quality" role="group" aria-label="Download quality">
      {QUALITIES.map((opt) => (
        <button
          key={opt.id}
          type="button"
          className={`nb-hifi-q${settings.hifiQuality === opt.id ? " is-on" : ""}`}
          onClick={() => setSettings({ ...settings, hifiQuality: opt.id })}
        >
          <span className="nb-hifi-q-label">{opt.label}</span>
          <span className="nb-hifi-q-hint">{opt.hint}</span>
        </button>
      ))}
    </div>
  );

  const searchForm = (
    <form
      className={`nb-hifi-search${showHero ? "" : " is-compact"}`}
      onSubmit={(e) => {
        e.preventDefault();
        void search();
      }}
    >
      <Search className="nb-hifi-search-icon" size={showHero ? 20 : 18} aria-hidden />
      <input
        ref={inputRef}
        className="nb-hifi-input"
        placeholder="Spotify URL or search…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search HiFi"
        autoComplete="off"
      />
      <button type="submit" className="nb-hifi-go" disabled={busy || !q.trim()}>
        {busy ? <Loader2 size={18} className="nb-spin" /> : "Search"}
      </button>
    </form>
  );

  const folderChip = downloadDir ? (
    <div className="nb-hifi-folder">
      <FolderOpen size={14} aria-hidden />
      <button
        type="button"
        className="nb-tap-link"
        onClick={() => void api.openPath(downloadDir)}
        title={downloadDir}
      >
        {shortPath(downloadDir)}
      </button>
      <span className="nb-hifi-folder-sep">·</span>
      <Link to="/settings" className="nb-tap-link">
        Change
      </Link>
    </div>
  ) : null;

  const queueBlock = (
    <div id="nb-hifi-queue" className="nb-hifi-queue">
      <div className="nb-hifi-queue-head">
        <h2>Download queue</h2>
        <span>
          {jobs.length
            ? `${doneCount}/${jobs.length} done`
            : "Ready when you are"}
        </span>
      </div>

      {jobs.length ? (
        <div className="nb-hifi-jobs">
          {jobs.map((j) => {
            const pct = jobPct(j);
            const running = j.status === "running" || j.status === "queued";
            return (
              <article key={j.id} className={`nb-hifi-job is-${j.status}`}>
                <CoverArt
                  track={j.track}
                  className="nb-hifi-job-art"
                  size={56}
                  eager={j.status === "running" || j.status === "queued"}
                />
                <div className="nb-hifi-job-body">
                  <div className="nb-hifi-job-top">
                    <strong>{j.track.title}</strong>
                    <span className={`nb-hifi-status is-${j.status}`}>
                      {j.status === "running"
                        ? "Downloading"
                        : j.status === "queued"
                          ? "Queued"
                          : j.status === "done"
                            ? "Done"
                            : "Error"}
                    </span>
                  </div>
                  <p className="nb-hifi-job-artist">{j.track.artist}</p>

                  <div className="nb-hifi-job-meta">
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
                    {j.metadataEmbedded === true ? (
                      <span className="nb-quality-badge tone-ok">
                        Tags embedded
                      </span>
                    ) : j.metadataEmbedded === false && j.status === "done" ? (
                      <span className="nb-quality-badge">No tags</span>
                    ) : null}
                  </div>

                  <p className="nb-hifi-stage">
                    {j.stageLabel || j.error || "Waiting…"}
                  </p>

                  <div className="nb-hifi-progress-row">
                    <div
                      className={`nb-progress nb-progress-lg${
                        running ? " is-live" : ""
                      }`}
                    >
                      <i style={{ width: `${pct}%` }} />
                    </div>
                    <span className="nb-hifi-pct">{pct}%</span>
                  </div>

                  <div className="nb-hifi-bytes">
                    {fmtBytes(j.bytesReceived)
                      ? `${fmtBytes(j.bytesReceived)}${
                          j.bytesTotal && j.bytesTotal !== j.bytesReceived
                            ? ` / ${fmtBytes(j.bytesTotal)}`
                            : ""
                        }`
                      : null}
                    {j.speedMbps && j.speedMbps > 0.05
                      ? ` · ${j.speedMbps.toFixed(1)} MB/s`
                      : null}
                  </div>
                  {j.filePath ? (
                    <p className="nb-hifi-path">
                      <button
                        type="button"
                        className="nb-tap-link"
                        onClick={() => void api.openPath(j.filePath!)}
                        title={j.filePath}
                      >
                        {j.filePath}
                      </button>
                      {j.libraryAdded ? (
                        <span className="nb-quality-badge tone-ok">
                          {" "}
                          In Library
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                </div>

                {j.status === "done" && j.filePath ? (
                  <button
                    type="button"
                    className="nb-btn"
                    onClick={() => void playDownloaded(j)}
                  >
                    Play
                  </button>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : showHero ? null : (
        <div className="nb-hifi-queue-empty">
          <Download size={28} strokeWidth={1.5} aria-hidden />
          <strong>Queue is empty</strong>
          <span>Search above, then hit Get FLAC — progress shows here.</span>
        </div>
      )}
    </div>
  );

  return (
    <section className={`nb-hifi${showHero ? " is-hero" : ""}`}>
      {showHero ? (
        <>
          <div className="nb-hifi-hero">
            <div className="nb-hifi-orb" aria-hidden />
            <div className="nb-hifi-orb nb-hifi-orb-2" aria-hidden />

            <p className="nb-hifi-kicker">
              <Headphones size={14} /> NekoBeat · HiFi
            </p>
            <h1 className="nb-hifi-brand">Studio FLAC</h1>
            <p className="nb-hifi-lead">
              Pick a quality, search, Get FLAC. Files land in your folder and
              Library.
            </p>

            {qualityPicker}
            {searchForm}
            {folderChip}

            <div className="nb-hifi-chips" aria-label="Suggestions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="nb-hifi-chip"
                  onClick={() => void search(s)}
                >
                  {s}
                </button>
              ))}
            </div>

            <ol className="nb-hifi-steps" aria-label="How it works">
              <li>
                <span>1</span> Choose quality
              </li>
              <li>
                <span>2</span> Search or paste URL
              </li>
              <li>
                <span>3</span> Get FLAC
              </li>
            </ol>
          </div>
          {jobs.length ? (
            <div className="nb-hifi-hero-queue">{queueBlock}</div>
          ) : null}
        </>
      ) : (
        <>
          <header className="nb-hifi-bar">
            <div>
              <h1 className="nb-page-title">HiFi</h1>
              <p className="nb-page-sub">
                {busy
                  ? "Searching extensions…"
                  : results.length
                    ? `${results.length} match${results.length === 1 ? "" : "es"} · ${
                        QUALITIES.find((x) => x.id === settings.hifiQuality)
                          ?.label || "Lossless"
                      }`
                    : "Search, then Get FLAC — saves to Library"}
              </p>
            </div>
            {folderChip}
          </header>

          {activeJobs.length > 0 ? (
            <div className="nb-hifi-active" aria-live="polite">
              <strong>
                {activeJobs.length} download
                {activeJobs.length > 1 ? "s" : ""} in progress
              </strong>
              {activeJobs.slice(0, 2).map((j) => (
                <div key={j.id} className="nb-hifi-active-row">
                  <span className="nb-hifi-active-title">{j.track.title}</span>
                  <span className="nb-hifi-active-pct">{jobPct(j)}%</span>
                  <div className="nb-progress nb-progress-lg">
                    <i style={{ width: `${jobPct(j)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {qualityPicker}
          {searchForm}

          {err ? <p className="nb-hifi-err">{err}</p> : null}
          {playingId ? (
            <p className="nb-hifi-status-line">Starting preview…</p>
          ) : null}

          {busy && !results.length ? (
            <div className="nb-hifi-loading" aria-busy="true">
              <Loader2 size={28} className="nb-spin" />
              <span>Looking up tracks…</span>
            </div>
          ) : null}

          {results.length ? (
            <div className="nb-hifi-results">
              <div className="nb-hifi-results-head">
                <Sparkles size={15} aria-hidden />
                <span>Tap play to preview · Get FLAC to download</span>
              </div>
              <TrackList
                tracks={results}
                onPlay={playPreview}
                activeId={current?.id}
                trailing={(t) => (
                  <div className="nb-hifi-row-actions">
                    <QualityBadge
                      requested={settings.hifiQuality}
                      label={t.qualityLabel}
                    />
                    <button
                      type="button"
                      className="nb-btn nb-hifi-get"
                      onClick={() => void download(t)}
                    >
                      <Download size={15} aria-hidden />
                      Get FLAC
                    </button>
                  </div>
                )}
              />
            </div>
          ) : searched && !busy && !err ? (
            <div className="nb-hifi-empty-results">
              <strong>No matches</strong>
              <span>Try a shorter title, artist, or paste a Spotify link.</span>
              <div className="nb-hifi-chips">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="nb-hifi-chip"
                    onClick={() => void search(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {queueBlock}
        </>
      )}
    </section>
  );
}
