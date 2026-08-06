import {
  ChevronUp,
  Heart,
  ListMusic,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMediaQuery } from "../lib/useMediaQuery";
import { CoverArt } from "../ui/CoverArt";
import { usePlayer } from "./PlayerContext";
import { QueuePanel } from "./QueuePanel";
import { TappableArtists } from "./TappableArtists";
import "./player.css";

function fmt(ms: number) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function VolumeIcon({ v }: { v: number }) {
  if (v <= 0.001) return <VolumeX size={18} />;
  if (v < 0.45) return <Volume1 size={18} />;
  return <Volume2 size={18} />;
}

/** Frosted floating bar — Monochrome center seek + Koel glass + design.md density. */
export function MiniPlayer() {
  const navigate = useNavigate();
  const isPhone = useMediaQuery("(max-width: 900px)");
  const {
    current,
    playing,
    positionMs,
    durationMs,
    volume,
    shuffle,
    repeat,
    liked,
    toggle,
    next,
    prev,
    seek,
    setVolume,
    likeCurrent,
    setExpanded,
    toggleShuffle,
    cycleRepeat,
  } = usePlayer();

  const [queueOpen, setQueueOpen] = useState(false);
  const [volBeforeMute, setVolBeforeMute] = useState(0.85);
  const idle = !current;
  const dur = Math.max(
    durationMs >= 1000 ? durationMs : 0,
    current?.durationMs || 0,
    0,
  );
  const pct = dur > 0 ? Math.min(100, (positionMs / dur) * 100) : 0;
  const RepeatIcon = repeat === "one" ? Repeat1 : Repeat;

  const goArtist = (name: string) => {
    navigate(`/artist?name=${encodeURIComponent(name)}`);
  };

  const toggleMute = () => {
    if (volume > 0.001) {
      setVolBeforeMute(volume);
      void setVolume(0);
    } else {
      void setVolume(volBeforeMute || 0.85);
    }
  };

  const seekInput = (
    <div className="nb-bar-seek-rail">
      <div className="nb-bar-seek-track" aria-hidden>
        <div className="nb-bar-seek-fill" style={{ width: `${pct}%` }} />
      </div>
      {!idle ? (
        <input
          type="range"
          min={0}
          max={Math.max(dur, 1)}
          step={250}
          value={Math.min(positionMs, Math.max(dur, 1))}
          onChange={(e) => void seek(Number(e.target.value))}
          aria-label="Seek"
        />
      ) : null}
    </div>
  );

  return (
    <>
      <div
        className={`nb-bar${idle ? " is-idle" : ""}${playing ? " is-playing" : ""}`}
      >
        {/* Left: cover + meta */}
        <div className="nb-bar-left">
          <button
            type="button"
            className="nb-bar-cover"
            onClick={() => current && setExpanded(true)}
            aria-label={current ? "Open now playing" : "No track"}
            disabled={idle}
          >
            {current ? (
              <CoverArt
                track={current}
                className="nb-bar-cover-img"
                size={isPhone ? 48 : 56}
                eager
              />
            ) : (
              <div className="nb-cover-fallback nb-bar-cover-ph" />
            )}
            <span className="nb-bar-cover-hint" aria-hidden>
              <ChevronUp size={18} />
            </span>
          </button>

          <div className="nb-bar-meta">
            <div className="nb-bar-title-row">
              <button
                type="button"
                className="nb-bar-title"
                disabled={idle}
                onClick={() => current && setExpanded(true)}
              >
                {current?.title ?? "Nothing playing"}
              </button>
              {current?.qualityLabel ? (
                <em className="nb-bar-format">{current.qualityLabel}</em>
              ) : null}
            </div>
            {current ? (
              <TappableArtists
                artist={current.artist || "Unknown"}
                className="nb-bar-artists"
                onArtist={goArtist}
              />
            ) : (
              <span className="nb-bar-idle-hint">Add music from Library</span>
            )}
          </div>

          {!isPhone ? (
            <button
              type="button"
              className={`nb-bar-icon${liked ? " is-on" : ""}`}
              onClick={() => void likeCurrent()}
              aria-label={liked ? "Unlike" : "Like"}
              aria-pressed={liked}
              disabled={idle}
            >
              <Heart size={18} fill={liked ? "currentColor" : "none"} />
            </button>
          ) : null}
        </div>

        {/* Center: transport + seek (desktop) */}
        <div className="nb-bar-center">
          <div className="nb-bar-controls">
            <button
              type="button"
              className={`nb-bar-icon nb-bar-desk${shuffle ? " is-on" : ""}`}
              onClick={toggleShuffle}
              aria-label="Shuffle"
              aria-pressed={shuffle}
              disabled={idle}
            >
              <Shuffle size={16} />
            </button>
            <button
              type="button"
              className="nb-bar-icon nb-bar-desk"
              onClick={() => void prev()}
              aria-label="Previous"
              disabled={idle}
            >
              <SkipBack size={18} fill="currentColor" />
            </button>
            <button
              type="button"
              className="nb-bar-play"
              onClick={() => void toggle()}
              aria-label={playing ? "Pause" : "Play"}
              disabled={idle}
            >
              {playing ? (
                <Pause size={22} fill="currentColor" />
              ) : (
                <Play size={22} fill="currentColor" />
              )}
            </button>
            <button
              type="button"
              className="nb-bar-icon"
              onClick={() => void next()}
              aria-label="Next"
              disabled={idle}
            >
              <SkipForward size={18} fill="currentColor" />
            </button>
            <button
              type="button"
              className={`nb-bar-icon nb-bar-desk${repeat !== "off" ? " is-on" : ""}`}
              onClick={cycleRepeat}
              aria-label={`Repeat ${repeat}`}
              aria-pressed={repeat !== "off"}
              disabled={idle}
            >
              <RepeatIcon size={16} />
            </button>
          </div>

          <div className="nb-bar-progress">
            <span className="nb-bar-time">{fmt(positionMs)}</span>
            {seekInput}
            <span className="nb-bar-time">{fmt(dur)}</span>
          </div>
        </div>

        {/* Right: volume + queue + expand */}
        <div className="nb-bar-right">
          <div className="nb-bar-vol">
            <button
              type="button"
              className="nb-bar-icon"
              onClick={toggleMute}
              aria-label={volume > 0.001 ? "Mute" : "Unmute"}
              disabled={idle}
            >
              <VolumeIcon v={volume} />
            </button>
            <div className="nb-bar-vol-rail">
              <div className="nb-bar-vol-track" aria-hidden>
                <div
                  className="nb-bar-vol-fill"
                  style={{ width: `${Math.round(volume * 100)}%` }}
                />
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(volume * 100)}
                onChange={(e) => void setVolume(Number(e.target.value) / 100)}
                aria-label="Volume"
                disabled={idle}
              />
            </div>
          </div>

          {isPhone ? (
            <button
              type="button"
              className={`nb-bar-icon${liked ? " is-on" : ""}`}
              onClick={() => void likeCurrent()}
              aria-label={liked ? "Unlike" : "Like"}
              aria-pressed={liked}
              disabled={idle}
            >
              <Heart size={18} fill={liked ? "currentColor" : "none"} />
            </button>
          ) : null}

          <button
            type="button"
            className={`nb-bar-icon${queueOpen ? " is-on" : ""}`}
            onClick={() => setQueueOpen((v) => !v)}
            aria-label="Queue"
            disabled={idle}
          >
            <ListMusic size={18} />
          </button>
          <button
            type="button"
            className="nb-bar-icon nb-bar-expand"
            onClick={() => current && setExpanded(true)}
            aria-label="Expand now playing"
            disabled={idle}
          >
            <ChevronUp size={18} />
          </button>
        </div>
      </div>

      {queueOpen && !idle ? (
        <div className="nb-queue-float">
          <QueuePanel open={queueOpen} onClose={() => setQueueOpen(false)} />
        </div>
      ) : null}
    </>
  );
}
