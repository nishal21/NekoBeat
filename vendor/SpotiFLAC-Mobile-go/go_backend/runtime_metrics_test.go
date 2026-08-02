package gobackend

import (
	"encoding/json"
	"testing"
)

func TestGetRuntimeMetricsJSON(t *testing.T) {
	var metrics goRuntimeMetrics
	if err := json.Unmarshal([]byte(GetRuntimeMetricsJSON()), &metrics); err != nil {
		t.Fatalf("runtime metrics JSON: %v", err)
	}
	if metrics.CapturedAtUnixMS <= 0 || metrics.HeapInuseBytes == 0 || metrics.SysBytes == 0 || metrics.Goroutines <= 0 || metrics.GOMAXPROCS <= 0 {
		t.Fatalf("runtime metrics = %#v", metrics)
	}
	if metrics.HeapAllocBytes > metrics.HeapInuseBytes {
		t.Fatalf("heap alloc %d exceeds heap in-use %d", metrics.HeapAllocBytes, metrics.HeapInuseBytes)
	}
}
