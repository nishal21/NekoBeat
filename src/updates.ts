/** App + APK update discovery for desktop (Tauri updater) and Android (GitHub Releases). */

export type UpdateChannel = "desktop" | "android" | "github";

export type AvailableUpdate = {
  version: string;
  notes?: string;
  date?: string;
  channel: UpdateChannel;
  /** Desktop only — install via Tauri updater */
  canInstallInApp: boolean;
  /** Direct APK / installer URL (Android or GitHub fallback) */
  downloadUrl?: string;
  /** Release page */
  releaseUrl?: string;
};

const DISMISS_KEY = "nekobeat_update_dismissed";
const SNOOZE_KEY = "nekobeat_update_snooze_until";
const GITHUB_LATEST =
  "https://api.github.com/repos/nishal21/NekoBeat/releases/latest";

export function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, "");
}

/** Semver-ish compare: 1 if a>b, -1 if a<b, 0 if equal/unknown. */
export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = normalizeVersion(b).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

export function isDismissed(version: string): boolean {
  try {
    const snooze = localStorage.getItem(SNOOZE_KEY);
    if (snooze && Date.now() < Number(snooze)) return true;
    const dismissed = localStorage.getItem(DISMISS_KEY);
    return dismissed === normalizeVersion(version);
  } catch {
    return false;
  }
}

export function dismissUpdate(version: string, snoozeHours = 24) {
  try {
    localStorage.setItem(DISMISS_KEY, normalizeVersion(version));
    localStorage.setItem(
      SNOOZE_KEY,
      String(Date.now() + snoozeHours * 60 * 60 * 1000),
    );
  } catch {
    /* ignore */
  }
}

export function clearDismiss() {
  try {
    localStorage.removeItem(DISMISS_KEY);
    localStorage.removeItem(SNOOZE_KEY);
  } catch {
    /* ignore */
  }
}

async function getAppVersion(): Promise<string> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "0.0.0";
  }
}

async function getPlatform(): Promise<string> {
  try {
    return await invokePlatform();
  } catch {
    return "unknown";
  }
}

async function invokePlatform(): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("runtime_platform");
}

type GhRelease = {
  tag_name?: string;
  name?: string;
  body?: string;
  published_at?: string;
  html_url?: string;
  assets?: Array<{ name: string; browser_download_url: string }>;
};

async function fetchGithubLatest(): Promise<GhRelease | null> {
  try {
    const res = await fetch(GITHUB_LATEST, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as GhRelease;
  } catch {
    return null;
  }
}

function pickAndroidApk(release: GhRelease): string | undefined {
  const assets = release.assets || [];
  const prefer = assets.find((a) =>
    /android.*arm64|arm64-v8a|aarch64/i.test(a.name) && /\.apk$/i.test(a.name),
  );
  if (prefer) return prefer.browser_download_url;
  const anyApk = assets.find((a) => /\.apk$/i.test(a.name));
  return anyApk?.browser_download_url;
}

function pickDesktopInstaller(release: GhRelease, platform: string): string | undefined {
  const assets = release.assets || [];
  if (platform === "windows") {
    return assets.find((a) => /setup\.exe$|\.msi$/i.test(a.name))?.browser_download_url;
  }
  if (platform === "linux") {
    return assets.find((a) => /\.AppImage$|\.deb$/i.test(a.name))?.browser_download_url;
  }
  if (platform === "macos") {
    return assets.find((a) => /\.dmg$/i.test(a.name))?.browser_download_url;
  }
  return undefined;
}

/**
 * Check for a newer app build.
 * Desktop: Tauri signed updater first, then GitHub release as fallback notice.
 * Android: GitHub Releases APK.
 */
export async function checkForAppUpdate(opts?: {
  ignoreDismiss?: boolean;
}): Promise<{ current: string; update: AvailableUpdate | null }> {
  const current = await getAppVersion();
  const platform = await getPlatform();
  const ignoreDismiss = opts?.ignoreDismiss === true;

  // 1) Official Tauri updater (desktop signed installs)
  if (platform !== "android" && platform !== "ios") {
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update && compareVersions(update.version, current) > 0) {
        if (!ignoreDismiss && isDismissed(update.version)) {
          return { current, update: null };
        }
        return {
          current,
          update: {
            version: normalizeVersion(update.version),
            notes: update.body || undefined,
            date: update.date || undefined,
            channel: "desktop",
            canInstallInApp: true,
          },
        };
      }
    } catch (e) {
      console.warn("Tauri updater check failed:", e);
    }
  }

  // 2) GitHub Releases (Android APK + desktop fallback when gist/updater lag)
  const gh = await fetchGithubLatest();
  if (!gh?.tag_name) return { current, update: null };

  const remote = normalizeVersion(gh.tag_name);
  if (compareVersions(remote, current) <= 0) return { current, update: null };
  if (!ignoreDismiss && isDismissed(remote)) return { current, update: null };

  if (platform === "android") {
    const apk = pickAndroidApk(gh);
    return {
      current,
      update: {
        version: remote,
        notes: gh.body || gh.name || undefined,
        date: gh.published_at || undefined,
        channel: "android",
        canInstallInApp: false,
        downloadUrl: apk,
        releaseUrl: gh.html_url,
      },
    };
  }

  // Desktop fallback: newer tag on GitHub but updater feed may be stale
  return {
    current,
    update: {
      version: remote,
      notes: gh.body || gh.name || undefined,
      date: gh.published_at || undefined,
      channel: "github",
      canInstallInApp: false,
      downloadUrl: pickDesktopInstaller(gh, platform),
      releaseUrl: gh.html_url,
    },
  };
}

export async function openExternal(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank");
  }
}

export async function installDesktopUpdate(
  onProgress?: (pct: number | null, status: string) => void,
): Promise<void> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) throw new Error("Update no longer available");

  onProgress?.(0, "Starting download…");
  let downloaded = 0;
  let contentLength: number | undefined;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        contentLength = event.data.contentLength;
        onProgress?.(0, "Downloading…");
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        if (contentLength && contentLength > 0) {
          onProgress?.(
            Math.min(99, Math.round((downloaded / contentLength) * 100)),
            "Downloading…",
          );
        } else {
          onProgress?.(null, "Downloading…");
        }
        break;
      case "Finished":
        onProgress?.(100, "Installing…");
        break;
    }
  });

  onProgress?.(100, "Restarting…");
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch {
    // Installer may restart on its own (NSIS passive)
  }
}
