import {
  Download,
  Heart,
  Library,
  Loader2,
  Puzzle,
  Search,
  Settings,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import {
  clearSearchHistory,
  getSearchHistory,
  pushSearchHistory,
} from "../lib/searchHistory";
import type { TrackMeta } from "../lib/types";
import { usePlayer } from "../player/PlayerContext";
import { CoverArt } from "./CoverArt";
import "./cmdk.css";

type Cmd = {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
};

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { playTrack, toggle, next, prev, setExpanded, current } = usePlayer();
  const [q, setQ] = useState("");
  const [music, setMusic] = useState<TrackMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);

  const commands = useMemo<Cmd[]>(
    () => [
      {
        id: "nav-library",
        label: "Library",
        group: "Go to",
        run: () => navigate("/"),
      },
      {
        id: "nav-browse",
        label: "Browse",
        group: "Go to",
        run: () => navigate("/browse"),
      },
      {
        id: "nav-explore",
        label: "Explore",
        group: "Go to",
        run: () => navigate("/explore"),
      },
      {
        id: "nav-hifi",
        label: "HiFi",
        group: "Go to",
        run: () => navigate("/hifi"),
      },
      {
        id: "nav-liked",
        label: "Liked",
        group: "Go to",
        run: () => navigate("/liked"),
      },
      {
        id: "nav-ext",
        label: "Extensions",
        group: "Go to",
        run: () => navigate("/extensions"),
      },
      {
        id: "nav-settings",
        label: "Settings",
        group: "Go to",
        run: () => navigate("/settings"),
      },
      {
        id: "play-toggle",
        label: current ? (current.title ? `Play/Pause · ${current.title}` : "Play/Pause") : "Play/Pause",
        group: "Playback",
        run: () => void toggle(),
      },
      {
        id: "play-next",
        label: "Next track",
        group: "Playback",
        run: () => void next(),
      },
      {
        id: "play-prev",
        label: "Previous track",
        group: "Playback",
        run: () => void prev(),
      },
      {
        id: "play-expand",
        label: "Now playing",
        group: "Playback",
        run: () => setExpanded(true),
      },
    ],
    [navigate, toggle, next, prev, setExpanded, current],
  );

  const filteredCmds = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(term) ||
        c.group.toLowerCase().includes(term),
    );
  }, [commands, q]);

  const history = useMemo(() => (q.trim() ? [] : getSearchHistory()), [q, open]);

  type Row =
    | { kind: "cmd"; cmd: Cmd }
    | { kind: "hist"; term: string }
    | { kind: "track"; track: TrackMeta };

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const term of history) out.push({ kind: "hist", term });
    for (const cmd of filteredCmds) out.push({ kind: "cmd", cmd });
    for (const track of music) out.push({ kind: "track", track });
    return out;
  }, [history, filteredCmds, music]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setMusic([]);
    setSel(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 40);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) {
      setMusic([]);
      setBusy(false);
      return;
    }
    const id = ++reqId.current;
    setBusy(true);
    const timer = window.setTimeout(() => {
      void api
        .searchStream(term)
        .then((rows) => {
          if (id !== reqId.current) return;
          setMusic(rows.slice(0, 8));
        })
        .catch(() => {
          if (id !== reqId.current) return;
          setMusic([]);
        })
        .finally(() => {
          if (id === reqId.current) setBusy(false);
        });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [q, open]);

  useEffect(() => {
    setSel(0);
  }, [q, music.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((i) => Math.min(i + 1, Math.max(0, rows.length - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const row = rows[sel];
        if (!row) {
          const term = q.trim();
          if (term) {
            pushSearchHistory(term);
            navigate(`/browse?q=${encodeURIComponent(term)}`);
            onClose();
          }
          return;
        }
        runRow(row);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, rows, sel, q, navigate, onClose]);

  const runRow = (row: Row) => {
    if (row.kind === "cmd") {
      row.cmd.run();
      onClose();
      return;
    }
    if (row.kind === "hist") {
      pushSearchHistory(row.term);
      navigate(`/browse?q=${encodeURIComponent(row.term)}`);
      onClose();
      return;
    }
    pushSearchHistory(row.track.title);
    void playTrack(row.track, music.length ? music : [row.track]);
    onClose();
  };

  if (!open) return null;

  const iconFor = (id: string) => {
    if (id.includes("library")) return <Library size={16} />;
    if (id.includes("browse") || id.includes("search")) return <Search size={16} />;
    if (id.includes("hifi")) return <Download size={16} />;
    if (id.includes("liked")) return <Heart size={16} />;
    if (id.includes("ext")) return <Puzzle size={16} />;
    if (id.includes("settings")) return <Settings size={16} />;
    return <Search size={16} />;
  };

  return (
    <div className="nb-cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
      <button type="button" className="nb-cmdk-scrim" aria-label="Close" onClick={onClose} />
      <div className="nb-cmdk-panel">
        <div className="nb-cmdk-input-row">
          {busy ? <Loader2 size={18} className="nb-spin" /> : <Search size={18} />}
          <input
            ref={inputRef}
            className="nb-cmdk-input"
            placeholder="Search songs or jump somewhere…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Command"
          />
          <kbd className="nb-cmdk-kbd">Esc</kbd>
          <button type="button" className="nb-cmdk-x" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <ul className="nb-cmdk-list" role="listbox">
          {!rows.length ? (
            <li className="nb-cmdk-empty">
              {q.trim().length >= 2 && busy
                ? "Searching…"
                : q.trim()
                  ? "No matches — Enter to open Browse"
                  : "Type to search music or pick a command"}
            </li>
          ) : (
            rows.map((row, i) => {
              const active = i === sel;
              if (row.kind === "hist") {
                return (
                  <li key={`h-${row.term}`}>
                    <button
                      type="button"
                      className={`nb-cmdk-row${active ? " is-on" : ""}`}
                      onMouseEnter={() => setSel(i)}
                      onClick={() => runRow(row)}
                    >
                      <Search size={16} />
                      <span>
                        <strong>{row.term}</strong>
                        <em>Recent</em>
                      </span>
                    </button>
                  </li>
                );
              }
              if (row.kind === "cmd") {
                return (
                  <li key={row.cmd.id}>
                    <button
                      type="button"
                      className={`nb-cmdk-row${active ? " is-on" : ""}`}
                      onMouseEnter={() => setSel(i)}
                      onClick={() => runRow(row)}
                    >
                      {iconFor(row.cmd.id)}
                      <span>
                        <strong>{row.cmd.label}</strong>
                        <em>{row.cmd.group}</em>
                      </span>
                    </button>
                  </li>
                );
              }
              return (
                <li key={row.track.id}>
                  <button
                    type="button"
                    className={`nb-cmdk-row is-track${active ? " is-on" : ""}`}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => runRow(row)}
                  >
                    <CoverArt track={row.track} size={36} className="nb-cmdk-cover" />
                    <span>
                      <strong>{row.track.title}</strong>
                      <em>{row.track.artist}</em>
                    </span>
                    <span className="nb-cmdk-play">Play</span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
        {history.length ? (
          <div className="nb-cmdk-foot">
            <button
              type="button"
              className="nb-tap-link"
              onClick={() => {
                clearSearchHistory();
                setQ((x) => x + "");
              }}
            >
              Clear search history
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function useCommandPaletteHotkey(setOpen: (v: boolean) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);
}
