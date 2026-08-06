import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  ChevronDown,
  Loader2,
  LogIn,
  LogOut,
  Puzzle,
  RefreshCw,
  Download,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { hueFromKey } from "../lib/libraryHelpers";
import type { ExtensionEntry, ExtensionSettingField } from "../lib/types";
import { DEFAULT_SETTINGS } from "../lib/types";
import { usePlayer } from "../player/PlayerContext";
import "./extensions.css";

const DEFAULT_REGISTRY = DEFAULT_SETTINGS.extensionRegistryUrl;

function extLetter(e: ExtensionEntry) {
  return (e.displayName || e.name || e.id || "?")
    .replace(/^The\s+/i, "")
    .trim()
    .charAt(0)
    .toUpperCase();
}

function shortDesc(text: string, max = 110) {
  const t = (text || "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trim()}…`;
}

export function ExtensionsPage() {
  const { settings, setSettings } = usePlayer();
  const [items, setItems] = useState<ExtensionEntry[]>([]);
  const [registry, setRegistry] = useState(
    settings.extensionRegistryUrl || DEFAULT_REGISTRY,
  );
  const [msg, setMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [fields, setFields] = useState<ExtensionSettingField[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [authCode, setAuthCode] = useState("");

  const load = async () => {
    try {
      const rows = await api.extensionsList();
      setItems(rows);
      return rows;
    } catch {
      setItems([]);
      return [] as ExtensionEntry[];
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        let rows = await load();
        if (!cancelled && rows.length === 0) {
          const url =
            settings.extensionRegistryUrl || DEFAULT_REGISTRY;
          await api.extensionsSetRegistry(url);
          rows = await api.extensionsRefresh();
          if (!cancelled) setItems(rows);
        }
      } catch {
        if (!cancelled) setMsg("Could not load registry — try Refresh.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installedCount = useMemo(
    () => items.filter((e) => e.installed).length,
    [items],
  );

  const openLogin = async (id: string) => {
    setActiveId(id);
    const f = await api.extensionsGetSettings(id);
    setFields(f);
    const init: Record<string, string> = {};
    for (const field of f) {
      if (field.value != null) init[field.key] = String(field.value);
    }
    setForm(init);
    setAuthCode("");
    requestAnimationFrame(() => {
      document.getElementById("nb-ext-account")?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    });
  };

  const saveCreds = async () => {
    if (!activeId) return;
    await api.extensionsSetSettings(activeId, form);
    setMsg("Credentials saved");
  };

  const connectOauth = async () => {
    if (!activeId) return;
    const pending = await api.extensionsStartLogin(activeId);
    try {
      await openUrl(pending.authUrl);
    } catch {
      window.open(pending.authUrl, "_blank");
    }
    setMsg(
      pending.hint || "Complete login in browser, then paste the code below.",
    );
  };

  const finishLogin = async () => {
    if (!activeId) return;
    await api.extensionsSetSettings(activeId, form);
    await api.extensionsCompleteLogin(activeId, authCode || undefined);
    setMsg("Logged in — downloads can use this provider");
    await load();
  };

  const install = async (e: ExtensionEntry) => {
    setBusyId(e.id);
    setMsg(null);
    try {
      await api.extensionsInstall(e.id);
      await load();
      setMsg(
        e.installed
          ? `Reinstalled ${e.displayName || e.name}`
          : `Installed ${e.displayName || e.name}`,
      );
    } catch (err) {
      setMsg(String(err).replace(/^Error:\s*/, "") || "Install failed");
    } finally {
      setBusyId(null);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    setMsg(null);
    try {
      const url = registry.trim() || DEFAULT_REGISTRY;
      await api.extensionsSetRegistry(url);
      setSettings({ ...settings, extensionRegistryUrl: url });
      const rows = await api.extensionsRefresh();
      setItems(rows);
      setMsg(`Catalog updated · ${rows.length} providers`);
    } catch (err) {
      setMsg(String(err).replace(/^Error:\s*/, "") || "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  const activeName =
    items.find((x) => x.id === activeId)?.displayName ||
    items.find((x) => x.id === activeId)?.name ||
    activeId;

  return (
    <section className="nb-ext">
      <header className="nb-ext-bar">
        <div>
          <p className="nb-ext-kicker">
            <Puzzle size={14} /> SpotiFLAC registry
          </p>
          <h1 className="nb-page-title">Extensions</h1>
          <p className="nb-page-sub">
            Install providers for HiFi search &amp; download. Registry is already
            set — tap Install.
          </p>
        </div>
        <button
          type="button"
          className="nb-btn ghost nb-ext-refresh"
          onClick={() => void refresh()}
          disabled={refreshing || loading}
        >
          {refreshing ? (
            <Loader2 size={16} className="nb-spin" />
          ) : (
            <RefreshCw size={16} />
          )}
          Refresh
        </button>
      </header>

      <div className="nb-ext-stats">
        <span>
          {loading
            ? "Loading catalog…"
            : `${items.length} in catalog · ${installedCount} installed`}
        </span>
        <span className="nb-ext-stats-muted" title={registry}>
          Default registry
        </span>
      </div>

      {msg ? <p className="nb-ext-msg">{msg}</p> : null}

      {loading ? (
        <div className="nb-ext-loading" aria-busy="true">
          <Loader2 size={28} className="nb-spin" />
          <span>Fetching providers…</span>
        </div>
      ) : items.length ? (
        <div className="nb-ext-grid">
          {items.map((e) => {
            const hue = hueFromKey(e.id || e.name);
            const busy = busyId === e.id;
            return (
              <article
                key={e.id}
                className={`nb-ext-card${e.installed ? " is-installed" : ""}`}
              >
                <div
                  className="nb-ext-icon"
                  style={{
                    background: `linear-gradient(145deg, hsl(${hue} 42% 42%), hsl(${(hue + 28) % 360} 38% 28%))`,
                  }}
                  aria-hidden
                >
                  {extLetter(e)}
                </div>
                <div className="nb-ext-body">
                  <div className="nb-ext-title-row">
                    <strong>{e.displayName || e.name}</strong>
                    <span className="nb-ext-ver">{e.version}</span>
                  </div>
                  <div className="nb-ext-badges">
                    {e.installed ? (
                      <span className="nb-quality-badge tone-ok">
                        <Check size={11} /> Installed
                      </span>
                    ) : (
                      <span className="nb-quality-badge">Not installed</span>
                    )}
                    {e.loggedIn ? (
                      <span className="nb-quality-badge tone-ok">Logged in</span>
                    ) : e.needsAuth ? (
                      <span className="nb-quality-badge tone-stream">
                        Account optional
                      </span>
                    ) : null}
                    {e.category ? (
                      <span className="nb-ext-cat">{e.category}</span>
                    ) : null}
                  </div>
                  <p className="nb-ext-desc">{shortDesc(e.description)}</p>
                </div>
                <div className="nb-ext-actions">
                  <button
                    type="button"
                    className="nb-btn nb-ext-install"
                    disabled={busy}
                    onClick={() => void install(e)}
                  >
                    {busy ? (
                      <Loader2 size={15} className="nb-spin" />
                    ) : (
                      <Download size={15} />
                    )}
                    {e.installed ? "Reinstall" : "Install"}
                  </button>
                  {e.needsAuth ? (
                    <button
                      type="button"
                      className="nb-btn ghost"
                      onClick={() => void openLogin(e.id)}
                    >
                      <LogIn size={14} />
                      {e.loggedIn ? "Account" : "Sign in"}
                    </button>
                  ) : null}
                  {e.loggedIn ? (
                    <button
                      type="button"
                      className="nb-btn ghost"
                      onClick={async () => {
                        await api.extensionsLogout(e.id);
                        await load();
                      }}
                    >
                      <LogOut size={14} />
                      Logout
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="nb-ext-empty">
          <Puzzle size={28} strokeWidth={1.5} />
          <strong>No catalog yet</strong>
          <span>Refresh to load the default SpotiFLAC registry.</span>
          <button
            type="button"
            className="nb-btn"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            {refreshing ? <Loader2 size={16} className="nb-spin" /> : null}
            Load registry
          </button>
        </div>
      )}

      {activeId ? (
        <div id="nb-ext-account" className="nb-login-panel nb-ext-account">
          <h2>Account · {activeName}</h2>
          <p className="nb-page-sub">
            Optional — only if this provider needs it for downloads.
          </p>
          {fields
            .filter((f) => f.type !== "button")
            .map((f) => (
              <label key={f.key} className="nb-ext-field">
                <span>{f.label}</span>
                <input
                  className="nb-input"
                  type={f.type === "secret" || f.secret ? "password" : "text"}
                  value={form[f.key] ?? ""}
                  onChange={(ev) =>
                    setForm({ ...form, [f.key]: ev.target.value })
                  }
                />
              </label>
            ))}
          <div className="nb-ext-account-actions">
            <button type="button" className="nb-btn ghost" onClick={saveCreds}>
              Save credentials
            </button>
            {fields.some((f) => f.type === "button" || f.oauthLoginUrl) ? (
              <button type="button" className="nb-btn" onClick={connectOauth}>
                Connect / Open browser
              </button>
            ) : null}
          </div>
          <label className="nb-ext-field">
            <span>OAuth callback / grant code</span>
            <input
              className="nb-input"
              value={authCode}
              onChange={(ev) => setAuthCode(ev.target.value)}
              placeholder="Paste after browser login (optional)"
            />
          </label>
          <button type="button" className="nb-btn" onClick={finishLogin}>
            Complete login
          </button>
        </div>
      ) : null}

      <details
        className="nb-ext-advanced"
        open={showAdvanced}
        onToggle={(ev) =>
          setShowAdvanced((ev.target as HTMLDetailsElement).open)
        }
      >
        <summary>
          <ChevronDown size={16} />
          Advanced — registry URL &amp; download priority
        </summary>
        <div className="nb-ext-advanced-body">
          <label className="nb-ext-field">
            <span>Registry URL</span>
            <div className="nb-ext-registry-row">
              <input
                className="nb-input"
                value={registry}
                onChange={(ev) => setRegistry(ev.target.value)}
                placeholder="https://github.com/owner/repo or raw registry.json"
              />
              <button
                type="button"
                className="nb-btn ghost"
                onClick={() => void refresh()}
                disabled={refreshing}
              >
                Apply
              </button>
            </div>
          </label>
          <label className="nb-ext-field">
            <span>Download provider priority (first wins)</span>
            <input
              className="nb-input"
              value={settings.downloadProviderPriority.join(", ")}
              onChange={(ev) => {
                const ids = ev.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                setSettings({ ...settings, downloadProviderPriority: ids });
                api.extensionsSetPriority("download", ids).catch(() => {});
              }}
            />
          </label>
        </div>
      </details>
    </section>
  );
}
