import { useEffect, useRef, useState } from "react";
import { forgetCover, getCoverSrc, peekCoverSrc } from "../lib/coverCache";
import { hueFromKey } from "../lib/libraryHelpers";
import type { TrackMeta } from "../lib/types";

export function CoverArt({
  track,
  className = "nb-cover",
  size,
  eager = false,
}: {
  track: Pick<TrackMeta, "id" | "title" | "artist" | "coverUrl" | "path" | "album">;
  className?: string;
  size?: number;
  /** Skip intersection lazy-load (player bar / now playing). */
  eager?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager);
  const [src, setSrc] = useState<string | null>(() => peekCoverSrc(track));
  const retries = useRef(0);
  const hue = hueFromKey(`${track.artist}|${track.title}`);
  const letter = (track.title || track.artist || "?")
    .trim()
    .charAt(0)
    .toUpperCase();

  useEffect(() => {
    if (eager || visible) return;
    const el = rootRef.current;
    // display:contents has no box — observe parent so lazy-load still fires.
    const target = el?.parentElement ?? el;
    if (!target || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "160px 0px", threshold: 0.01 },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [eager, visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    retries.current = 0;
    const cached = peekCoverSrc(track);
    setSrc(cached);
    getCoverSrc(track).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, track.id, track.coverUrl, track.path, track.title, track.artist]);

  const style = size
    ? ({ width: size, height: size } as React.CSSProperties)
    : ({ width: "100%", height: "100%" } as React.CSSProperties);

  return (
    <div
      ref={rootRef}
      className={`${className}-wrap`}
      style={{
        ...style,
        display: "block",
        flexShrink: 0,
        lineHeight: 0,
      }}
    >
      {src ? (
        <img
          className={className}
          src={src}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
          loading="lazy"
          decoding="async"
          onError={() => {
            forgetCover(track);
            setSrc(null);
            if (retries.current >= 1) return;
            retries.current += 1;
            getCoverSrc(track).then((url) => {
              if (url) setSrc(url);
            });
          }}
        />
      ) : (
        <div
          className={`${className} nb-cover-fallback`}
          style={{
            width: "100%",
            height: "100%",
            background: `linear-gradient(145deg, hsl(${hue} 42% 62%), hsl(${(hue + 40) % 360} 38% 42%))`,
          }}
          aria-hidden
        >
          <span className="nb-cover-letter">{letter}</span>
        </div>
      )}
    </div>
  );
}
