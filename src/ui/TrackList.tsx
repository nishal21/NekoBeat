import type { TrackMeta } from "../lib/types";
import { CoverArt } from "./CoverArt";

export function TrackList({
  tracks,
  onPlay,
  trailing,
  activeId,
}: {
  tracks: TrackMeta[];
  onPlay: (t: TrackMeta) => void;
  trailing?: (t: TrackMeta) => React.ReactNode;
  activeId?: string | null;
}) {
  return (
    <div className="nb-track-list">
      {tracks.map((t) => (
        <div
          key={t.id}
          className={`nb-track-row${activeId && activeId === t.id ? " is-active" : ""}`}
          onClick={() => onPlay(t)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onPlay(t);
          }}
          role="button"
          tabIndex={0}
        >
          <CoverArt track={t} />
          <div className="nb-track-meta">
            <strong>{t.title}</strong>
            <span>
              {t.artist}
              {t.album ? ` · ${t.album}` : ""}
              {t.qualityLabel ? ` · ${t.qualityLabel}` : ""}
            </span>
          </div>
          <div onClick={(e) => e.stopPropagation()}>{trailing?.(t)}</div>
        </div>
      ))}
    </div>
  );
}
