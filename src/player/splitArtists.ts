/** Split "A, B & C" / "A feat. B" style artist strings into clickable names. */
export function splitArtists(raw: string | undefined | null): string[] {
  if (!raw?.trim()) return [];
  const parts = raw
    .split(/\s*(?:,|&|\/| feat\.? | ft\.? | featuring | x | · |\||;)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.length ? out : [raw.trim()];
}
