import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ExtensionEntry, ExtensionSettingField } from "../lib/types";
import { usePlayer } from "../player/PlayerContext";

export function ExtensionsPage() {
  const { settings, setSettings } = usePlayer();
  const [items, setItems] = useState<ExtensionEntry[]>([]);
  const [registry, setRegistry] = useState(settings.extensionRegistryUrl);
  const [msg, setMsg] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [fields, setFields] = useState<ExtensionSettingField[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [authCode, setAuthCode] = useState("");

  const load = () =>
    api
      .extensionsList()
      .then(setItems)
      .catch(() => setItems([]));

  useEffect(() => {
    load();
  }, []);

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
    setMsg(pending.hint || "Complete login in browser, then paste the code below.");
  };

  const finishLogin = async () => {
    if (!activeId) return;
    await api.extensionsSetSettings(activeId, form);
    await api.extensionsCompleteLogin(activeId, authCode || undefined);
    setMsg("Logged in — downloads can use this provider");
    await load();
  };

  const applyRegistry = async () => {
    await api.extensionsSetRegistry(registry);
    setSettings({ ...settings, extensionRegistryUrl: registry });
    const rows = await api.extensionsRefresh();
    setItems(rows);
    setMsg("Registry updated");
  };

  return (
    <section>
      <h1 className="nb-page-title">Extensions</h1>
      <p className="nb-page-sub">
        SpotiFLAC Mobile pattern: install providers, then{" "}
        <strong>login / Connect</strong> before HiFi downloads. Cloud resolve +
        docs:{" "}
        <a href="https://api.zarz.moe/" target="_blank" rel="noreferrer">
          api.zarz.moe
        </a>{" "}
        ·{" "}
        <a href="https://spotiflac.zarz.moe/docs" target="_blank" rel="noreferrer">
          extension docs
        </a>
        .
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <input
          className="nb-input"
          value={registry}
          onChange={(e) => setRegistry(e.target.value)}
          placeholder="https://github.com/owner/repo or raw registry.json"
        />
        <button type="button" className="nb-btn" onClick={applyRegistry}>
          Set registry
        </button>
        <button
          type="button"
          className="nb-btn ghost"
          onClick={async () => setItems(await api.extensionsRefresh())}
        >
          Refresh
        </button>
      </div>
      {msg ? <p style={{ color: "var(--nb-accent)" }}>{msg}</p> : null}

      {items.length ? (
        items.map((e) => (
          <div key={e.id} className="nb-track-row">
            <div className="nb-cover" />
            <div style={{ minWidth: 0 }}>
              <strong>
                {e.displayName || e.name} · {e.version}
                {e.loggedIn ? (
                  <span className="nb-quality-badge" style={{ marginLeft: 8 }}>
                    Logged in
                  </span>
                ) : e.needsAuth ? (
                  <span
                    className="nb-quality-badge tone-stream"
                    style={{ marginLeft: 8 }}
                  >
                    Login needed
                  </span>
                ) : null}
              </strong>
              <span
                style={{
                  display: "block",
                  color: "var(--nb-ink-muted)",
                  fontSize: "0.85rem",
                }}
              >
                {e.category} — {e.description}
              </span>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button
                type="button"
                className="nb-btn ghost"
                onClick={async () => {
                  await api.extensionsInstall(e.id);
                  await load();
                }}
              >
                {e.installed ? "Reinstall" : "Install"}
              </button>
              {e.needsAuth ? (
                <button
                  type="button"
                  className="nb-btn"
                  onClick={() => openLogin(e.id)}
                >
                  {e.loggedIn ? "Account" : "Login"}
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
                  Logout
                </button>
              ) : null}
            </div>
          </div>
        ))
      ) : (
        <div className="nb-empty">
          No catalog yet — set a registry URL and refresh.
        </div>
      )}

      {activeId ? (
        <div className="nb-login-panel">
          <h2 style={{ fontFamily: "var(--nb-font-display)" }}>
            Login · {activeId}
          </h2>
          <p className="nb-page-sub">
            Same idea as SpotiFLAC Mobile extension settings: credentials and/or
            Connect (OAuth / browser verify), then paste callback if needed.
          </p>
          {fields
            .filter((f) => f.type !== "button")
            .map((f) => (
              <label key={f.key} style={{ display: "block", marginBottom: 12 }}>
                <span style={{ fontWeight: 600 }}>{f.label}</span>
                <input
                  className="nb-input"
                  type={f.type === "secret" || f.secret ? "password" : "text"}
                  value={form[f.key] ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, [f.key]: e.target.value })
                  }
                />
              </label>
            ))}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <button type="button" className="nb-btn ghost" onClick={saveCreds}>
              Save credentials
            </button>
            {fields.some((f) => f.type === "button" || f.oauthLoginUrl) ? (
              <button type="button" className="nb-btn" onClick={connectOauth}>
                Connect / Open browser
              </button>
            ) : null}
          </div>
          <label style={{ display: "block", marginBottom: 12 }}>
            <span style={{ fontWeight: 600 }}>OAuth callback / grant code</span>
            <input
              className="nb-input"
              value={authCode}
              onChange={(e) => setAuthCode(e.target.value)}
              placeholder="Paste after browser login (optional if password set)"
            />
          </label>
          <button type="button" className="nb-btn" onClick={finishLogin}>
            Complete login
          </button>
        </div>
      ) : null}

      <h2 style={{ fontFamily: "var(--nb-font-display)", marginTop: 24 }}>
        Download provider priority
      </h2>
      <p className="nb-page-sub">First wins, then auto-fallback (SpotiFLAC Mobile).</p>
      <input
        className="nb-input"
        value={settings.downloadProviderPriority.join(", ")}
        onChange={(e) => {
          const ids = e.target.value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          setSettings({ ...settings, downloadProviderPriority: ids });
          api.extensionsSetPriority("download", ids).catch(() => {});
        }}
      />
    </section>
  );
}
