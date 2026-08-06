import { NavLink, Outlet } from "react-router-dom";
import {
  Compass,
  Download,
  Heart,
  Library,
  Puzzle,
  Search,
  Settings,
} from "lucide-react";
import { useState } from "react";
import { MiniPlayer } from "../player/MiniPlayer";
import { ExpandedPlayer } from "../player/ExpandedPlayer";
import { NowPlayingShell } from "../player/npMotion";
import { usePlayer } from "../player/PlayerContext";
import {
  CommandPalette,
  useCommandPaletteHotkey,
} from "./CommandPalette";
import "./shell.css";

const desktopTabs = [
  { to: "/", label: "Library", icon: Library },
  { to: "/explore", label: "Explore", icon: Compass },
  { to: "/browse", label: "Browse", icon: Search },
  { to: "/liked", label: "Liked", icon: Heart },
  { to: "/hifi", label: "HiFi", icon: Download },
  { to: "/extensions", label: "Extensions", icon: Puzzle },
  { to: "/settings", label: "Settings", icon: Settings },
];

const mobileTabs = [
  { to: "/", label: "Library", icon: Library },
  { to: "/explore", label: "Explore", icon: Compass },
  { to: "/browse", label: "Browse", icon: Search },
  { to: "/liked", label: "Liked", icon: Heart },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppShell() {
  const { expanded, coverSrc, playing } = usePlayer();
  const [cmdk, setCmdk] = useState(false);
  useCommandPaletteHotkey(setCmdk);

  const ambient =
    coverSrc &&
    (coverSrc.startsWith("http") ||
      coverSrc.startsWith("data:") ||
      coverSrc.startsWith("asset:") ||
      coverSrc.includes("asset.localhost"))
      ? { backgroundImage: `url("${coverSrc.replace(/"/g, "")}")` }
      : undefined;

  return (
    <div className={`nb-shell${playing ? " is-playing" : ""}`}>
      <div className="nb-shell-ambient" style={ambient} aria-hidden />
      <aside className="nb-sidebar">
        <div className="nb-brand">
          <span className="nb-brand-mark">N</span>
          <div className="nb-brand-text">
            <strong>NekoBeat</strong>
            <p>any source · one beat</p>
          </div>
        </div>
        <button
          type="button"
          className="nb-cmdk-trigger"
          onClick={() => setCmdk(true)}
        >
          <Search size={15} />
          <span>Search</span>
          <kbd>Ctrl K</kbd>
        </button>
        <nav className="nb-nav" aria-label="Primary">
          {desktopTabs.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              title={label}
              className={({ isActive }) =>
                `nb-nav-link${isActive ? " is-active" : ""}`
              }
            >
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="nb-main">
        <Outlet />
      </main>

      <nav className="nb-bottom-tabs" aria-label="Primary">
        {mobileTabs.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              `nb-tab${isActive ? " is-active" : ""}`
            }
          >
            <Icon size={20} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      <MiniPlayer />
      <NowPlayingShell open={expanded}>
        <ExpandedPlayer />
      </NowPlayingShell>
      <CommandPalette open={cmdk} onClose={() => setCmdk(false)} />
    </div>
  );
}
