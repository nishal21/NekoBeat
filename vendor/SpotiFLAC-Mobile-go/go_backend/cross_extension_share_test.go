package gobackend

import "testing"

func TestCrossExtensionShareUsesAlbumCollectionItems(t *testing.T) {
	ext := &loadedExtension{
		Manifest: &ExtensionManifest{
			Capabilities: map[string]any{
				"shareUrlTemplates": map[string]any{
					"album": "https://music.apple.com/us/album/{id}",
				},
			},
		},
	}
	tracks := []ExtTrackMetadata{
		{
			ID:       "1440783617",
			Name:     "Nevermind",
			Artists:  "Nirvana",
			ItemType: "album",
		},
	}

	best := bestAlbumTrack(tracks, "Nevermind", "Nirvana")
	if best == nil {
		t.Fatal("expected album collection item to match")
	}
	if url := resolveCollectionShareURL(ext, "album", best); url != "https://music.apple.com/us/album/1440783617" {
		t.Fatalf("album share URL = %q", url)
	}
}

func TestCrossExtensionShareUsesArtistCollectionItems(t *testing.T) {
	ext := &loadedExtension{
		Manifest: &ExtensionManifest{
			Capabilities: map[string]any{
				"shareUrlTemplates": map[string]any{
					"artist": "https://music.youtube.com/browse/{id}",
				},
			},
		},
	}
	tracks := []ExtTrackMetadata{
		{
			ID:       "UCrPe3hLA51968GwxHSZ1llw",
			Name:     "Nirvana",
			ItemType: "artist",
		},
	}

	best := bestArtistTrack(tracks, "Nirvana")
	if best == nil {
		t.Fatal("expected artist collection item to match")
	}
	if url := resolveCollectionShareURL(ext, "artist", best); url != "https://music.youtube.com/browse/UCrPe3hLA51968GwxHSZ1llw" {
		t.Fatalf("artist share URL = %q", url)
	}
}

func TestCrossExtensionShareCacheKeyIsProviderOrderStable(t *testing.T) {
	apple := &extensionProviderWrapper{
		extension: &loadedExtension{
			ID:        "apple",
			SourceDir: "/extensions/apple",
			Manifest:  &ExtensionManifest{DisplayName: "Apple Music"},
		},
	}
	qobuz := &extensionProviderWrapper{
		extension: &loadedExtension{
			ID:        "qobuz",
			SourceDir: "/extensions/qobuz",
			Manifest:  &ExtensionManifest{DisplayName: "Qobuz"},
		},
	}

	first := crossExtensionShareCacheKey("Nevermind", "Nirvana", "album", "spotify", []*extensionProviderWrapper{apple, qobuz})
	second := crossExtensionShareCacheKey("Nevermind", "Nirvana", "album", "spotify", []*extensionProviderWrapper{qobuz, apple})
	if first != second {
		t.Fatalf("cache key should not depend on provider order:\n%s\n%s", first, second)
	}
}

func TestCrossExtensionShareCacheableSkipsTransientErrors(t *testing.T) {
	cacheable := []CrossExtensionShareResult{
		{ExtensionID: "apple", Found: true, URL: "https://music.apple.com/us/album/1"},
		{ExtensionID: "qobuz", Error: "album not found"},
		{ExtensionID: "tidal", Error: "no results"},
	}
	if !crossExtensionShareResultsCacheable(cacheable) {
		t.Fatal("expected found and deterministic not-found results to be cacheable")
	}

	transient := []CrossExtensionShareResult{
		{ExtensionID: "apple", Found: true, URL: "https://music.apple.com/us/album/1"},
		{ExtensionID: "qobuz", Error: "request failed: timeout"},
	}
	if crossExtensionShareResultsCacheable(transient) {
		t.Fatal("expected transient extension errors to skip cache")
	}
}
