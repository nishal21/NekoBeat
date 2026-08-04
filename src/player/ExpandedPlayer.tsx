import { useEffect, useMemo, useRef } from "react";
import { ChevronDown, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { usePlayer } from "./PlayerContext";

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

/** Harmonoid + YesPlayMusic style immersive lyric stage */
export function ExpandedPlayer() {
  const {
    current,
    playing,
    positionMs,
    durationMs,
    coverSrc,
    lyrics,
    toggle,
    next,
    prev,
    seek,
    setExpanded,
  } = usePlayer();

  const listRef = useRef<HTMLDivElement>(null);

  const activeIdx = useMemo(() => {
    if (!lyrics.length) return -1;
    let i = 0;
    for (let n = 0; n < lyrics.length; n++) {
      if (lyrics[n].timeMs <= positionMs) i = n;
    }
    return i;
  }, [lyrics, positionMs]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-lyric-idx="${activeIdx}"]`,
    );
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIdx]);

  if (!current) return null;

  return (
    <div className="nb-expanded">
      <div
        className="nb-expanded-bg"
        style={coverSrc ? { backgroundImage: `url(${coverSrc})` } : undefined}
      />
      <div className="nb-lyrics-orbs" aria-hidden>
        <div
          className="orb top-right"
          style={coverSrc ? { backgroundImage: `url(${coverSrc})` } : undefined}
        />
        <div
          className="orb bottom-left"
          style={coverSrc ? { backgroundImage: `url(${coverSrc})` } : undefined}
        />
      </div>

      <button
        type="button"
        className="nb-expanded-close"
        onClick={() => setExpanded(false)}
        aria-label="Close"
      >
        <ChevronDown size={24} />
      </button>

      <div className="nb-expanded-body lyrics-stage">
        <div className="nb-stage-left">
          <div className={`nb-expanded-art ${playing ? "is-spinning" : ""}`}>
            {coverSrc ? (
              <img src={coverSrc} alt="" />
            ) : (
              <div className="nb-cover-fallback lg" />
            )}
            <div
              className="nb-art-shadow"
              style={
                coverSrc ? { backgroundImage: `url(${coverSrc})` } : undefined
              }
            />
          </div>
          <div className="nb-expanded-meta">
            <h2>{current.title}</h2>
            <p>{current.artist}</p>
            {current.album ? <p className="muted">{current.album}</p> : null}
            {current.qualityLabel ? (
              <span className="nb-quality-badge">{current.qualityLabel}</span>
            ) : null}
          </div>
          <div className="nb-expanded-transport">
            <input
              type="range"
              min={0}
              max={Math.max(durationMs, 1)}
              value={positionMs}
              onChange={(e) => seek(Number(e.target.value))}
            />
            <div className="nb-time">
              <span>{fmt(positionMs)}</span>
              <span>{fmt(durationMs)}</span>
            </div>
            <div className="nb-mini-controls big">
              <button type="button" onClick={prev} aria-label="Previous">
                <SkipBack size={22} />
              </button>
              <button
                type="button"
                className="nb-play"
                onClick={toggle}
                aria-label="Play pause"
              >
                {playing ? <Pause size={22} /> : <Play size={22} />}
              </button>
              <button type="button" onClick={next} aria-label="Next">
                <SkipForward size={22} />
              </button>
            </div>
          </div>
        </div>

        <div className="nb-stage-right">
          <div className="nb-lyrics-stage" ref={listRef}>
            {lyrics.length ? (
              lyrics.map((l, i) => {
                const dist = Math.abs(i - activeIdx);
                return (
                  <p
                    key={`${l.timeMs}-${i}`}
                    data-lyric-idx={i}
                    className={
                      i === activeIdx
                        ? "is-active"
                        : dist === 1
                          ? "is-near"
                          : ""
                    }
                    onClick={() => seek(l.timeMs)}
                  >
                    {l.text}
                  </p>
                );
              })
            ) : (
              <p className="muted nb-no-lyric">No lyrics yet — still sounds good.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
