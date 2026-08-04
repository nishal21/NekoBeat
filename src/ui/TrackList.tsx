import type { TrackMeta } from "../lib/types";

export function TrackList({
  tracks,
  onPlay,
  trailing,
}: {
  tracks: TrackMeta[];
  onPlay: (t: TrackMeta) => void;
  trailing?: (t: TrackMeta) => React.ReactNode;
}) {
  return (
    <div>
      {tracks.map((t) => (
        <div
          key={t.id}
          className="nb-track-row"
          onClick={() => onPlay(t)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onPlay(t);
          }}
          role="button"
          tabIndex={0}
        >
          {t.coverUrl ? (
            <img className="nb-cover" src={t.coverUrl} alt="" />
          ) : (
            <div className="nb-cover" />
          )}
          <div style={{ minWidth: 0 }}>
            <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {t.title}
            </strong>
            <span style={{ color: "var(--nb-ink-muted)", fontSize: "0.85rem" }}>
              {t.artist}
              {t.qualityLabel ? ` · ${t.qualityLabel}` : ""}
            </span>
          </div>
          <div onClick={(e) => e.stopPropagation()}>{trailing?.(t)}</div>
        </div>
      ))}
    </div>
  );
}
