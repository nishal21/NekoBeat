import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { TrackMeta } from "../lib/types";
import { usePlayer } from "../player/PlayerContext";
import { TrackList } from "./TrackList";

export function LikedPage() {
  const { playTrack, current } = usePlayer();
  const [tracks, setTracks] = useState<TrackMeta[]>([]);

  useEffect(() => {
    api.libraryLiked().then(setTracks).catch(() => setTracks([]));
  }, []);

  return (
    <section>
      <h1 className="nb-page-title">Library · Favorites</h1>
      <p className="nb-page-sub">
        Hearted tracks live here — your personal collection across sources.
      </p>
      {tracks.length ? (
        <TrackList
          tracks={tracks}
          onPlay={(t) => playTrack(t, tracks)}
          activeId={current?.id}
        />
      ) : (
        <div className="nb-empty">Heart a track while playing to save it here.</div>
      )}
    </section>
  );
}
