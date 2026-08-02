import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Download, Sparkles, X, ExternalLink, RefreshCw, CheckCircle2 } from "lucide-react";
import {
  AvailableUpdate,
  checkForAppUpdate,
  dismissUpdate,
  installDesktopUpdate,
  openExternal,
} from "./updates";

type Props = {
  /** Bump to force a re-check (e.g. Settings "Check now") */
  checkNonce?: number;
  /** When true, ignore snooze/dismiss (manual check) */
  force?: boolean;
  onStatus?: (s: {
    checking: boolean;
    current?: string;
    update: AvailableUpdate | null;
    error?: string;
    upToDate?: boolean;
  }) => void;
};

export function UpdateNotification({ checkNonce = 0, force = false, onStatus }: Props) {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      onStatus?.({ checking: true, update: null });
      try {
        // Startup delay only on first automatic pass
        if (checkNonce === 0 && !force) {
          await new Promise((r) => setTimeout(r, 2800));
        }
        if (cancelled) return;
        const { current, update: u } = await checkForAppUpdate({
          ignoreDismiss: force || checkNonce > 0,
        });
        if (cancelled) return;
        setUpdate(u);
        onStatus?.({
          checking: false,
          current,
          update: u,
          upToDate: !u,
        });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        onStatus?.({ checking: false, update: null, error: msg });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkNonce, force]);

  const onLater = () => {
    if (update) dismissUpdate(update.version, 36);
    setUpdate(null);
  };

  const onInstall = async () => {
    if (!update) return;
    setError(null);
    setBusy(true);
    try {
      if (update.canInstallInApp) {
        await installDesktopUpdate((pct, status) => {
          setProgress(pct);
          setStatusText(status);
        });
      } else if (update.downloadUrl) {
        setStatusText("Opening download…");
        await openExternal(update.downloadUrl);
        setStatusText("Download started in your browser");
      } else if (update.releaseUrl) {
        await openExternal(update.releaseUrl);
      } else {
        throw new Error("No download link for this platform yet");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatusText("");
    } finally {
      setBusy(false);
    }
  };

  const channelLabel =
    update?.channel === "android"
      ? "Android APK"
      : update?.channel === "desktop"
        ? "In-app update"
        : "GitHub release";

  return (
    <AnimatePresence>
      {update && (
        <motion.aside
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: 28, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.98 }}
          transition={{ type: "spring", stiffness: 380, damping: 28 }}
          className="update-toast"
        >
          <div className="update-toast__glow" aria-hidden />
          <button
            type="button"
            className="update-toast__close"
            onClick={onLater}
            aria-label="Remind me later"
            disabled={busy}
          >
            <X size={16} />
          </button>

          <div className="update-toast__row">
            <div className="update-toast__icon">
              <Sparkles size={22} strokeWidth={2.25} />
            </div>
            <div className="update-toast__copy">
              <p className="update-toast__kicker">{channelLabel}</p>
              <h3 className="update-toast__title">NekoBeat {update.version}</h3>
              <p className="update-toast__sub">
                {update.canInstallInApp
                  ? "A new build is ready to install on this device."
                  : update.channel === "android"
                    ? "New Android build — download the APK and install over the current app."
                    : "A newer release is on GitHub. Download the installer for your OS."}
              </p>
            </div>
          </div>

          {update.notes && (
            <button
              type="button"
              className="update-toast__notes-toggle"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Hide notes" : "What’s new"}
            </button>
          )}
          <AnimatePresence>
            {expanded && update.notes && (
              <motion.pre
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="update-toast__notes"
              >
                {update.notes.slice(0, 800)}
              </motion.pre>
            )}
          </AnimatePresence>

          {(busy || progress !== null) && (
            <div className="update-toast__progress">
              <div className="update-toast__progress-track">
                <motion.div
                  className="update-toast__progress-fill"
                  animate={{
                    width: progress == null ? ["15%", "70%", "40%"] : `${progress}%`,
                  }}
                  transition={
                    progress == null
                      ? { repeat: Infinity, duration: 1.4, ease: "easeInOut" }
                      : { duration: 0.2 }
                  }
                />
              </div>
              <p className="update-toast__progress-label">
                {statusText}
                {progress != null ? ` ${progress}%` : ""}
              </p>
            </div>
          )}

          {error && <p className="update-toast__error">{error}</p>}

          <div className="update-toast__actions">
            <button
              type="button"
              className="update-toast__primary"
              onClick={() => void onInstall()}
              disabled={busy}
            >
              {busy ? (
                <RefreshCw size={14} className="animate-spin" />
              ) : update.canInstallInApp ? (
                <Download size={14} />
              ) : (
                <ExternalLink size={14} />
              )}
              {update.canInstallInApp
                ? busy
                  ? "Installing…"
                  : "Install & restart"
                : update.channel === "android"
                  ? "Get APK"
                  : "Download"}
            </button>
            {!busy && (
              <button type="button" className="update-toast__ghost" onClick={onLater}>
                Later
              </button>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

type SettingsProps = {
  currentVersion: string;
  checking: boolean;
  upToDate: boolean;
  error?: string;
  update: AvailableUpdate | null;
  onCheck: () => void;
};

export function UpdateSettingsCard({
  currentVersion,
  checking,
  upToDate,
  error,
  update,
  onCheck,
}: SettingsProps) {
  return (
    <section className="settings-card space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base sm:text-lg font-display font-bold text-white">
            App updates
          </h3>
          <p className="text-sm text-[var(--color-ink-muted)] mt-1">
            Desktop installs update in-app. On Android we point you to the latest signed APK from GitHub Releases.
          </p>
        </div>
        {upToDate && !update && (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-emerald-400/90 shrink-0">
            <CheckCircle2 size={14} />
            Current
          </span>
        )}
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl border border-white/10 bg-black/25">
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-[var(--color-ink-faint)]">
            Installed
          </p>
          <p className="font-display font-black text-xl text-white mt-0.5">
            v{currentVersion || "…"}
          </p>
          {update && (
            <p className="text-xs text-[var(--color-neon-yellow)] mt-1 font-bold">
              v{update.version} available ({update.channel})
            </p>
          )}
          {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
        </div>
        <button
          type="button"
          onClick={onCheck}
          disabled={checking}
          className="inline-flex h-11 items-center justify-center gap-2 px-5 rounded-xl bg-[var(--color-neon-yellow)] text-black font-black text-xs uppercase tracking-wider disabled:opacity-50 hover:brightness-110 active:scale-[0.98] transition"
        >
          <RefreshCw size={14} className={checking ? "animate-spin" : ""} />
          {checking ? "Checking…" : "Check for updates"}
        </button>
      </div>
    </section>
  );
}
