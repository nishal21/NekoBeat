package gobackend

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestStallWatchdogCancelsOnNoData verifies the watchdog aborts a transfer that
// stops sending bytes, marks itself stalled (not user-cancelled), and does so
// after resetting on the initial byte.
func TestStallWatchdogCancelsOnNoData(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("x"))
		w.(http.Flusher).Flush()
		<-block // simulate a dead radio mid-transfer: stop sending
	}))
	defer srv.Close()
	defer close(block)

	req, _ := http.NewRequestWithContext(context.Background(), "GET", srv.URL, nil)
	req, wd := bindStallWatchdog(req, 150*time.Millisecond)
	defer wd.stop()

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()

	buf := make([]byte, 32)
	var readErr error
	for {
		n, er := resp.Body.Read(buf)
		if n > 0 {
			wd.reset()
		}
		if er != nil {
			readErr = er
			break
		}
	}
	if readErr == nil {
		t.Fatal("expected read error from stall cancel")
	}
	if !wd.stalled.Load() {
		t.Fatalf("watchdog did not mark stalled; err=%v", readErr)
	}
}
