import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type HifiStatus = {
  ok?: boolean;
  available?: boolean;
  packaged?: boolean;
  ready?: boolean;
  bootstrapped?: boolean;
  platform?: string;
  process?: string;
  probe?: string;
  lastError?: string | null;
  error?: string;
};

type Props = {
  isAndroid: boolean;
};

export function SpotiFlacHifiCard({ isAndroid }: Props) {
  const [status, setStatus] = useState<HifiStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // Local status only — must not start Go worker (that crashed Settings).
      const raw = await invoke<string>("spotiflac_mobile_status");
      const parsed = JSON.parse(raw) as HifiStatus;
      setStatus(parsed);
      setMsg(null);
    } catch (e) {
      setStatus({ ok: false, packaged: false, platform: "android" });
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!isAndroid) return;
    void refresh();
  }, [isAndroid, refresh]);

  const onBootstrap = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const raw = await invoke<string>("spotiflac_mobile_bootstrap");
      setMsg(raw.slice(0, 280));
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!isAndroid) {
    return (
      <section className="settings-card space-y-2">
        <h3 className="text-base sm:text-lg font-display font-bold text-white">SpotiFLAC HiFi</h3>
        <p className="text-sm text-[var(--color-ink-muted)]">
          Desktop Spotify HiFi uses the SpotiFLAC CLI sidecar. Android packages may include an isolated Go worker; Spotify search matching does not require HiFi credentials.
        </p>
      </section>
    );
  }

  const packaged = !!status?.packaged || !!status?.available;
  const label = !packaged
    ? "HiFi AAR not in this APK — Spotify still plays via YouTube"
    : status?.error || status?.lastError
      ? "Worker error — tap Retry only if you need HiFi"
      : "Packaged (worker starts only on HiFi / Retry — not when opening Settings)";

  return (
    <section className="settings-card space-y-4">
      <div>
        <h3 className="text-base sm:text-lg font-display font-bold text-white">SpotiFLAC HiFi</h3>
        <p className="text-sm text-[var(--color-ink-muted)] mt-1">
          Play always uses YouTube first. Lossless upgrade is optional and isolated.
        </p>
      </div>
      <p className="text-sm text-white/90 font-medium">{label}</p>
      {(status?.lastError || status?.error) && (
        <p className="text-xs text-red-300/90 break-words">{status.lastError || status.error}</p>
      )}
      {msg && <p className="text-xs text-[var(--color-ink-muted)] break-words font-mono">{msg}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void refresh()}
          className="min-h-[44px] px-4 rounded-2xl border border-white/10 bg-black/30 text-sm font-bold text-white hover:border-[var(--color-neon-yellow)]/50"
        >
          Refresh
        </button>
        <button
          type="button"
          disabled={busy || !packaged}
          onClick={() => void onBootstrap()}
          className="min-h-[44px] px-4 rounded-2xl border border-[var(--color-neon-yellow)]/40 bg-[var(--color-neon-yellow)]/15 text-sm font-bold text-[var(--color-neon-yellow)] disabled:opacity-40"
        >
          {busy ? "Bootstrapping…" : "Retry extensions"}
        </button>
      </div>
    </section>
  );
}
