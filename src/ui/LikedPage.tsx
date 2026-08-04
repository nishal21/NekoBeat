import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { TrackMeta } from "../lib/types";
import { usePlayer } from "../player/PlayerContext";
import { TrackList } from "./TrackList";

export function LikedPage() {
  const { playTrack } = usePlayer();
  const [tracks, setTracks] = useState<TrackMeta[]>([]);

  useEffect(() => {
    api.libraryLiked().then(setTracks).catch(() => setTracks([]));
  }, []);

  return (
    <section>
      <h1 className="nb-page-title">Liked</h1>
      <p className="nb-page-sub">Favorites and offline-ready likes.</p>
      {tracks.length ? (
        <TrackList tracks={tracks} onPlay={(t) => playTrack(t, tracks)} />
      ) : (
        <div className="nb-empty">Heart a track while playing to save it here.</div>
      )}
    </section>
  );
}
