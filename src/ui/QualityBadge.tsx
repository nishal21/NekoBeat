/** SpotiFLAC Mobile–style quality chip */
export function QualityBadge({
  label,
  requested,
  bitDepth,
  sampleRateHz,
}: {
  label?: string | null;
  requested?: string | null;
  bitDepth?: number | null;
  sampleRateHz?: number | null;
}) {
  const text =
    label ||
    (bitDepth && sampleRateHz
      ? `FLAC · ${bitDepth}bit · ${(sampleRateHz / 1000).toFixed(1)}kHz`
      : requested
        ? requested
        : null);
  if (!text) return null;
  const tier = (requested || text).toUpperCase();
  const tone =
    tier.includes("HI_RES") || tier.includes("24")
      ? "hi"
      : tier.includes("LOSSLESS") || tier.includes("FLAC")
        ? "lossless"
        : "stream";
  return <span className={`nb-quality-badge tone-${tone}`}>{text}</span>;
}
