package gobackend

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestRetryHardening(t *testing.T) {
	resp := &http.Response{Header: http.Header{"Retry-After": []string{"3600"}}}
	if d := getRetryAfterDuration(resp); d != maxRetryAfterDelay {
		t.Fatalf("Retry-After 3600s clamped to %v, want %v", d, maxRetryAfterDelay)
	}

	// A 403 without ISP-blocking markers must reach the caller with a
	// readable body even though the marker scan consumed the original.
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: 403,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("quota exceeded")),
			Request:    req,
		}, nil
	})}
	got, err := DoRequestWithRetry(client, mustNewRequest(t, "https://example.com/x"), DefaultRetryConfig())
	if err != nil || got.StatusCode != 403 {
		t.Fatalf("DoRequestWithRetry = %#v/%v", got, err)
	}
	body, err := io.ReadAll(got.Body)
	got.Body.Close()
	if err != nil || string(body) != "quota exceeded" {
		t.Fatalf("403 body = %q/%v, want restored body", body, err)
	}

	// Backoff sleeps must abort on context cancellation.
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(10 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	if err := sleepRetry(ctx, 5*time.Second); err == nil {
		t.Fatal("sleepRetry ignored cancellation")
	}
	if time.Since(start) > time.Second {
		t.Fatal("sleepRetry did not abort promptly on cancel")
	}
}
