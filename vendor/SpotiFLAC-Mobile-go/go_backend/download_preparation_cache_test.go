package gobackend

import (
	"testing"
	"time"
)

func resetPreparedDownloadRequestCacheForTest() {
	preparedDownloadRequestsMu.Lock()
	preparedDownloadRequests = make(map[string]preparedDownloadRequestEntry)
	preparedDownloadRequestsMu.Unlock()
}

func TestPreparedDownloadRequestCache(t *testing.T) {
	t.Cleanup(resetPreparedDownloadRequestCacheForTest)
	resetPreparedDownloadRequestCacheForTest()

	fresh := DownloadRequest{
		ItemID:        "item-1",
		Service:       "provider-a",
		Source:        "source-a",
		SpotifyID:     "spotify-1",
		TrackName:     "Track",
		ArtistName:    "Artist",
		OutputDir:     "/new/output",
		OutputPath:    "/new/output/current.flac",
		OutputFD:      42,
		Quality:       "lossless",
		EmbedMetadata: true,
	}
	key := downloadPreparationKey(fresh)
	prepared := fresh
	prepared.ISRC = "USRC17607839"
	prepared.AlbumName = "Resolved Album"
	prepared.AlbumArtist = "Resolved Album Artist"
	prepared.DeezerID = "deezer-1"
	prepared.Genre = "Pop"
	prepared.OutputDir = "/stale/output"
	prepared.OutputPath = "/stale/output/old.flac"
	prepared.OutputFD = 7
	prepared.Quality = "stale-quality"
	prepared.EmbedMetadata = false
	cachePreparedDownloadRequest(key, prepared)

	got, metadataPrepared, ok := takePreparedDownloadRequest(key, fresh)
	if !ok {
		t.Fatal("expected prepared request cache hit")
	}
	if !metadataPrepared {
		t.Fatal("prepared request should be marked as metadata-prepared")
	}
	if got.ISRC != prepared.ISRC || got.AlbumName != prepared.AlbumName || got.DeezerID != prepared.DeezerID || got.Genre != prepared.Genre {
		t.Fatalf("prepared metadata was not restored: %#v", got)
	}
	if got.OutputDir != fresh.OutputDir || got.OutputPath != fresh.OutputPath || got.OutputFD != fresh.OutputFD || got.Quality != fresh.Quality || got.EmbedMetadata != fresh.EmbedMetadata {
		t.Fatalf("fresh output/settings fields were overwritten: %#v", got)
	}
	if _, _, ok := takePreparedDownloadRequest(key, fresh); ok {
		t.Fatal("prepared request should be consumed after one retry")
	}

	cacheUnpreparedDownloadRequest(key, fresh)
	_, metadataPrepared, ok = takePreparedDownloadRequest(key, fresh)
	if !ok || metadataPrepared {
		t.Fatalf("unprepared verification request = hit:%v metadataPrepared:%v", ok, metadataPrepared)
	}
}

func TestPreparedDownloadRequestCacheRejectsChangedTrackAndExpiry(t *testing.T) {
	t.Cleanup(resetPreparedDownloadRequestCacheForTest)
	resetPreparedDownloadRequestCacheForTest()

	req := DownloadRequest{
		ItemID:     "item-2",
		Service:    "provider-a",
		SpotifyID:  "spotify-2",
		TrackName:  "Track",
		ArtistName: "Artist",
	}
	key := downloadPreparationKey(req)
	cachePreparedDownloadRequest(key, req)

	changed := req
	changed.SpotifyID = "spotify-other"
	if _, _, ok := takePreparedDownloadRequest(downloadPreparationKey(changed), changed); ok {
		t.Fatal("changed track must not reuse another track's prepared metadata")
	}
	preparedDownloadRequestsMu.Lock()
	_, staleEntryExists := preparedDownloadRequests[req.ItemID]
	preparedDownloadRequestsMu.Unlock()
	if staleEntryExists {
		t.Fatal("mismatched prepared request should be discarded")
	}

	cachePreparedDownloadRequest(key, req)
	preparedDownloadRequestsMu.Lock()
	entry := preparedDownloadRequests[req.ItemID]
	entry.createdAt = time.Now().Add(-downloadPreparationCacheTTL)
	preparedDownloadRequests[req.ItemID] = entry
	preparedDownloadRequestsMu.Unlock()
	if _, _, ok := takePreparedDownloadRequest(key, req); ok {
		t.Fatal("expired prepared request must not be reused")
	}
}
