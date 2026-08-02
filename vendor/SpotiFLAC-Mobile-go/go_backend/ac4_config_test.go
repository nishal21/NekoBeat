package gobackend

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

func mp4TestBox(typ string, body []byte) []byte {
	out := make([]byte, 8+len(body))
	binary.BigEndian.PutUint32(out[:4], uint32(len(out)))
	copy(out[4:8], typ)
	copy(out[8:], body)
	return out
}

func mp4TestAC4Tree(entryBody []byte) []byte {
	entry := mp4TestBox("ac-4", entryBody)
	stsdBody := append([]byte{
		0, 0, 0, 0, // version/flags
		0, 0, 0, 1, // entry_count
	}, entry...)
	stsd := mp4TestBox("stsd", stsdBody)
	stbl := mp4TestBox("stbl", stsd)
	minf := mp4TestBox("minf", stbl)
	mdia := mp4TestBox("mdia", minf)
	trak := mp4TestBox("trak", mdia)
	moov := mp4TestBox("moov", trak)
	return moov
}

func shortAC4SampleEntryBody(version uint16) []byte {
	body := make([]byte, 10)
	binary.BigEndian.PutUint16(body[8:10], version)
	return body
}

func TestNormalizeQuickTimeAudioToMP4IgnoresTruncatedAC4Entry(t *testing.T) {
	input := mp4TestAC4Tree(shortAC4SampleEntryBody(1))

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("normalizeQuickTimeAudioToMP4 panicked: %v", r)
		}
	}()

	got := normalizeQuickTimeAudioToMP4(append([]byte{}, input...))
	if !bytes.Equal(got, input) {
		t.Fatal("truncated QuickTime AC-4 entry should be left unchanged")
	}
}

func TestEnsureAC4ConfigBoxRejectsTruncatedAC4Entry(t *testing.T) {
	dir := t.TempDir()
	decryptedPath := filepath.Join(dir, "decrypted.mp4")
	sourcePath := filepath.Join(dir, "source.mp4")

	if err := os.WriteFile(decryptedPath, mp4TestAC4Tree(shortAC4SampleEntryBody(2)), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sourcePath, mp4TestBox("moov", mp4TestBox("dac4", []byte{1, 2, 3, 4})), 0o644); err != nil {
		t.Fatal(err)
	}

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("EnsureAC4ConfigBox panicked: %v", r)
		}
	}()

	if err := EnsureAC4ConfigBox(decryptedPath, sourcePath); err == nil {
		t.Fatal("expected malformed AC-4 sample entry error")
	}
}
