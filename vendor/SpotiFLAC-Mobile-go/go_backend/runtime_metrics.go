package gobackend

import (
	"encoding/json"
	"runtime"
	"time"
)

type goRuntimeMetrics struct {
	CapturedAtUnixMS  int64  `json:"captured_at_unix_ms"`
	HeapAllocBytes    uint64 `json:"heap_alloc_bytes"`
	HeapInuseBytes    uint64 `json:"heap_inuse_bytes"`
	HeapIdleBytes     uint64 `json:"heap_idle_bytes"`
	HeapReleasedBytes uint64 `json:"heap_released_bytes"`
	HeapObjects       uint64 `json:"heap_objects"`
	StackInuseBytes   uint64 `json:"stack_inuse_bytes"`
	SysBytes          uint64 `json:"sys_bytes"`
	NextGCBytes       uint64 `json:"next_gc_bytes"`
	LastGCUnixMS      int64  `json:"last_gc_unix_ms"`
	NumGC             uint32 `json:"num_gc"`
	PauseTotalNS      uint64 `json:"pause_total_ns"`
	Goroutines        int    `json:"goroutines"`
	GOMAXPROCS        int    `json:"gomaxprocs"`
	CgoCalls          int64  `json:"cgo_calls"`
}

// GetRuntimeMetricsJSON reports Go-owned runtime memory. Native allocations
// from Flutter, FFmpeg, SQLite, and the OS are intentionally outside it.
func GetRuntimeMetricsJSON() string {
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	metrics := goRuntimeMetrics{
		CapturedAtUnixMS:  time.Now().UnixMilli(),
		HeapAllocBytes:    stats.HeapAlloc,
		HeapInuseBytes:    stats.HeapInuse,
		HeapIdleBytes:     stats.HeapIdle,
		HeapReleasedBytes: stats.HeapReleased,
		HeapObjects:       stats.HeapObjects,
		StackInuseBytes:   stats.StackInuse,
		SysBytes:          stats.Sys,
		NextGCBytes:       stats.NextGC,
		LastGCUnixMS:      int64(stats.LastGC / uint64(time.Millisecond)),
		NumGC:             stats.NumGC,
		PauseTotalNS:      stats.PauseTotalNs,
		Goroutines:        runtime.NumGoroutine(),
		GOMAXPROCS:        runtime.GOMAXPROCS(0),
		CgoCalls:          runtime.NumCgoCall(),
	}
	payload, err := json.Marshal(metrics)
	if err != nil {
		return "{}"
	}
	return string(payload)
}
