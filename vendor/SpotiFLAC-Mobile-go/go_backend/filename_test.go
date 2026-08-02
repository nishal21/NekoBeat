package gobackend

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestBuildFilenameFromTemplate_WithRawTrackAndDisc(t *testing.T) {
	metadata := map[string]any{
		"title":  "Song Name",
		"artist": "Artist Name",
		"album":  "Album Name",
		"track":  1,
		"disc":   2,
		"year":   "2025",
	}

	formatted := buildFilenameFromTemplate(
		"{artist} - {track} - {track_raw} - d{disc} - d{disc_raw} - {title}",
		metadata,
	)

	expected := "Artist Name - 01 - 1 - d2 - d2 - Song Name"
	if formatted != expected {
		t.Fatalf("expected %q, got %q", expected, formatted)
	}
}

func TestBuildFilenameFromTemplate_RawPlaceholdersEmptyWhenZero(t *testing.T) {
	metadata := map[string]any{
		"title":  "Song Name",
		"artist": "Artist Name",
		"track":  0,
		"disc":   0,
	}

	formatted := buildFilenameFromTemplate("{track_raw}-{disc_raw}-{title}", metadata)
	expected := "--Song Name"
	if formatted != expected {
		t.Fatalf("expected %q, got %q", expected, formatted)
	}
}

func TestBuildFilenameFromTemplate_InlineNumberFormatting(t *testing.T) {
	metadata := map[string]any{
		"track": 3,
		"disc":  2,
	}

	formatted := buildFilenameFromTemplate("{track:1}-{track:02}-{disc:03}", metadata)
	expected := "3-03-002"
	if formatted != expected {
		t.Fatalf("expected %q, got %q", expected, formatted)
	}
}

func TestBuildFilenameFromTemplate_PlaylistPositionFormatting(t *testing.T) {
	metadata := map[string]any{
		"playlist_position": 4,
		"artist":            "Artist Name",
		"title":             "Song Name",
	}

	formatted := buildFilenameFromTemplate(
		"{playlist_position:02} - {artist} - {title}",
		metadata,
	)
	expected := "04 - Artist Name - Song Name"
	if formatted != expected {
		t.Fatalf("expected %q, got %q", expected, formatted)
	}
}

func TestBuildFilenameFromTemplate_QualityVariant(t *testing.T) {
	metadata := map[string]any{
		"artist":  "Artist Name",
		"title":   "Song Name",
		"quality": "HI_RES_LOSSLESS",
	}

	formatted := buildFilenameFromTemplate(
		"{artist} - {title} - {quality}",
		metadata,
	)
	if formatted != "Artist Name - Song Name - HI_RES_LOSSLESS" {
		t.Fatalf("unexpected quality filename: %q", formatted)
	}
}

func TestBuildFilenameFromTemplate_QualityVariantStagingToken(t *testing.T) {
	metadata := map[string]any{
		"artist":          "Artist Name",
		"title":           "Song Name",
		"quality_variant": "qv_12345678",
	}

	formatted := buildFilenameFromTemplate(
		"{artist} - {title} - {quality_variant}",
		metadata,
	)
	if formatted != "Artist Name - Song Name - qv_12345678" {
		t.Fatalf("unexpected quality variant filename: %q", formatted)
	}
}

func TestBuildDownloadFilename_ProvidesRequestedQuality(t *testing.T) {
	filename := buildDownloadFilename(DownloadRequest{
		TrackName:      "Song Name",
		ArtistName:     "Artist Name",
		FilenameFormat: "{artist} - {title} - {quality}",
		Quality:        "LOSSLESS",
		OutputExt:      ".flac",
	})

	if filename != "Artist Name - Song Name - LOSSLESS.flac" {
		t.Fatalf("unexpected download filename: %q", filename)
	}
}

func TestBuildDownloadFilename_PreservesVariantTokenWhenTruncated(t *testing.T) {
	filename := buildDownloadFilename(DownloadRequest{
		TrackName:      strings.Repeat("Very Long Song ", 30),
		ArtistName:     "Artist Name",
		FilenameFormat: "{artist} - {title} - {quality_variant}",
		QualityVariant: "qv_12345678",
		OutputExt:      ".flac",
	})

	if !strings.Contains(filename, "qv_12345678") {
		t.Fatalf("quality variant token was truncated: %q", filename)
	}
	if len(strings.TrimSuffix(filename, ".flac")) > maxSanitizedFilenameBytes {
		t.Fatalf("filename base exceeds limit: %d bytes", len(filename))
	}
}

func TestBuildFilenameFromTemplate_DateStrftimeFormatting(t *testing.T) {
	metadata := map[string]any{
		"artist":       "Artist Name",
		"title":        "Song Name",
		"release_date": "2024-03-09",
		"track_number": 7,
		"disc_number":  1,
	}

	formatted := buildFilenameFromTemplate(
		"{artist} - {track:02} - {title} - {date:%Y-%m-%d} - {year}",
		metadata,
	)
	expected := "Artist Name - 07 - Song Name - 2024-03-09 - 2024"
	if formatted != expected {
		t.Fatalf("expected %q, got %q", expected, formatted)
	}
}

func TestBuildFilenameFromTemplate_DateStrftimeFormattingWithYearOnly(t *testing.T) {
	metadata := map[string]any{
		"artist": "Artist Name",
		"title":  "Song Name",
		"date":   "2019",
	}

	formatted := buildFilenameFromTemplate("{date:%Y}-{date:%m}-{date:%d}", metadata)
	expected := "2019-01-01"
	if formatted != expected {
		t.Fatalf("expected %q, got %q", expected, formatted)
	}
}

func TestSanitizeFilenameMatchesDesktopSpacingBehavior(t *testing.T) {
	got := sanitizeFilename(`  "Text In Quotes"?%* / Demo  `)
	want := "Text In Quotes % Demo"
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestSanitizeFilenameFallsBackToUnknownWhenEmpty(t *testing.T) {
	got := sanitizeFilename(`<>:"/\|?*`)
	if got != "Unknown" {
		t.Fatalf("expected %q, got %q", "Unknown", got)
	}
}

func TestSanitizeFilenameTruncatesWithoutSplittingUTF8(t *testing.T) {
	got := sanitizeFilename(strings.Repeat("あ", 80))
	if !utf8.ValidString(got) {
		t.Fatalf("sanitizeFilename returned invalid UTF-8: %q", got)
	}
	if len(got) > 200 {
		t.Fatalf("sanitizeFilename length = %d, want <= 200", len(got))
	}
}
