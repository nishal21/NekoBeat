import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { TrackMeta } from "../lib/types";
import { usePlayer } from "../player/PlayerContext";
import { TrackList } from "./TrackList";

/** YesPlayMusic-inspired home + SpotiFLAC cloud announcement */
export function ListenPage() {
  const { playTrack } = usePlayer();
  const [continueList, setContinueList] = useState<TrackMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [announce, setAnnounce] = useState<{
    announcementTitle?: string;
    announcementMessage?: string;
    ctaUrl?: string;
    ctaLabel?: string;
  } | null>(null);

  useEffect(() => {
    api
      .libraryList()
      .then((rows) => setContinueList(rows.slice(0, 12)))
      .catch(() => setContinueList([]))
      .finally(() => setLoading(false));
    api
      .zarzConfig()
      .then((c) => {
        if (c.announcementEnabled === false) return;
        if (c.announcementTitle || c.announcementMessage) setAnnounce(c);
      })
      .catch(() => {});
  }, []);

  return (
    <section>
      <div className="nb-hero-listen">
        <h1 className="nb-page-title">NekoBeat</h1>
        <p className="nb-page-sub">
          Continue · Browse · HiFi FLAC — Harmonoid feel, Spotube play, SpotiFLAC
          via api.zarz.moe, YesPlayMusic polish.
        </p>
      </div>

      {announce ? (
        <aside className="nb-announce">
          <strong>{announce.announcementTitle || "SpotiFLAC cloud"}</strong>
          <p>{announce.announcementMessage}</p>
          {announce.ctaUrl ? (
            <a href={announce.ctaUrl} target="_blank" rel="noreferrer">
              {announce.ctaLabel || "Learn more"}
            </a>
          ) : null}
        </aside>
      ) : null}

      <div className="nb-home-grid">
        <article className="nb-home-card">
          <h3>Daily mix</h3>
          <p>Recommendations land here as online sources warm up.</p>
        </article>
        <article className="nb-home-card">
          <h3>Private FM</h3>
          <p>YesPlayMusic-style radio vibe — ListenBrainz/charts next.</p>
        </article>
        <article className="nb-home-card">
          <h3>HiFi desk</h3>
          <p>
            Login on Extensions, pick Lossless/Hi-Res, resolve via api.zarz.moe.
          </p>
        </article>
      </div>

      <h2 className="nb-section-title">Continue</h2>
      {loading ? (
        <div style={{ display: "grid", gap: 8 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="nb-skeleton" style={{ height: 56 }} />
          ))}
        </div>
      ) : continueList.length ? (
        <TrackList
          tracks={continueList}
          onPlay={(t) => playTrack(t, continueList)}
        />
      ) : (
        <div className="nb-empty">
          <p>Nothing here yet. Scan Library or search Browse — two taps to play.</p>
        </div>
      )}
    </section>
  );
}
