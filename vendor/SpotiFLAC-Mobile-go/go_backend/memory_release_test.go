package gobackend

import (
	"testing"
	"time"
)

func TestReleaseMemoryUnderPressureClearsDisposableCaches(t *testing.T) {
	clearCoverMemoryCache()
	coverCachePut("https://example.com/cover.jpg", []byte("cover"))
	globalLyricsCache.ClearAll()
	globalLyricsCache.Set("artist", "track", 120, &LyricsResponse{PlainLyrics: "lyrics"})

	privateIPCacheMu.Lock()
	privateIPCache["example.com"] = privateIPCacheEntry{expiresAt: time.Now().Add(time.Hour)}
	privateIPCacheMu.Unlock()
	extensionHealthCacheMu.Lock()
	extensionHealthCache["extension"] = cachedExtensionHealthResult{expiresAt: time.Now().Add(time.Hour)}
	extensionHealthCacheMu.Unlock()

	ReleaseMemoryUnderPressure()

	coverMu.Lock()
	coverEntries, coverBytes := len(coverCache), coverCacheBytes
	coverMu.Unlock()
	if coverEntries != 0 || coverBytes != 0 {
		t.Fatalf("cover cache retained %d entries/%d bytes", coverEntries, coverBytes)
	}
	if globalLyricsCache.Size() != 0 {
		t.Fatalf("lyrics cache retained %d entries", globalLyricsCache.Size())
	}
	privateIPCacheMu.RLock()
	privateEntries := len(privateIPCache)
	privateIPCacheMu.RUnlock()
	if privateEntries != 0 {
		t.Fatalf("private IP cache retained %d entries", privateEntries)
	}
	extensionHealthCacheMu.Lock()
	healthEntries := len(extensionHealthCache)
	extensionHealthCacheMu.Unlock()
	if healthEntries != 0 {
		t.Fatalf("health cache retained %d entries", healthEntries)
	}
}
