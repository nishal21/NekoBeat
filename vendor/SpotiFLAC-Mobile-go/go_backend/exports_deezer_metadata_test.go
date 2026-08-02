package gobackend

import "testing"

func TestBuildDeezerExtendedMetadataResultHandlesNil(t *testing.T) {
	result := buildDeezerExtendedMetadataResult(nil)

	if result["genre"] != "" {
		t.Fatalf("expected empty genre, got %q", result["genre"])
	}
	if result["label"] != "" {
		t.Fatalf("expected empty label, got %q", result["label"])
	}
	if result["copyright"] != "" {
		t.Fatalf("expected empty copyright, got %q", result["copyright"])
	}
}

func TestBuildDeezerExtendedMetadataResultIncludesCopyright(t *testing.T) {
	result := buildDeezerExtendedMetadataResult(&AlbumExtendedMetadata{
		Genre:     "Rock",
		Label:     "EMI",
		Copyright: "(C) Queen",
	})

	if result["genre"] != "Rock" {
		t.Fatalf("unexpected genre: %q", result["genre"])
	}
	if result["label"] != "EMI" {
		t.Fatalf("unexpected label: %q", result["label"])
	}
	if result["copyright"] != "(C) Queen" {
		t.Fatalf("unexpected copyright: %q", result["copyright"])
	}
}

func TestBuildDeezerISRCSearchResultAddsCompatibilityIDs(t *testing.T) {
	result := buildDeezerISRCSearchResult(&TrackMetadata{
		SpotifyID:   "deezer:3135556",
		Name:        "Love Of My Life",
		Artists:     "Queen",
		AlbumName:   "A Night at the Opera",
		ISRC:        "GBUM71029604",
		ReleaseDate: "1975-11-21",
	})

	if result["spotify_id"] != "deezer:3135556" {
		t.Fatalf("unexpected spotify_id: %v", result["spotify_id"])
	}
	if result["id"] != "3135556" {
		t.Fatalf("unexpected id: %v", result["id"])
	}
	if result["track_id"] != "3135556" {
		t.Fatalf("unexpected track_id: %v", result["track_id"])
	}
	if result["success"] != true {
		t.Fatalf("expected success=true, got %v", result["success"])
	}
}
