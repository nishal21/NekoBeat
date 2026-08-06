export type ArtistBio = {
  name: string;
  mbid?: string;
  summary?: string;
  imageUrl?: string;
  tags: string[];
  links: { label: string; url: string }[];
};

function stripHtml(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** MusicBrainz + Wikipedia — no API key. */
export async function fetchArtistBio(artist: string): Promise<ArtistBio | null> {
  const name = artist.trim();
  if (!name) return null;

  const q = encodeURIComponent(name);
  const mbRes = await fetch(
    `https://musicbrainz.org/ws/2/artist/?query=artist:${q}&fmt=json&limit=1`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "NekoBeat/0.3 (https://github.com/nishal21/nekobeat)",
      },
    },
  );
  if (!mbRes.ok) throw new Error(`MusicBrainz ${mbRes.status}`);
  const mb = (await mbRes.json()) as {
    artists?: {
      id: string;
      name: string;
      tags?: { name: string; count: number }[];
      relations?: { type: string; url?: { resource: string } }[];
    }[];
  };
  const hit = mb.artists?.[0];
  if (!hit) return { name, tags: [], links: [] };

  let relations: { type: string; url?: { resource: string } }[] =
    hit.relations || [];
  let tagsRaw = hit.tags || [];

  try {
    const detailRes = await fetch(
      `https://musicbrainz.org/ws/2/artist/${hit.id}?inc=url-rels+tags&fmt=json`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "NekoBeat/0.3 (https://github.com/nishal21/nekobeat)",
        },
      },
    );
    if (detailRes.ok) {
      const detail = (await detailRes.json()) as {
        tags?: { name: string; count: number }[];
        relations?: { type: string; url?: { resource: string } }[];
      };
      if (detail.relations?.length) relations = detail.relations;
      if (detail.tags?.length) tagsRaw = detail.tags;
    }
  } catch {
    /* search hit is enough */
  }

  const tags = tagsRaw
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((t) => t.name);

  const links: { label: string; url: string }[] = [];
  for (const rel of relations) {
    const url = rel.url?.resource;
    if (!url) continue;
    const type = (rel.type || "").toLowerCase();
    if (
      /official|wikipedia|wikidata|youtube|spotify|bandcamp|soundcloud|twitter|instagram|facebook|homepage|discogs/.test(
        type,
      ) ||
      /wikipedia|spotify|youtube|bandcamp|soundcloud|instagram|twitter|facebook|discogs/.test(
        url,
      )
    ) {
      let label = rel.type || "Link";
      if (/wikipedia/i.test(url)) label = "Wikipedia";
      else if (/spotify/i.test(url)) label = "Spotify";
      else if (/youtube/i.test(url)) label = "YouTube";
      else if (/bandcamp/i.test(url)) label = "Bandcamp";
      else if (/soundcloud/i.test(url)) label = "SoundCloud";
      else if (/instagram/i.test(url)) label = "Instagram";
      else if (/twitter|x\.com/i.test(url)) label = "X";
      else if (/facebook/i.test(url)) label = "Facebook";
      else if (/discogs/i.test(url)) label = "Discogs";
      else if (/official|homepage/i.test(type)) label = "Website";
      if (!links.some((l) => l.url === url)) links.push({ label, url });
    }
  }

  let summary: string | undefined;
  let imageUrl: string | undefined;

  const wikiRel = relations.find((r) =>
    /wikipedia/i.test(r.url?.resource || ""),
  );
  const wikiUrl = wikiRel?.url?.resource;
  if (wikiUrl) {
    const title = decodeURIComponent(wikiUrl.split("/wiki/").pop() || "");
    if (title) {
      try {
        const w = await fetch(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
        );
        if (w.ok) {
          const page = (await w.json()) as {
            extract?: string;
            thumbnail?: { source?: string };
          };
          summary = page.extract;
          imageUrl = page.thumbnail?.source;
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (!summary) {
    try {
      const w = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`,
      );
      if (w.ok) {
        const page = (await w.json()) as {
          extract?: string;
          thumbnail?: { source?: string };
          type?: string;
        };
        if (page.type !== "disambiguation") {
          summary = page.extract;
          imageUrl = imageUrl || page.thumbnail?.source;
        }
      }
    } catch {
      /* ignore */
    }
  }

  links.unshift({
    label: "MusicBrainz",
    url: `https://musicbrainz.org/artist/${hit.id}`,
  });

  return {
    name: hit.name || name,
    mbid: hit.id,
    summary: summary ? stripHtml(summary) : undefined,
    imageUrl,
    tags,
    links: links.slice(0, 10),
  };
}
