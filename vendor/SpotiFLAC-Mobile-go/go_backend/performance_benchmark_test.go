package gobackend

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/dop251/goja"
)

var (
	benchmarkStringSink string
	benchmarkIntSink    int64
	benchmarkScanSink   *LibraryScanResult
)

func BenchmarkGojaProviderInvocation(b *testing.B) {
	vm := goja.New()
	if _, err := vm.RunString(`var extension = { searchTracks: function(query, limit) { return query.length + limit; } };`); err != nil {
		b.Fatal(err)
	}

	b.Run("direct_callable", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			value, err := invokeExtensionMethod(vm, "searchTracks", "lossless", 25)
			if err != nil {
				b.Fatal(err)
			}
			benchmarkIntSink = value.ToInteger()
		}
	})

	b.Run("compile_source", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			script := fmt.Sprintf(`extension.searchTracks(%q, %d)`, "lossless", 25)
			value, err := vm.RunString(script)
			if err != nil {
				b.Fatal(err)
			}
			benchmarkIntSink = value.ToInteger()
		}
	})
}

func BenchmarkCheckFilesExistBatch(b *testing.B) {
	const trackCount = 1000
	dir := b.TempDir()
	idx := &ISRCIndex{
		index:     make(map[string]string, trackCount),
		files:     make(map[string]isrcFileEntry),
		outputDir: dir,
	}
	tracks := make([]map[string]string, trackCount)
	for i := 0; i < trackCount; i++ {
		isrc := fmt.Sprintf("USAA%08d", i)
		idx.index[isrc] = filepath.Join(dir, fmt.Sprintf("%d.flac", i))
		tracks[i] = map[string]string{
			"isrc":        isrc,
			"track_name":  fmt.Sprintf("Track %d", i),
			"artist_name": "Artist",
		}
	}
	idx.buildTime.Store(time.Now().UnixNano())
	isrcIndexCacheMu.Lock()
	isrcIndexCache[dir] = idx
	isrcIndexCacheMu.Unlock()
	b.Cleanup(func() { InvalidateISRCCache(dir) })
	payload, err := json.Marshal(tracks)
	if err != nil {
		b.Fatal(err)
	}

	b.ReportAllocs()
	b.SetBytes(int64(len(payload)))
	b.ResetTimer()
	for b.Loop() {
		result, err := CheckFilesExistParallel(dir, string(payload))
		if err != nil {
			b.Fatal(err)
		}
		benchmarkStringSink = result
	}
}

func BenchmarkLibraryScanFLACSinglePass(b *testing.B) {
	dir := b.TempDir()
	path := filepath.Join(dir, "track.flac")
	cover := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3}
	writeSinglePassTestFlac(b, path, cover)
	cacheDir := filepath.Join(dir, "covers")

	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		result := &LibraryScanResult{FilePath: path, Format: "flac"}
		var err error
		benchmarkScanSink, err = scanFLACFileWithCoverCache(path, result, "", cacheDir, "stable-key")
		if err != nil {
			b.Fatal(err)
		}
	}
}
