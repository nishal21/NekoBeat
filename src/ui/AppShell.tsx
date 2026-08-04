import { NavLink, Outlet } from "react-router-dom";
import {
  Download,
  Heart,
  Home,
  Library,
  Puzzle,
  Search,
  Settings,
} from "lucide-react";
import { MiniPlayer } from "../player/MiniPlayer";
import { ExpandedPlayer } from "../player/ExpandedPlayer";
import { usePlayer } from "../player/PlayerContext";
import "./shell.css";

const tabs = [
  { to: "/", label: "Listen", icon: Home },
  { to: "/browse", label: "Browse", icon: Search },
  { to: "/library", label: "Library", icon: Library },
  { to: "/liked", label: "Liked", icon: Heart },
  { to: "/hifi", label: "HiFi", icon: Download },
  { to: "/extensions", label: "Extensions", icon: Puzzle },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppShell() {
  const { expanded } = usePlayer();
  return (
    <div className="nb-shell">
      <aside className="nb-sidebar">
        <div className="nb-brand">
          <span className="nb-brand-mark">N</span>
          <div>
            <strong>NekoBeat</strong>
            <p>Listen · Library · HiFi</p>
          </div>
        </div>
        <nav className="nb-nav">
          {tabs.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
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
        {tabs.slice(0, 5).map(({ to, label, icon: Icon }) => (
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
      {expanded ? <ExpandedPlayer /> : null}
    </div>
  );
}
