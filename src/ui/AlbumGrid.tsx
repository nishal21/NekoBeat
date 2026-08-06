import type { AlbumGroup } from "../lib/libraryHelpers";
import { CoverArt } from "./CoverArt";

export function AlbumGrid({
  albums,
  onOpen,
}: {
  albums: AlbumGroup[];
  onOpen: (album: AlbumGroup) => void;
}) {
  return (
    <div className="nb-album-grid">
      {albums.map((a, i) => {
        const lead = a.tracks[0];
        return (
          <button
            key={a.key}
            type="button"
            className="nb-album-tile"
            style={{ animationDelay: `${Math.min(i, 16) * 28}ms` }}
            onClick={() => onOpen(a)}
            title={`${a.album} — ${a.artist}`}
          >
            <div className="nb-album-frame">
              <CoverArt
                track={{
                  id: lead?.id ?? a.key,
                  title: lead?.title ?? a.album,
                  artist: lead?.artist ?? a.artist,
                  coverUrl: lead?.coverUrl ?? a.coverUrl,
                  path: lead?.path,
                  album: a.album,
                }}
                className="nb-album-art"
              />
            </div>
            <strong>{a.album}</strong>
            <span>{a.artist}</span>
          </button>
        );
      })}
    </div>
  );
}
