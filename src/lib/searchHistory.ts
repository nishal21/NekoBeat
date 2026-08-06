const KEY = "nb-search-history-v1";
const MAX = 12;

export function getSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string").slice(0, MAX);
  } catch {
    return [];
  }
}

export function pushSearchHistory(term: string) {
  const t = term.trim();
  if (!t) return;
  const prev = getSearchHistory().filter(
    (x) => x.toLowerCase() !== t.toLowerCase(),
  );
  const next = [t, ...prev].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function clearSearchHistory() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
