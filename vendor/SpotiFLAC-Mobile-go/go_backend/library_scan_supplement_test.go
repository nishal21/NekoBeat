package gobackend

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLibraryScanFullIncrementalAndMetadataFallbacks(t *testing.T) {
	dir := t.TempDir()
	albumDir := filepath.Join(dir, "Album")
	if err := os.MkdirAll(albumDir, 0755); err != nil {
		t.Fatal(err)
	}
	mp3Path := filepath.Join(albumDir, "Artist - Song.mp3")
	if err := os.WriteFile(mp3Path, []byte("not really mp3"), 0600); err != nil {
		t.Fatal(err)
	}
	numberedPath := filepath.Join(albumDir, "01 - Intro.ogg")
	if err := os.WriteFile(numberedPath, []byte("not really ogg"), 0600); err != nil {
		t.Fatal(err)
	}
	apePath := filepath.Join(albumDir, "tagged.ape")
	if err := os.WriteFile(apePath, []byte("audio"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := WriteAPETags(apePath, &APETag{Items: AudioMetadataToAPEItems(&AudioMetadata{
		Title:       "Tagged",
		Artist:      "APE Artist",
		Album:       "APE Album",
		TrackNumber: 2,
		TotalTracks: 3,
		Date:        "2026",
		Genre:       "Pop",
		Composer:    "Composer",
	})}); err != nil {
		t.Fatalf("write ape tags: %v", err)
	}
	cuePath, _ := writeExportCueFixture(t, albumDir)
	if err := os.WriteFile(filepath.Join(albumDir, "ignored.txt"), []byte("ignore"), 0600); err != nil {
		t.Fatal(err)
	}
	legacyPartialPath := filepath.Join(albumDir, "Artist - Song.partial.flac")
	if err := os.WriteFile(legacyPartialPath, []byte("partial flac"), 0600); err != nil {
		t.Fatal(err)
	}
	newPartialPath := filepath.Join(albumDir, "Artist - Song.flac.partial")
	if err := os.WriteFile(newPartialPath, []byte("partial flac"), 0600); err != nil {
		t.Fatal(err)
	}

	files, err := collectLibraryAudioFiles(dir, make(chan struct{}))
	if err != nil {
		t.Fatalf("collectLibraryAudioFiles: %v", err)
	}
	if len(files) < 4 {
		t.Fatalf("files = %#v", files)
	}
	for _, file := range files {
		if file.path == legacyPartialPath || file.path == newPartialPath {
			t.Fatalf("staging file should be ignored: %#v", files)
		}
	}
	cancelCh := make(chan struct{})
	close(cancelCh)
	if _, err := collectLibraryAudioFiles(dir, cancelCh); err == nil {
		t.Fatal("expected cancelled collect")
	}

	jsonText, err := ScanLibraryFolder(dir)
	if err != nil {
		t.Fatalf("ScanLibraryFolder: %v", err)
	}
	var results []LibraryScanResult
	if err := json.Unmarshal([]byte(jsonText), &results); err != nil {
		t.Fatalf("decode scan results: %v", err)
	}
	if len(results) < 4 {
		t.Fatalf("scan results = %#v", results)
	}
	foundTagged := false
	for _, result := range results {
		if result.FilePath == apePath {
			foundTagged = result.TrackName == "Tagged" && result.ArtistName == "APE Artist"
		}
	}
	if !foundTagged {
		t.Fatalf("tagged APE not found in %#v", results)
	}
	if progress := GetLibraryScanProgress(); !strings.Contains(progress, `"IsComplete":true`) && !strings.Contains(progress, `"is_complete":true`) {
		t.Fatalf("progress = %s", progress)
	}

	metaJSON, err := ReadAudioMetadataWithDisplayName(mp3Path, "Display Artist - Display Song.mp3")
	if err != nil {
		t.Fatalf("ReadAudioMetadataWithDisplayName: %v", err)
	}
	if !strings.Contains(metaJSON, "Display Song") {
		t.Fatalf("metadata json = %s", metaJSON)
	}
	noExtPath := filepath.Join(albumDir, "noext")
	if err := os.WriteFile(noExtPath, []byte("audio"), 0600); err != nil {
		t.Fatal(err)
	}
	noExtJSON, err := ReadAudioMetadataWithDisplayNameAndCoverCacheKey(noExtPath, "Artist - No Ext.mp3", "cache-key")
	if err != nil {
		t.Fatalf("ReadAudioMetadataWithDisplayNameAndCoverCacheKey: %v", err)
	}
	if !strings.Contains(noExtJSON, "No Ext") {
		t.Fatalf("no ext metadata = %s", noExtJSON)
	}

	existing := map[string]int64{}
	for _, file := range files {
		existing[file.path] = file.modTime
	}
	if info, err := os.Stat(cuePath); err == nil {
		existing[cuePath+"#track01"] = info.ModTime().UnixMilli()
	}
	incJSON, err := scanLibraryFolderIncrementalWithExistingFiles(dir, existing)
	if err != nil {
		t.Fatalf("incremental existing: %v", err)
	}
	var inc IncrementalScanResult
	if err := json.Unmarshal([]byte(incJSON), &inc); err != nil {
		t.Fatalf("decode incremental: %v", err)
	}
	if inc.SkippedCount == 0 {
		t.Fatalf("incremental = %#v", inc)
	}
	if _, err := ScanLibraryFolderIncremental("", "{}"); err == nil {
		t.Fatal("expected empty incremental folder error")
	}
	if incJSON, err := ScanLibraryFolderIncremental(dir, `not-json`); err != nil || incJSON == "" {
		t.Fatalf("incremental invalid existing JSON = %q/%v", incJSON, err)
	}

	snapshot := filepath.Join(dir, "snapshot.txt")
	if err := os.WriteFile(snapshot, []byte("bad\n123\t"+mp3Path+"\nnotint\tpath\n999\t"+filepath.Join(dir, "deleted.mp3")+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	fromSnapshot, err := ScanLibraryFolderIncrementalFromSnapshot(dir, snapshot)
	if err != nil {
		t.Fatalf("snapshot incremental: %v", err)
	}
	if !strings.Contains(fromSnapshot, "deleted.mp3") {
		t.Fatalf("snapshot result = %s", fromSnapshot)
	}
	if _, err := ScanLibraryFolder(""); err == nil {
		t.Fatal("expected empty folder scan error")
	}
	fileInsteadOfFolder := filepath.Join(dir, "file.flac")
	if err := os.WriteFile(fileInsteadOfFolder, []byte("audio"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ScanLibraryFolder(fileInsteadOfFolder); err == nil {
		t.Fatal("expected not folder error")
	}
	CancelLibraryScan()
	SetLibraryCoverCacheDir("")
}
