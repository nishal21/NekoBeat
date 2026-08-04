import { usePlayer } from "../player/PlayerContext";
import type { AppSettings } from "../lib/types";
import { api } from "../lib/api";

export function SettingsPage() {
  const { settings, setSettings, volume, setVolume } = usePlayer();

  const patch = (partial: Partial<AppSettings>) =>
    setSettings({ ...settings, ...partial });

  return (
    <section>
      <h1 className="nb-page-title">Settings</h1>
      <p className="nb-page-sub">
        Appearance, playback, and SpotiFLAC Mobile–style download options.
      </p>

      <h2 className="nb-section-title">Appearance</h2>
      <Field label="Theme">
        <select
          className="nb-input"
          value={settings.theme}
          onChange={(e) =>
            patch({ theme: e.target.value as AppSettings["theme"] })
          }
        >
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </Field>

      <h2 className="nb-section-title">Playback</h2>
      <Field label="Volume">
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
        />
      </Field>
      <Field label="Discord Rich Presence (cover + progress)">
        <Toggle
          on={settings.discordRichPresence}
          onChange={(v) => patch({ discordRichPresence: v })}
        />
      </Field>
      <Field label="Notification lyrics (Android / Harmonoid)">
        <Toggle
          on={settings.notificationLyrics}
          onChange={(v) => {
            patch({ notificationLyrics: v });
            if (!v) api.lyricsNotifHide().catch(() => {});
          }}
        />
      </Field>
      <Field label="Gapless">
        <Toggle on={settings.gapless} onChange={(v) => patch({ gapless: v })} />
      </Field>
      <Field label="Crossfade (seconds)">
        <input
          className="nb-input"
          type="number"
          min={0}
          max={12}
          value={settings.crossfadeSeconds}
          onChange={(e) => patch({ crossfadeSeconds: Number(e.target.value) })}
        />
      </Field>
      <Field label="Sleep timer (minutes, blank = off)">
        <input
          className="nb-input"
          type="number"
          min={0}
          placeholder="Off"
          value={settings.sleepTimerMinutes ?? ""}
          onChange={(e) => {
            const n = e.target.value === "" ? null : Number(e.target.value);
            patch({ sleepTimerMinutes: n });
            api.setSleepTimer(n).catch(() => {});
          }}
        />
      </Field>
      <Field label="EQ bands (10)">
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {settings.eqBands.map((b, i) => (
            <input
              key={i}
              type="range"
              min={-12}
              max={12}
              value={b}
              onChange={(e) => {
                const eqBands = [...settings.eqBands];
                eqBands[i] = Number(e.target.value);
                patch({ eqBands });
                api.setEq(eqBands).catch(() => {});
              }}
              style={{ width: 36, writingMode: "vertical-lr", height: 80 }}
            />
          ))}
        </div>
      </Field>

      <h2 className="nb-section-title">Download (SpotiFLAC Mobile)</h2>
      <Field label="Preferred service (login in Extensions)">
        <select
          className="nb-input"
          value={settings.preferredDownloadService}
          onChange={(e) => patch({ preferredDownloadService: e.target.value })}
        >
          {settings.downloadProviderPriority.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
          <option value="tidal-web">tidal-web</option>
          <option value="amazon">amazon</option>
          <option value="qobuz-web">qobuz-web</option>
          <option value="deezer">deezer</option>
        </select>
      </Field>
      <Field label="Quality">
        <select
          className="nb-input"
          value={settings.hifiQuality}
          onChange={(e) =>
            patch({
              hifiQuality: e.target.value as AppSettings["hifiQuality"],
            })
          }
        >
          <option value="LOSSLESS">LOSSLESS</option>
          <option value="HI_RES">HI_RES</option>
          <option value="HI_RES_LOSSLESS">HI_RES_LOSSLESS</option>
          <option value="HIGH">HIGH (lossy)</option>
        </select>
      </Field>
      <Field label="Tidal HIGH format">
        <select
          className="nb-input"
          value={settings.tidalHighFormat}
          onChange={(e) => patch({ tidalHighFormat: e.target.value })}
        >
          <option value="mp3_320">mp3_320</option>
          <option value="aac_320">aac_320</option>
          <option value="opus_256">opus_256</option>
          <option value="opus_128">opus_128</option>
        </select>
      </Field>
      <Field label="Ask before download">
        <Toggle
          on={settings.askBeforeDownload}
          onChange={(v) => patch({ askBeforeDownload: v })}
        />
      </Field>
      <Field label="Auto fallback across providers">
        <Toggle
          on={settings.autoFallback}
          onChange={(v) => patch({ autoFallback: v })}
        />
      </Field>
      <Field label="Wi‑Fi only downloads">
        <Toggle
          on={settings.wifiOnlyDownloads}
          onChange={(v) => patch({ wifiOnlyDownloads: v })}
        />
      </Field>
      <Field label="Concurrent downloads (1–3)">
        <input
          className="nb-input"
          type="number"
          min={1}
          max={3}
          value={settings.concurrentDownloads}
          onChange={(e) =>
            patch({
              concurrentDownloads: Math.min(
                3,
                Math.max(1, Number(e.target.value) || 1),
              ),
            })
          }
        />
      </Field>
      <Field label="SongLink region">
        <input
          className="nb-input"
          value={settings.songlinkRegion}
          onChange={(e) => patch({ songlinkRegion: e.target.value })}
        />
      </Field>

      <h2 className="nb-section-title">Metadata & lyrics embed</h2>
      <Field label="Embed metadata">
        <Toggle
          on={settings.embedMetadata}
          onChange={(v) => patch({ embedMetadata: v })}
        />
      </Field>
      <Field label="Embed lyrics">
        <Toggle
          on={settings.embedLyrics}
          onChange={(v) => patch({ embedLyrics: v })}
        />
      </Field>
      <Field label="Lyrics mode">
        <select
          className="nb-input"
          value={settings.lyricsMode}
          onChange={(e) =>
            patch({
              lyricsMode: e.target.value as AppSettings["lyricsMode"],
            })
          }
        >
          <option value="embed">Embed in file</option>
          <option value="sidecar">External .lrc</option>
          <option value="both">Both</option>
        </select>
      </Field>
      <Field label="Max-quality cover embed">
        <Toggle
          on={settings.embedMaxQualityCover}
          onChange={(v) => patch({ embedMaxQualityCover: v })}
        />
      </Field>
      <Field label="Embed ReplayGain">
        <Toggle
          on={settings.embedReplayGain}
          onChange={(v) => patch({ embedReplayGain: v })}
        />
      </Field>
      <Field label="Skip duplicates">
        <Toggle
          on={settings.skipDuplicates}
          onChange={(v) => patch({ skipDuplicates: v })}
        />
      </Field>
      <Field label="Allow quality variants">
        <Toggle
          on={settings.allowQualityVariants}
          onChange={(v) => patch({ allowQualityVariants: v })}
        />
      </Field>

      <h2 className="nb-section-title">Files</h2>
      <Field label="Filename format">
        <input
          className="nb-input"
          value={settings.filenameFormat}
          onChange={(e) => patch({ filenameFormat: e.target.value })}
          placeholder="{artist} - {title}"
        />
      </Field>
      <Field label="Folder organization">
        <select
          className="nb-input"
          value={settings.folderOrganization}
          onChange={(e) =>
            patch({
              folderOrganization: e.target
                .value as AppSettings["folderOrganization"],
            })
          }
        >
          <option value="none">None</option>
          <option value="artist">Artist</option>
          <option value="album">Album</option>
          <option value="artist_album">Artist / Album</option>
        </select>
      </Field>

      <h2 className="nb-section-title">SpotiFLAC cloud (api.zarz.moe)</h2>
      <Field label="API base URL">
        <input
          className="nb-input"
          value={settings.zarzApiBase}
          onChange={(e) => patch({ zarzApiBase: e.target.value })}
          placeholder="https://api.zarz.moe"
        />
      </Field>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <button
          type="button"
          className="nb-btn ghost"
          onClick={async () => {
            try {
              const h = await api.zarzHealth();
              window.alert(`API OK: ${h.status} ${h.version ?? ""}`);
            } catch (e) {
              window.alert(String(e));
            }
          }}
        >
          Ping health
        </button>
        <button
          type="button"
          className="nb-btn ghost"
          onClick={async () => {
            const url = await api.zarzDocsUrl();
            try {
              const { openUrl } = await import("@tauri-apps/plugin-opener");
              await openUrl(url);
            } catch {
              window.open(url, "_blank");
            }
          }}
        >
          Open extension docs
        </button>
      </div>

      <Field label="Scrobble (Last.fm / ListenBrainz)">
        <Toggle
          on={settings.scrobbleEnabled}
          onChange={(v) => patch({ scrobbleEnabled: v })}
        />
      </Field>

      <p
        style={{
          color: "var(--nb-ink-muted)",
          fontSize: "0.85rem",
          marginTop: 24,
        }}
      >
        NekoBeat · com.nishal21.nekobeat · no telemetry by default
      </p>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", marginBottom: 16 }}>
      <span style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function Toggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`nb-btn ${on ? "" : "ghost"}`}
      onClick={() => onChange(!on)}
    >
      {on ? "On" : "Off"}
    </button>
  );
}
