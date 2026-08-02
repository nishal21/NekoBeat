package gobackend

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestAPETagReadWriteMergeAndMetadataConversion(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sample.ape")
	if err := os.WriteFile(path, []byte("audio-data"), 0600); err != nil {
		t.Fatalf("write sample: %v", err)
	}

	metadata := &AudioMetadata{
		Title:               "Song",
		Artist:              "Artist",
		Album:               "Album",
		AlbumArtist:         "Album Artist",
		Genre:               "Pop",
		Date:                "2026",
		TrackNumber:         3,
		TotalTracks:         12,
		DiscNumber:          1,
		TotalDiscs:          2,
		ISRC:                "USRC17607839",
		Lyrics:              "lyrics",
		Label:               "Label",
		Copyright:           "Copyright",
		Composer:            "Composer",
		Comment:             "Comment",
		ReplayGainTrackGain: "-6.50 dB",
		ReplayGainTrackPeak: "0.98",
		ReplayGainAlbumGain: "-5.00 dB",
		ReplayGainAlbumPeak: "0.99",
	}
	items := AudioMetadataToAPEItems(metadata)
	if len(items) == 0 {
		t.Fatal("expected APE items")
	}

	tag := &APETag{Items: append(items, APETagItem{Key: "Custom", Value: "Keep"})}
	if err := WriteAPETags(path, tag); err != nil {
		t.Fatalf("WriteAPETags: %v", err)
	}

	readTag, err := ReadAPETags(path)
	if err != nil {
		t.Fatalf("ReadAPETags: %v", err)
	}
	if readTag.Version != apeTagVersion2 {
		t.Fatalf("version = %d", readTag.Version)
	}
	readMetadata := APETagToAudioMetadata(readTag)
	if readMetadata.Title != "Song" || readMetadata.TrackNumber != 3 || readMetadata.TotalTracks != 12 {
		t.Fatalf("metadata = %#v", readMetadata)
	}

	readerTag, err := ReadAPETagsFromReader(bytes.NewReader(mustReadFile(t, path)), int64(len(mustReadFile(t, path))))
	if err != nil {
		t.Fatalf("ReadAPETagsFromReader: %v", err)
	}
	if len(readerTag.Items) != len(readTag.Items) {
		t.Fatalf("reader items = %d, file items = %d", len(readerTag.Items), len(readTag.Items))
	}

	override := apeKeysFromFields(map[string]string{"title": "", "lyrics": "", "disc_total": ""})
	merged := MergeAPEItems(readTag.Items, []APETagItem{{Key: "Title", Value: "New Song"}}, override)
	mergedMeta := APETagToAudioMetadata(&APETag{Items: merged})
	if mergedMeta.Title != "New Song" {
		t.Fatalf("merged title = %q", mergedMeta.Title)
	}
	if mergedMeta.Lyrics != "" {
		t.Fatalf("expected lyrics cleared, got %q", mergedMeta.Lyrics)
	}

	if err := WriteAPETags(path, &APETag{Items: []APETagItem{{Key: "Title", Value: "Replacement"}}}); err != nil {
		t.Fatalf("replace APE tags: %v", err)
	}
	replaced, err := ReadAPETags(path)
	if err != nil {
		t.Fatalf("read replacement: %v", err)
	}
	if got := APETagToAudioMetadata(replaced).Title; got != "Replacement" {
		t.Fatalf("replacement title = %q", got)
	}

	if _, err := marshalAPETag(nil); err == nil {
		t.Fatal("expected empty tag error")
	}
	if _, err := ReadAPETags(filepath.Join(dir, "missing.ape")); err == nil {
		t.Fatal("expected missing file error")
	}
	if _, err := ReadAPETagsFromReader(bytes.NewReader([]byte("short")), 5); err == nil {
		t.Fatal("expected small reader error")
	}
}

func TestAPETagInvalidFooterBranches(t *testing.T) {
	footer := buildAPEHeaderFooter(9999, apeTagHeaderSize, 1, 0)
	if _, err := parseAPETagFromFooter(bytes.NewReader(footer), int64(len(footer)), 0, footer); err == nil {
		t.Fatal("expected unsupported version")
	}

	footer = buildAPEHeaderFooter(apeTagVersion2, apeTagHeaderSize-1, 1, 0)
	if _, err := parseAPETagFromFooter(bytes.NewReader(footer), int64(len(footer)), 0, footer); err == nil {
		t.Fatal("expected small tag size")
	}

	footer = buildAPEHeaderFooter(apeTagVersion2, apeTagHeaderSize, 1001, 0)
	if _, err := parseAPETagFromFooter(bytes.NewReader(footer), int64(len(footer)), 0, footer); err == nil {
		t.Fatal("expected too many items")
	}

	footer = buildAPEHeaderFooter(apeTagVersion2, apeTagHeaderSize, 1, apeTagFlagHeader)
	if _, err := parseAPETagFromFooter(bytes.NewReader(footer), int64(len(footer)), 0, footer); err == nil {
		t.Fatal("expected header flag error")
	}
}
