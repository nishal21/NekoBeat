import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ExternalLink, Loader2 } from "lucide-react";
import { api } from "../lib/api";
import { fetchArtistBio, type ArtistBio } from "../lib/artistBio";
import type { TrackMeta } from "../lib/types";
import { usePlayer } from "../player/PlayerContext";
import { TrackList } from "./TrackList";
import "./artist.css";

export function ArtistPage() {
  const [params] = useSearchParams();
  const name = (params.get("name") || "").trim();
  const navigate = useNavigate();
  const { playTrack, current } = usePlayer();
  const [bio, setBio] = useState<ArtistBio | null>(null);
  const [bioErr, setBioErr] = useState<string | null>(null);
  const [bioLoading, setBioLoading] = useState(false);
  const [tracks, setTracks] = useState<TrackMeta[]>([]);
  const [tracksBusy, setTracksBusy] = useState(false);

  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    setBioLoading(true);
    setBioErr(null);
    fetchArtistBio(name)
      .then((b) => {
        if (!cancelled) setBio(b);
      })
      .catch((e) => {
        if (!cancelled) {
          setBio({ name, tags: [], links: [] });
          setBioErr(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setBioLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    setTracksBusy(true);
    api
      .searchStream(name)
      .then((rows) => {
        if (!cancelled) setTracks(rows);
      })
      .catch(() => {
        if (!cancelled) setTracks([]);
      })
      .finally(() => {
        if (!cancelled) setTracksBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  if (!name) {
    return (
      <section>
        <h1 className="nb-page-title">Artist</h1>
        <p className="nb-page-sub">Pick an artist from search or now playing.</p>
      </section>
    );
  }

  return (
    <section className="nb-artist">
      <header className="nb-artist-hero">
        {bio?.imageUrl ? (
          <img
            className="nb-artist-photo"
            src={bio.imageUrl}
            alt=""
            loading="lazy"
          />
        ) : (
          <div className="nb-artist-photo is-fallback" aria-hidden>
            {(bio?.name || name).slice(0, 1).toUpperCase()}
          </div>
        )}
        <div>
          <p className="nb-artist-kicker">Artist</p>
          <h1 className="nb-page-title">{bio?.name || name}</h1>
          {bio?.tags.length ? (
            <div className="nb-artist-tags">
              {bio.tags.map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
          ) : null}
        </div>
      </header>

      {bioLoading ? (
        <p className="nb-page-sub">
          <Loader2 size={14} className="nb-spin" /> Loading biography…
        </p>
      ) : null}
      {bioErr ? <p className="nb-inline-error">{bioErr}</p> : null}

      {bio?.summary ? (
        <p className="nb-artist-bio">{bio.summary}</p>
      ) : !bioLoading ? (
        <p className="nb-page-sub">No biography found yet.</p>
      ) : null}

      {bio?.links.length ? (
        <div className="nb-artist-links">
          {bio.links.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              className="nb-artist-link"
            >
              {l.label}
              <ExternalLink size={12} />
            </a>
          ))}
        </div>
      ) : null}

      <div className="nb-artist-tracks">
        <div className="nb-explore-results-head">
          <h2>Top results</h2>
          <button
            type="button"
            className="nb-tap-link"
            onClick={() =>
              navigate(`/browse?q=${encodeURIComponent(name)}`)
            }
          >
            Browse all
          </button>
        </div>
        {tracksBusy ? (
          <div className="nb-empty">Searching…</div>
        ) : tracks.length ? (
          <TrackList
            tracks={tracks}
            onPlay={(t) => void playTrack(t, tracks)}
            activeId={current?.id}
          />
        ) : (
          <div className="nb-empty">No stream results for this artist.</div>
        )}
      </div>
    </section>
  );
}
