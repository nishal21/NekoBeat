import { Heart, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { usePlayer } from "./PlayerContext";
import "./player.css";

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export function MiniPlayer() {
  const {
    current,
    playing,
    positionMs,
    durationMs,
    coverSrc,
    toggle,
    next,
    prev,
    seek,
    likeCurrent,
    setExpanded,
  } = usePlayer();

  if (!current) {
    return (
      <div className="nb-mini nb-mini-empty">
        <span>Pick something to play</span>
      </div>
    );
  }

  const pct = durationMs > 0 ? (positionMs / durationMs) * 100 : 0;

  return (
    <div className="nb-mini">
      <button
        type="button"
        className="nb-mini-art"
        onClick={() => setExpanded(true)}
        aria-label="Expand player"
      >
        {coverSrc ? (
          <img src={coverSrc} alt="" />
        ) : (
          <div className="nb-cover-fallback" />
        )}
      </button>
      <div className="nb-mini-meta" onClick={() => setExpanded(true)}>
        <strong>{current.title}</strong>
        <span>{current.artist}</span>
      </div>
      <div className="nb-mini-controls">
        <button type="button" onClick={prev} aria-label="Previous">
          <SkipBack size={18} />
        </button>
        <button type="button" className="nb-play" onClick={toggle} aria-label="Play pause">
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button type="button" onClick={next} aria-label="Next">
          <SkipForward size={18} />
        </button>
        <button type="button" onClick={likeCurrent} aria-label="Like">
          <Heart size={18} />
        </button>
      </div>
      <div className="nb-mini-seek">
        <span>{fmt(positionMs)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(durationMs, 1)}
          value={positionMs}
          onChange={(e) => seek(Number(e.target.value))}
          style={{ "--pct": `${pct}%` } as React.CSSProperties}
        />
        <span>{fmt(durationMs)}</span>
      </div>
    </div>
  );
}
