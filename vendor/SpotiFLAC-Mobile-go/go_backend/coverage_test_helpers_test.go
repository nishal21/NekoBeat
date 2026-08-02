package gobackend

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestLoadedExtension(t *testing.T, types ...ExtensionType) *loadedExtension {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.js"), []byte(testExtensionJS), 0600); err != nil {
		t.Fatalf("write index.js: %v", err)
	}
	return &loadedExtension{
		ID: "coverage-ext",
		Manifest: &ExtensionManifest{
			Name:        "coverage-ext",
			Description: "Coverage extension",
			Version:     "1.0.0",
			Types:       types,
			Permissions: ExtensionPermissions{File: true, Network: []string{"example.test"}},
			SearchBehavior: &SearchBehaviorConfig{
				Enabled:     true,
				Placeholder: "Search coverage",
				Primary:     true,
				Icon:        "search",
			},
			URLHandler:    &URLHandlerConfig{Enabled: true, Patterns: []string{"https://example.test/"}},
			TrackMatching: &TrackMatchingConfig{CustomMatching: true},
			PostProcessing: &PostProcessingConfig{
				Enabled: true,
				Hooks:   []PostProcessingHook{{ID: "hook", Name: "Hook", DefaultEnabled: true, SupportedFormats: []string{"flac"}}},
			},
		},
		Enabled:   true,
		SourceDir: dir,
		DataDir:   t.TempDir(),
	}
}

const testExtensionJS = `
function track(id) {
  return {
    id: id,
    name: "Track " + id,
    artists: "Artist",
    albumName: "Album",
    albumArtist: "Album Artist",
    durationMs: 180000,
    coverUrl: "https://example.test/cover.jpg",
    releaseDate: "2026-05-04",
    trackNumber: 1,
    totalTracks: 10,
    discNumber: 1,
    totalDiscs: 1,
    isrc: "USRC17607839",
    itemType: "track",
    albumType: "album",
    tidalId: "tidal-1",
    qobuzId: "qobuz-1",
    deezerId: "deezer-1",
    spotifyId: "spotify:track:1",
    externalLinks: { tidal: "https://tidal.example/1" },
    label: "Label",
    copyright: "Copyright",
    genre: "Pop",
    composer: "Composer",
    audioQuality: "FLAC 24-bit",
    audioModes: "DOLBY_ATMOS",
    explicit: true
  };
}

registerExtension({
  searchTracks: function(query, limit) {
    return { tracks: [track("search-1")], total: 1 };
  },
  customSearch: function(query, options) {
    var t = track("custom-1");
    t.name = "Custom " + query;
    return [t];
  },
  getHomeFeed: function() {
    return [{ id: "home-1", title: "Home", tracks: [track("home-track")] }];
  },
  getBrowseCategories: function() {
    return [{ id: "cat-1", title: "Category" }];
  },
  getTrack: function(id) {
    return track(id);
  },
  getAlbum: function(id) {
    return {
      id: id,
      name: "Album " + id,
      artists: "Artist",
      artistId: "artist-1",
      coverUrl: "https://example.test/album.jpg",
      releaseDate: "2026-05-04",
      totalTracks: 1,
      albumType: "album",
      tracks: [track("album-track")]
    };
  },
  getPlaylist: function(id) {
    return {
      id: id,
      name: "Playlist " + id,
      artists: "Owner",
      coverUrl: "https://example.test/playlist.jpg",
      totalTracks: 1,
      tracks: [track("playlist-track")]
    };
  },
  getArtist: function(id) {
    return {
      id: id,
      name: "Artist",
      imageUrl: "https://example.test/artist.jpg",
      headerImage: "https://example.test/header.jpg",
      listeners: 123,
      albums: [{ id: "album-1", name: "Album", artists: "Artist", totalTracks: 1 }],
      releases: [{ id: "release-1", name: "Release", artists: "Artist", totalTracks: 1, tracks: [track("release-track")] }],
      topTracks: [track("top-track")]
    };
  },
  enrichTrack: function(input) {
    var t = track(input.id || "enriched");
    t.name = "Enriched";
    return t;
  },
  checkAvailability: function(isrc, name, artist, ids) {
    return { available: true, reason: "ok", trackId: "download-track", skipFallback: true };
  },
  getDownloadUrl: function(id, quality) {
    return { url: "https://example.test/audio.flac", format: "flac", bitDepth: 24, sampleRate: 96000 };
  },
  download: function(id, quality, outputPath, onProgress) {
    if (onProgress) onProgress(100);
    return {
      success: true,
      filePath: "EXISTS:" + outputPath,
      alreadyExists: false,
      bitDepth: 24,
      sampleRate: 96000,
      title: "Downloaded",
      artist: "Artist",
      album: "Album",
      albumArtist: "Album Artist",
      trackNumber: 1,
      totalTracks: 10,
      discNumber: 1,
      totalDiscs: 1,
      releaseDate: "2026-05-04",
      coverUrl: "https://example.test/cover.jpg",
      isrc: "USRC17607839",
      genre: "Pop",
      label: "Label",
      copyright: "Copyright",
      composer: "Composer",
      lyricsLrc: "[00:00.00]Hello",
      decryptionKey: "001122",
      decryption: { strategy: "mp4_decryption_key", options: { kid: "1" } }
    };
  },
  fetchLyrics: function(name, artist, album, duration) {
    return { syncType: "LINE_SYNCED", provider: "coverage-ext", lines: [{ startTimeMs: 0, endTimeMs: 1000, words: "Hello" }] };
  },
  handleUrl: function(url) {
    return { type: "track", name: "Handled", coverUrl: "https://example.test/cover.jpg", track: track("url-track"), tracks: [track("url-track")], album: this.getAlbum("url-album"), artist: this.getArtist("url-artist") };
  },
  matchTrack: function(req) {
    return { matched: true, trackId: "download-track", confidence: 0.95, reason: "exact" };
  },
  postProcess: function(path, req) {
    return { success: true, newFilePath: path, bitDepth: 24, sampleRate: 96000 };
  },
  postProcessV2: function(input, metadata, hookId) {
    return { success: true, newFilePath: input.path || input.uri, newFileUri: input.uri || "", bitDepth: 24, sampleRate: 96000 };
  }
});
`

func mustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	return data
}

func buildID3v23Tag(frames ...[]byte) []byte {
	body := bytes.Join(frames, nil)
	header := []byte{'I', 'D', '3', 3, 0, 0, 0, 0, 0, 0}
	copy(header[6:10], syncsafeBytes(len(body)))
	return append(header, body...)
}

func id3TextFrame(id, value string) []byte {
	return id3v23Frame(id, append([]byte{3}, []byte(value)...))
}

func id3CommentFrame(id, value string) []byte {
	payload := append([]byte{3, 'e', 'n', 'g', 0}, []byte(value)...)
	return id3v23Frame(id, payload)
}

func id3UserTextFrame(id, desc, value string) []byte {
	payload := append([]byte{3}, []byte(desc)...)
	payload = append(payload, 0)
	payload = append(payload, []byte(value)...)
	return id3v23Frame(id, payload)
}

func id3v23Frame(id string, payload []byte) []byte {
	frame := make([]byte, 10+len(payload))
	copy(frame[0:4], id)
	binary.BigEndian.PutUint32(frame[4:8], uint32(len(payload)))
	copy(frame[10:], payload)
	return frame
}

func buildID3v22Tag(frames ...[]byte) []byte {
	body := bytes.Join(frames, nil)
	header := []byte{'I', 'D', '3', 2, 0, 0, 0, 0, 0, 0}
	copy(header[6:10], syncsafeBytes(len(body)))
	return append(header, body...)
}

func id3v22TextFrame(id, value string) []byte {
	return id3v22Frame(id, append([]byte{3}, []byte(value)...))
}

func id3v22CommentFrame(id, value string) []byte {
	payload := append([]byte{3, 'e', 'n', 'g', 0}, []byte(value)...)
	return id3v22Frame(id, payload)
}

func id3v22Frame(id string, payload []byte) []byte {
	frame := make([]byte, 6+len(payload))
	copy(frame[0:3], id)
	size := len(payload)
	frame[3] = byte(size >> 16)
	frame[4] = byte(size >> 8)
	frame[5] = byte(size)
	copy(frame[6:], payload)
	return frame
}

func syncsafeBytes(size int) []byte {
	return []byte{
		byte((size >> 21) & 0x7f),
		byte((size >> 14) & 0x7f),
		byte((size >> 7) & 0x7f),
		byte(size & 0x7f),
	}
}

func buildID3v1Tag(title, artist, album, year string, track, genre byte) []byte {
	tag := make([]byte, 128)
	copy(tag[0:3], "TAG")
	copyPadded(tag[3:33], title)
	copyPadded(tag[33:63], artist)
	copyPadded(tag[63:93], album)
	copyPadded(tag[93:97], year)
	tag[125] = 0
	tag[126] = track
	tag[127] = genre
	return tag
}

func copyPadded(dst []byte, value string) {
	for i := range dst {
		dst[i] = ' '
	}
	copy(dst, value)
}

func writeExportCueFixture(t *testing.T, dir string) (string, string) {
	t.Helper()
	audioPath := filepath.Join(dir, "exports.wav")
	if err := os.WriteFile(audioPath, []byte("audio"), 0600); err != nil {
		t.Fatalf("write export audio: %v", err)
	}
	cuePath := filepath.Join(dir, "exports.cue")
	cue := "PERFORMER \"Artist\"\nTITLE \"Album\"\nFILE \"exports.wav\" WAVE\n  TRACK 01 AUDIO\n    TITLE \"Song\"\n    INDEX 01 00:00:00\n"
	if err := os.WriteFile(cuePath, []byte(cue), 0600); err != nil {
		t.Fatalf("write export cue: %v", err)
	}
	return cuePath, audioPath
}

func escapeJSONPath(path string) string {
	data, _ := json.Marshal(path)
	return strings.Trim(string(data), `"`)
}

func fakeDeezerResponse(path, rawQuery string) string {
	switch {
	case path == "/2.0/search/track":
		if strings.Contains(rawQuery, "MISSING") {
			return `{"data":[]}`
		}
		return `{"data":[` + fakeDeezerTrackJSON(101, true) + `]}`
	case path == "/2.0/search/artist":
		return `{"data":[{"id":301,"name":"Artist","picture_xl":"artist-xl","nb_fan":123}]}`
	case path == "/2.0/search/album":
		return `{"data":[{"id":201,"title":"Album","cover_xl":"album-xl","nb_tracks":2,"release_date":"2026-05-04","record_type":"compile","artist":{"id":301,"name":"Artist"}}]}`
	case path == "/2.0/search/playlist":
		return `{"data":[{"id":401,"title":"Playlist","picture_xl":"playlist-xl","nb_tracks":2,"user":{"name":"Owner"}}]}`
	case path == "/2.0/track/101", path == "/2.0/track/isrc:USRC17607839":
		return fakeDeezerTrackJSON(101, true)
	case path == "/2.0/track/102":
		return fakeDeezerTrackJSON(102, true)
	case path == "/2.0/track/isrc:MISSING":
		return `{"id":0}`
	case path == "/2.0/album/201":
		return `{"id":201,"title":"Album","cover_xl":"album-xl","release_date":"2026-05-04","nb_tracks":2,"record_type":"compile","label":"Label","copyright":"Copyright","genres":{"data":[{"name":"Pop"},{"name":"Dance"}]},"artist":{"id":301,"name":"Album Artist"},"contributors":[{"name":"Contributor A"},{"name":"Contributor B"}],"tracks":{"data":[` + fakeDeezerTrackJSON(101, true) + `,` + fakeDeezerTrackJSON(102, false) + `]}}`
	case path == "/2.0/artist/301":
		return `{"id":301,"name":"Artist","picture_xl":"artist-xl","nb_fan":123,"nb_album":1}`
	case path == "/2.0/artist/301/albums":
		return `{"data":[{"id":201,"title":"Album","release_date":"2026-05-04","nb_tracks":0,"cover_xl":"album-xl","record_type":"compile"}]}`
	case path == "/2.0/artist/301/related":
		return `{"data":[{"id":302,"name":"Related","picture_xl":"related-xl","nb_fan":10}]}`
	case path == "/2.0/playlist/401":
		return `{"id":401,"title":"Playlist","picture_xl":"playlist-xl","nb_tracks":2,"creator":{"name":"Owner"},"tracks":{"data":[` + fakeDeezerTrackJSON(101, true) + `,` + fakeDeezerTrackJSON(102, false) + `]}}`
	default:
		return ""
	}
}

func fakeDeezerTrackJSON(id int, withISRC bool) string {
	isrc := ""
	if withISRC {
		isrc = `,"isrc":"USRC17607839"`
		if id == 102 {
			isrc = `,"isrc":"USRC17607840"`
		}
	}
	return fmt.Sprintf(`{"id":%d,"title":"Track %d","duration":180,"track_position":%d,"disk_number":1%s,"link":"https://deezer.test/track/%d","release_date":"2026-05-04","artist":{"id":301,"name":"Artist"},"contributors":[{"name":"Contributor A"},{"name":"Contributor B"}],"album":{"id":201,"title":"Album","cover_xl":"album-xl","release_date":"2026-05-04","record_type":"album"}}`, id, id, id-100, isrc, id)
}

func createTestExtensionPackage(t *testing.T, path, name, version, js string, extraFiles map[string]string) {
	t.Helper()
	out, err := os.Create(path)
	if err != nil {
		t.Fatalf("create extension package: %v", err)
	}
	defer out.Close()

	zw := zip.NewWriter(out)
	defer zw.Close()

	manifest := fmt.Sprintf(`{
		"name": %q,
		"displayName": %q,
		"version": %q,
		"description": "Packaged test extension",
		"type": ["metadata_provider", "download_provider", "lyrics_provider"],
		"permissions": {"network": ["example.test"], "storage": true, "file": true},
		"icon": "icon.png",
		"settings": [{"key":"quality","type":"string","label":"Quality"}],
		"qualityOptions": [{"id":"lossless","label":"Lossless","description":"Lossless"}],
		"searchBehavior": {"enabled": true, "placeholder": "Search", "primary": true},
		"urlHandler": {"enabled": true, "patterns": ["https://example.test/"]},
		"trackMatching": {"customMatching": true},
		"postProcessing": {"enabled": true, "hooks": [{"id":"hook","name":"Hook"}]},
		"serviceHealth": [{"id":"main","url":"https://example.test/health"}],
		"capabilities": {"homeFeed": true}
	}`, name, name, version)

	for fileName, content := range map[string]string{
		"manifest.json": manifest,
		"index.js":      js,
		"icon.png":      "png",
	} {
		writer, err := zw.Create(fileName)
		if err != nil {
			t.Fatalf("zip create %s: %v", fileName, err)
		}
		if _, err := writer.Write([]byte(content)); err != nil {
			t.Fatalf("zip write %s: %v", fileName, err)
		}
	}
	for fileName, content := range extraFiles {
		writer, err := zw.Create(fileName)
		if err != nil {
			t.Fatalf("zip create extra %s: %v", fileName, err)
		}
		if _, err := writer.Write([]byte(content)); err != nil {
			t.Fatalf("zip write extra %s: %v", fileName, err)
		}
	}
}
