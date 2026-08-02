/**
 * Shown on Android while Browse / streaming are paused.
 * Copy kept plain on purpose — no “unlock the full experience” fluff.
 */
export function AndroidScopeBanner() {
  return (
    <section
      className="mb-5 rounded-2xl border border-[var(--color-neon-yellow)]/25 bg-[var(--color-neon-yellow)]/[0.07] px-4 py-3.5"
      role="status"
    >
      <p className="text-[10px] font-black uppercase tracking-widest text-[var(--color-neon-yellow)]/90">
        Android preview
      </p>
      <p className="mt-1.5 text-sm font-bold text-white leading-snug">
        Local library only for now
      </p>
      <p className="mt-1 text-xs text-[var(--color-ink-muted)] leading-relaxed">
        Scan music on this phone and play files you already have. Search, YouTube,
        SoundCloud, and Spotify streaming are off here until they work as well as
        on desktop. We’ll bring those back in a later build.
      </p>
    </section>
  );
}

export function AndroidScopeSettingsCard() {
  return (
    <section className="settings-card space-y-2">
      <h3 className="text-base sm:text-lg font-display font-bold text-white">
        What’s in this Android build
      </h3>
      <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed">
        Library, Liked (offline files), Settings, and the equalizer. Online
        streaming stays off here for now. Play a song from Library and we’ll pull
        cover art and lyrics from the title and artist when the network allows.
      </p>
    </section>
  );
}
