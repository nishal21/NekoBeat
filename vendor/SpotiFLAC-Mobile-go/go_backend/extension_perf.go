package gobackend

import (
	"encoding/json"
	"time"

	"github.com/dop251/goja"
)

type extensionCallPerf struct {
	extensionID  string
	operation    string
	startedAt    time.Time
	initMs       float64
	jsMs         float64
	parseMs      float64
	items        int
	payloadBytes int
}

func newExtensionCallPerf(extensionID, operation string) *extensionCallPerf {
	if !GetLogBuffer().IsLoggingEnabled() {
		return nil
	}
	return &extensionCallPerf{
		extensionID: extensionID,
		operation:   operation,
		startedAt:   time.Now(),
	}
}

func extensionDurationMs(duration time.Duration) float64 {
	return float64(duration.Microseconds()) / 1000.0
}

func (p *extensionCallPerf) recordInit(duration time.Duration) {
	if p == nil {
		return
	}
	p.initMs += extensionDurationMs(duration)
}

func (p *extensionCallPerf) recordJS(duration time.Duration) {
	if p == nil {
		return
	}
	p.jsMs += extensionDurationMs(duration)
}

func (p *extensionCallPerf) recordParse(duration time.Duration) {
	if p == nil {
		return
	}
	p.parseMs += extensionDurationMs(duration)
}

func (p *extensionCallPerf) recordPayload(value goja.Value) {
	if p == nil || gojaValueIsEmpty(value) {
		return
	}
	if payload, err := json.Marshal(value); err == nil {
		p.payloadBytes = len(payload)
	}
}

func (p *extensionCallPerf) setPayloadBytes(payloadBytes int) {
	if p == nil {
		return
	}
	p.payloadBytes = payloadBytes
}

func (p *extensionCallPerf) setItems(items int) {
	if p == nil {
		return
	}
	p.items = items
}

func (p *extensionCallPerf) finish() {
	if p == nil {
		return
	}
	LogDebug(
		"ExtensionPerf",
		"extension=%s op=%s totalMs=%.1f initMs=%.1f jsMs=%.1f parseMs=%.1f items=%d payloadBytes=%d",
		p.extensionID,
		p.operation,
		extensionDurationMs(time.Since(p.startedAt)),
		p.initMs,
		p.jsMs,
		p.parseMs,
		p.items,
		p.payloadBytes,
	)
}

func countExtensionTopLevelItems(vm *goja.Runtime, value goja.Value) int {
	if gojaValueIsEmpty(value) {
		return 0
	}

	if length, err := gojaArrayLength(value, vm); err == nil && length > 0 {
		return length
	}

	obj := value.ToObject(vm)
	for _, key := range []string{"items", "tracks", "sections", "albums", "artists", "playlists", "results"} {
		child := obj.Get(key)
		if gojaValueIsEmpty(child) {
			continue
		}
		if length, err := gojaArrayLength(child, vm); err == nil && length > 0 {
			return length
		}
	}

	return 1
}
