import { splitArtists } from "./splitArtists";

export function TappableArtists({
  artist,
  className = "",
  onArtist,
  onAlbum,
  album,
}: {
  artist: string;
  album?: string;
  className?: string;
  onArtist: (name: string) => void;
  onAlbum?: (album: string, artist: string) => void;
}) {
  const names = splitArtists(artist);
  return (
    <span className={`nb-tap-artists ${className}`.trim()}>
      {names.map((name, i) => (
        <span key={`${name}-${i}`}>
          {i > 0 ? <span className="nb-tap-sep">, </span> : null}
          <button
            type="button"
            className="nb-tap-link"
            onClick={(e) => {
              e.stopPropagation();
              onArtist(name);
            }}
          >
            {name}
          </button>
        </span>
      ))}
      {album && onAlbum ? (
        <>
          <span className="nb-tap-sep"> · </span>
          <button
            type="button"
            className="nb-tap-link"
            onClick={(e) => {
              e.stopPropagation();
              onAlbum(album, names[0] || artist);
            }}
          >
            {album}
          </button>
        </>
      ) : null}
    </span>
  );
}
