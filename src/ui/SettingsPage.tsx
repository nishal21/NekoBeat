import type { CSSProperties } from "react";
import {
  Cloud,
  Download,
  FolderOpen,
  Moon,
  Music2,
  Settings2,
  SlidersHorizontal,
  Tags,
} from "lucide-react";
import { api } from "../lib/api";
import type { AccentPreset, AppSettings } from "../lib/types";
import { usePlayer } from "../player/PlayerContext";
import "./settings.css";

export function SettingsPage() {
  const { settings, setSettings, volume, setVolume } = usePlayer();

  const patch = (partial: Partial<AppSettings>) =>
    setSettings({ ...settings, ...partial });

  return (
    <section className="nb-settings">
      <header className="nb-settings-hero">
        <p className="nb-settings-kicker">
          <Settings2 size={14} /> NekoBeat
        </p>
        <h1 className="nb-page-title">Settings</h1>
        <p className="nb-page-sub">
          Appearance, playback, downloads, and embeds — tuned for HiFi.
        </p>
      </header>

      <div className="nb-settings-nav" aria-label="Jump to section">
        <a href="#nb-set-appearance">Appearance</a>
        <a href="#nb-set-playback">Playback</a>
        <a href="#nb-set-download">Download</a>
        <a href="#nb-set-meta">Metadata</a>
        <a href="#nb-set-files">Files</a>
        <a href="#nb-set-cloud">Cloud</a>
      </div>

      <Section
        id="nb-set-appearance"
        icon={<Moon size={18} />}
        title="Appearance"
        hint="How NekoBeat looks"
      >
        <Row
          label="Theme"
          hint="Neon dark by default · System follows OS"
          control={
            <div className="nb-seg" role="group" aria-label="Theme">
              {(
                [
                  ["system", "System"],
                  ["light", "Light"],
                  ["dark", "Dark"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`nb-seg-btn${settings.theme === value ? " is-on" : ""}`}
                  onClick={() => patch({ theme: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        />
        <Row
          label="Accent"
          hint="Brand pulse for CTAs, progress, and active states"
          control={
            <div className="nb-accent-swatches" role="group" aria-label="Accent">
              {(
                [
                  ["coral", "#ff3d6e"],
                  ["volt", "#ffe14a"],
                  ["rose", "#fb7185"],
                  ["teal", "#2dd4bf"],
                  ["sky", "#38bdf8"],
                  ["orchid", "#c084fc"],
                ] as const
              ).map(([id, color]) => (
                <button
                  key={id}
                  type="button"
                  className={`nb-accent-swatch${
                    (settings.accentPreset || "coral") === id ? " is-on" : ""
                  }`}
                  style={{ "--swatch": color } as CSSProperties}
                  title={id}
                  aria-label={id}
                  aria-pressed={(settings.accentPreset || "coral") === id}
                  onClick={() => patch({ accentPreset: id as AccentPreset })}
                />
              ))}
            </div>
          }
        />
      </Section>

      <Section
        id="nb-set-playback"
        icon={<Music2 size={18} />}
        title="Playback"
        hint="Volume, presence, and timing"
      >
        <Row
          label="Volume"
          hint={`${Math.round(volume * 100)}%`}
          control={
            <input
              className="nb-settings-range"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              aria-label="Volume"
            />
          }
        />
        <Row
          label="Discord Rich Presence"
          hint="Show cover and progress in Discord"
          control={
            <Switch
              on={settings.discordRichPresence}
              onChange={(v) => patch({ discordRichPresence: v })}
            />
          }
        />
        <Row
          label="Notification lyrics"
          hint="Android / Harmonoid-style lyrics"
          control={
            <Switch
              on={settings.notificationLyrics}
              onChange={(v) => {
                patch({ notificationLyrics: v });
                if (!v) api.lyricsNotifHide().catch(() => {});
              }}
            />
          }
        />
        <Row
          label="Gapless"
          hint="Seamless track transitions"
          control={
            <Switch
              on={settings.gapless}
              onChange={(v) => patch({ gapless: v })}
            />
          }
        />
        <Row
          label="Crossfade"
          hint={
            settings.crossfadeSeconds > 0
              ? `${settings.crossfadeSeconds}s fade between tracks`
              : "Off · hard cut"
          }
          control={
            <div className="nb-settings-crossfade">
              <input
                className="nb-settings-range"
                type="range"
                min={0}
                max={12}
                step={1}
                value={settings.crossfadeSeconds}
                onChange={(e) =>
                  patch({ crossfadeSeconds: Number(e.target.value) })
                }
                aria-label="Crossfade seconds"
              />
              <span className="nb-settings-crossfade-val">
                {settings.crossfadeSeconds > 0
                  ? `${settings.crossfadeSeconds}s`
                  : "Off"}
              </span>
            </div>
          }
        />
        <Row
          label="Sleep timer"
          hint="Minutes · blank = off"
          control={
            <input
              className="nb-settings-num"
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
          }
        />
        <div className="nb-settings-eq">
          <div className="nb-settings-eq-head">
            <SlidersHorizontal size={15} />
            <span>Equalizer</span>
            <button
              type="button"
              className="nb-tap-link"
              onClick={() => {
                const eqBands = settings.eqBands.map(() => 0);
                patch({ eqBands });
                api.setEq(eqBands).catch(() => {});
              }}
            >
              Reset
            </button>
          </div>
          <div className="nb-settings-eq-bands">
            {settings.eqBands.map((b, i) => (
              <label key={i} className="nb-settings-eq-band">
                <input
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
                  aria-label={`EQ band ${i + 1}`}
                />
                <span>{b > 0 ? `+${b}` : b}</span>
              </label>
            ))}
          </div>
        </div>
      </Section>

      <Section
        id="nb-set-download"
        icon={<Download size={18} />}
        title="Download"
        hint="HiFi folder, quality, and providers"
      >
        <div className="nb-settings-folder">
          <div className="nb-settings-folder-top">
            <FolderOpen size={16} />
            <strong>Download folder</strong>
          </div>
          <p className="nb-settings-folder-hint">
            FLAC files land here and are added to Library automatically.
          </p>
          <div className="nb-settings-folder-row">
            <input
              className="nb-input"
              placeholder="Default: app data /hifi"
              value={settings.downloadDir}
              onChange={(e) => patch({ downloadDir: e.target.value })}
            />
            <button
              type="button"
              className="nb-btn ghost"
              onClick={async () => {
                const { open } = await import("@tauri-apps/plugin-dialog");
                const picked = await open({ directory: true, multiple: false });
                if (typeof picked === "string" && picked) {
                  patch({ downloadDir: picked });
                }
              }}
            >
              Browse…
            </button>
            <button
              type="button"
              className="nb-btn ghost"
              onClick={async () => {
                try {
                  const dir = await api.hifiDownloadDir();
                  await api.openPath(dir);
                } catch (e) {
                  window.alert(String(e));
                }
              }}
            >
              Open
            </button>
          </div>
        </div>

        <Row
          label="Preferred service"
          control={
            <select
              className="nb-input nb-settings-select"
              value={settings.preferredDownloadService}
              onChange={(e) =>
                patch({ preferredDownloadService: e.target.value })
              }
            >
              {settings.downloadProviderPriority.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
              <option value="yt-dlp">yt-dlp (no login)</option>
              <option value="tidal-web">tidal-web</option>
              <option value="amazon">amazon</option>
              <option value="qobuz-web">qobuz-web</option>
              <option value="deezer">deezer</option>
            </select>
          }
        />
        <Row
          label="Quality"
          control={
            <div className="nb-seg nb-seg-wrap" role="group" aria-label="Quality">
              {(
                [
                  ["LOSSLESS", "Lossless"],
                  ["HI_RES", "Hi-Res"],
                  ["HI_RES_LOSSLESS", "Max"],
                  ["HIGH", "High"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`nb-seg-btn${settings.hifiQuality === value ? " is-on" : ""}`}
                  onClick={() => patch({ hifiQuality: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        />
        <Row
          label="Tidal HIGH format"
          control={
            <select
              className="nb-input nb-settings-select"
              value={settings.tidalHighFormat}
              onChange={(e) => patch({ tidalHighFormat: e.target.value })}
            >
              <option value="mp3_320">mp3_320</option>
              <option value="aac_320">aac_320</option>
              <option value="opus_256">opus_256</option>
              <option value="opus_128">opus_128</option>
            </select>
          }
        />
        <Row
          label="Ask before download"
          control={
            <Switch
              on={settings.askBeforeDownload}
              onChange={(v) => patch({ askBeforeDownload: v })}
            />
          }
        />
        <Row
          label="Auto fallback"
          hint="Try next provider if one fails"
          control={
            <Switch
              on={settings.autoFallback}
              onChange={(v) => patch({ autoFallback: v })}
            />
          }
        />
        <Row
          label="Wi‑Fi only"
          control={
            <Switch
              on={settings.wifiOnlyDownloads}
              onChange={(v) => patch({ wifiOnlyDownloads: v })}
            />
          }
        />
        <Row
          label="Concurrent downloads"
          hint="1–3"
          control={
            <input
              className="nb-settings-num"
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
          }
        />
        <Row
          label="SongLink region"
          control={
            <input
              className="nb-settings-num nb-settings-region"
              value={settings.songlinkRegion}
              onChange={(e) => patch({ songlinkRegion: e.target.value })}
            />
          }
        />
      </Section>

      <Section
        id="nb-set-meta"
        icon={<Tags size={18} />}
        title="Metadata & lyrics"
        hint="What gets written into downloaded files"
      >
        <Row
          label="Embed metadata"
          control={
            <Switch
              on={settings.embedMetadata}
              onChange={(v) => patch({ embedMetadata: v })}
            />
          }
        />
        <Row
          label="Embed lyrics"
          control={
            <Switch
              on={settings.embedLyrics}
              onChange={(v) => patch({ embedLyrics: v })}
            />
          }
        />
        <Row
          label="Lyrics mode"
          control={
            <select
              className="nb-input nb-settings-select"
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
          }
        />
        <Row
          label="Max-quality cover"
          control={
            <Switch
              on={settings.embedMaxQualityCover}
              onChange={(v) => patch({ embedMaxQualityCover: v })}
            />
          }
        />
        <Row
          label="ReplayGain"
          control={
            <Switch
              on={settings.embedReplayGain}
              onChange={(v) => patch({ embedReplayGain: v })}
            />
          }
        />
        <Row
          label="Skip duplicates"
          control={
            <Switch
              on={settings.skipDuplicates}
              onChange={(v) => patch({ skipDuplicates: v })}
            />
          }
        />
        <Row
          label="Allow quality variants"
          control={
            <Switch
              on={settings.allowQualityVariants}
              onChange={(v) => patch({ allowQualityVariants: v })}
            />
          }
        />
      </Section>

      <Section
        id="nb-set-files"
        icon={<FolderOpen size={18} />}
        title="Files"
        hint="Naming and folder layout"
      >
        <Row
          label="Filename format"
          stacked
          control={
            <input
              className="nb-input"
              value={settings.filenameFormat}
              onChange={(e) => patch({ filenameFormat: e.target.value })}
              placeholder="{artist} - {title}"
            />
          }
        />
        <Row
          label="Folder organization"
          control={
            <select
              className="nb-input nb-settings-select"
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
          }
        />
      </Section>

      <Section
        id="nb-set-cloud"
        icon={<Cloud size={18} />}
        title="SpotiFLAC cloud"
        hint="api.zarz.moe"
      >
        <Row
          label="API base URL"
          stacked
          control={
            <input
              className="nb-input"
              value={settings.zarzApiBase}
              onChange={(e) => patch({ zarzApiBase: e.target.value })}
              placeholder="https://api.zarz.moe"
            />
          }
        />
        <div className="nb-settings-actions">
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
            Extension docs
          </button>
        </div>
        <Row
          label="Scrobble"
          hint="Last.fm / ListenBrainz"
          control={
            <Switch
              on={settings.scrobbleEnabled}
              onChange={(v) => patch({ scrobbleEnabled: v })}
            />
          }
        />
      </Section>

      <p className="nb-settings-foot">
        NekoBeat · com.nishal21.nekobeat · no telemetry by default
      </p>
    </section>
  );
}

function Section({
  id,
  icon,
  title,
  hint,
  children,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="nb-settings-card">
      <header className="nb-settings-card-head">
        <span className="nb-settings-card-icon" aria-hidden>
          {icon}
        </span>
        <div>
          <h2>{title}</h2>
          {hint ? <p>{hint}</p> : null}
        </div>
      </header>
      <div className="nb-settings-card-body">{children}</div>
    </section>
  );
}

function Row({
  label,
  hint,
  control,
  stacked,
}: {
  label: string;
  hint?: string;
  control: React.ReactNode;
  stacked?: boolean;
}) {
  return (
    <div className={`nb-settings-row${stacked ? " is-stacked" : ""}`}>
      <div className="nb-settings-row-text">
        <span className="nb-settings-row-label">{label}</span>
        {hint ? <span className="nb-settings-row-hint">{hint}</span> : null}
      </div>
      <div className="nb-settings-row-control">{control}</div>
    </div>
  );
}

function Switch({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`nb-switch${on ? " is-on" : ""}`}
      onClick={() => onChange(!on)}
    >
      <i />
    </button>
  );
}
