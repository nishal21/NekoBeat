package gobackend

import (
	"path/filepath"
	"testing"
)

func TestVerifiedDownloadResumeTriesSelectedProviderBeforeMetadata(t *testing.T) {
	resetPreparedDownloadRequestCacheForTest()
	t.Cleanup(resetPreparedDownloadRequestCacheForTest)

	metadataExt := newTestLoadedExtension(t, ExtensionTypeMetadataProvider)
	metadataExt.ID = "resume-metadata"
	metadataExt.Manifest.Name = metadataExt.ID
	downloadExt := newTestLoadedExtension(t, ExtensionTypeDownloadProvider)
	downloadExt.ID = "resume-download"
	downloadExt.Manifest.Name = downloadExt.ID

	manager := getExtensionManager()
	manager.mu.Lock()
	previousExtensions := manager.extensions
	manager.extensions = map[string]*loadedExtension{
		metadataExt.ID: metadataExt,
		downloadExt.ID: downloadExt,
	}
	manager.mu.Unlock()
	t.Cleanup(func() {
		teardownExtension(metadataExt)
		teardownExtension(downloadExt)
		manager.mu.Lock()
		manager.extensions = previousExtensions
		manager.mu.Unlock()
	})

	req := DownloadRequest{
		ItemID:         "resume-item",
		Service:        downloadExt.ID,
		Source:         metadataExt.ID,
		SpotifyID:      "spotify:track:1",
		TrackName:      "Original Song",
		ArtistName:     "Artist",
		AlbumName:      "Album",
		ReleaseDate:    "2026-05-04",
		OutputDir:      t.TempDir(),
		OutputExt:      ".flac",
		FilenameFormat: "{title}",
		Quality:        "LOSSLESS",
		UseFallback:    false,
	}
	key := downloadPreparationKey(req)
	cacheUnpreparedDownloadRequest(key, req)

	resp, err := DownloadWithExtensionFallback(req)
	if err != nil {
		t.Fatalf("DownloadWithExtensionFallback: %v", err)
	}
	if resp == nil || !resp.Success {
		t.Fatalf("resume response = %#v", resp)
	}
	if got := filepath.Base(resp.FilePath); got != "Original Song.flac" {
		t.Fatalf("resume ran metadata enrichment before download: file = %q", got)
	}
}

func TestVerifiedDownloadResumeReusesPreparedMetadata(t *testing.T) {
	resetPreparedDownloadRequestCacheForTest()
	t.Cleanup(resetPreparedDownloadRequestCacheForTest)

	metadataExt := newTestLoadedExtension(t, ExtensionTypeMetadataProvider)
	metadataExt.ID = "prepared-metadata"
	metadataExt.Manifest.Name = metadataExt.ID
	downloadExt := newTestLoadedExtension(t, ExtensionTypeDownloadProvider)
	downloadExt.ID = "prepared-download"
	downloadExt.Manifest.Name = downloadExt.ID

	manager := getExtensionManager()
	manager.mu.Lock()
	previousExtensions := manager.extensions
	manager.extensions = map[string]*loadedExtension{
		metadataExt.ID: metadataExt,
		downloadExt.ID: downloadExt,
	}
	manager.mu.Unlock()
	t.Cleanup(func() {
		teardownExtension(metadataExt)
		teardownExtension(downloadExt)
		manager.mu.Lock()
		manager.extensions = previousExtensions
		manager.mu.Unlock()
	})

	req := DownloadRequest{
		ItemID:         "prepared-item",
		Service:        downloadExt.ID,
		Source:         metadataExt.ID,
		SpotifyID:      "spotify:track:2",
		TrackName:      "Original Song",
		ArtistName:     "Artist",
		AlbumName:      "Album",
		ReleaseDate:    "2026-05-04",
		OutputDir:      t.TempDir(),
		OutputExt:      ".flac",
		FilenameFormat: "{title}",
		Quality:        "LOSSLESS",
		UseFallback:    false,
	}
	key := downloadPreparationKey(req)
	prepared := req
	prepared.TrackName = "Prepared Song"
	cachePreparedDownloadRequest(key, prepared)

	resp, err := DownloadWithExtensionFallback(req)
	if err != nil {
		t.Fatalf("DownloadWithExtensionFallback: %v", err)
	}
	if resp == nil || !resp.Success {
		t.Fatalf("prepared response = %#v", resp)
	}
	if got := filepath.Base(resp.FilePath); got != "Prepared Song.flac" {
		t.Fatalf("prepared metadata was not reused: file = %q", got)
	}
}
