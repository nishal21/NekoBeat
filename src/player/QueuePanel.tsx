import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  ListMusic,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CoverArt } from "../ui/CoverArt";
import { usePlayer } from "./PlayerContext";

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export function QueuePanel({
  open,
  onClose,
  embedded = false,
}: {
  open: boolean;
  onClose: () => void;
  /** Docked in expanded player side rail */
  embedded?: boolean;
}) {
  const { queue, index, jumpTo, removeAt, moveQueueItem, current, playing } =
    usePlayer();
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const activeRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (!open) return;
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [open, index]);

  if (!open) return null;

  const upcoming = queue.slice(index + 1);
  const earlier = queue.slice(0, index);

  const renderRow = (t: (typeof queue)[0], i: number, label?: string) => (
    <li
      key={t.queueKey}
      ref={i === index ? activeRef : undefined}
      className={`nb-queue-item${i === index ? " is-active" : ""}${
        dragFrom === i ? " is-dragging" : ""
      }`}
      draggable
      onDragStart={(e) => {
        setDragFrom(i);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(i));
      }}
      onDragEnd={() => setDragFrom(null)}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData("text/plain"));
        if (!Number.isNaN(from)) moveQueueItem(from, i);
        setDragFrom(null);
      }}
    >
      <span className="nb-queue-grip" aria-hidden title="Drag to reorder">
        <GripVertical size={16} />
      </span>
      <button
        type="button"
        className="nb-queue-row"
        onClick={() => void jumpTo(i)}
      >
        <CoverArt track={t} className="nb-queue-cover" size={48} />
        <span className="nb-queue-meta">
          {label ? <span className="nb-queue-badge">{label}</span> : null}
          <strong>{t.title}</strong>
          <em>{t.artist}</em>
        </span>
        <span className="nb-queue-dur">{fmt(t.durationMs || 0)}</span>
      </button>
      {!embedded ? (
        <div className="nb-queue-move">
          <button
            type="button"
            className="nb-queue-move-btn"
            aria-label="Move up"
            disabled={i === 0}
            onClick={() => moveQueueItem(i, i - 1)}
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            className="nb-queue-move-btn"
            aria-label="Move down"
            disabled={i >= queue.length - 1}
            onClick={() => moveQueueItem(i, i + 1)}
          >
            <ChevronDown size={14} />
          </button>
        </div>
      ) : null}
      <button
        type="button"
        className="nb-queue-rm"
        aria-label="Remove from queue"
        onClick={() => removeAt(i)}
      >
        <X size={14} />
      </button>
    </li>
  );

  return (
    <aside
      className={`nb-queue${embedded ? " is-embedded" : ""}`}
      aria-label="Play queue"
    >
      <header className="nb-queue-head">
        <div>
          <ListMusic size={18} />
          <strong>Queue</strong>
          <span>
            {index + 1}/{queue.length || 0}
            {playing ? " · playing" : ""}
          </span>
        </div>
        <button
          type="button"
          className="nb-np-icon-btn"
          onClick={onClose}
          aria-label="Close queue"
        >
          <X size={18} />
        </button>
      </header>

      <div className="nb-queue-scroll">
        {current && queue[index] ? (
          <section className="nb-queue-section">
            <h3>Now playing</h3>
            <ul className="nb-queue-list">{renderRow(queue[index], index, "Now")}</ul>
          </section>
        ) : null}

        {upcoming.length ? (
          <section className="nb-queue-section">
            <h3>Next up · {upcoming.length}</h3>
            <ul className="nb-queue-list">
              {upcoming.map((t, j) => renderRow(t, index + 1 + j))}
            </ul>
          </section>
        ) : (
          <p className="nb-queue-empty-hint">
            Nothing next — enable Radio or add tracks from Browse.
          </p>
        )}

        {earlier.length ? (
          <section className="nb-queue-section is-muted">
            <h3>Earlier</h3>
            <ul className="nb-queue-list">
              {earlier.map((t, i) => renderRow(t, i))}
            </ul>
          </section>
        ) : null}

        {!queue.length ? (
          <p className="nb-queue-empty-hint">Queue is empty</p>
        ) : null}
      </div>
    </aside>
  );
}
