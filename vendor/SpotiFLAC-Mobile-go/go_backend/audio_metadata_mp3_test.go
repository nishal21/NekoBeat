package gobackend

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func ffmpegCommand(args ...string) *exec.Cmd {
	if ffmpegPath, err := exec.LookPath("ffmpeg"); err == nil {
		return exec.Command(ffmpegPath, args...)
	}
	return exec.Command("ffmpeg", args...)
}

func runFFmpegTestCommand(t *testing.T, args ...string) {
	t.Helper()
	cmd := ffmpegCommand(args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("ffmpeg failed: %v\n%s", err, string(output))
	}
}

func TestExtractLyricsReadsMp3AfterCoverEmbed(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not available")
	}

	tempDir := t.TempDir()
	sourceFlac := filepath.Join(tempDir, "source.flac")
	baseMp3 := filepath.Join(tempDir, "base.mp3")
	finalMp3 := filepath.Join(tempDir, "final.mp3")
	coverPath := filepath.Join(tempDir, "cover.jpg")
	lyrics := "[ti:Test Song]\n[ar:Test Artist]\n[00:00.00]Hello from embedded lyrics"

	runFFmpegTestCommand(
		t,
		"-y",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:duration=1",
		"-c:a",
		"flac",
		sourceFlac,
	)

	runFFmpegTestCommand(
		t,
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=c=red:s=32x32:d=1",
		"-frames:v",
		"1",
		coverPath,
	)

	runFFmpegTestCommand(
		t,
		"-y",
		"-i",
		sourceFlac,
		"-b:a",
		"320k",
		"-metadata",
		"title=Test Song",
		"-metadata",
		"artist=Test Artist",
		"-metadata",
		"lyrics="+lyrics,
		baseMp3,
	)

	runFFmpegTestCommand(
		t,
		"-y",
		"-i",
		baseMp3,
		"-i",
		coverPath,
		"-map",
		"0:a",
		"-map_metadata",
		"-1",
		"-map",
		"1:0",
		"-c:v:0",
		"copy",
		"-id3v2_version",
		"3",
		"-metadata",
		"title=Test Song",
		"-metadata",
		"artist=Test Artist",
		"-metadata",
		"lyrics="+lyrics,
		"-metadata:s:v",
		"title=Album cover",
		"-metadata:s:v",
		"comment=Cover (front)",
		"-c:a",
		"copy",
		finalMp3,
	)

	meta, err := ReadID3Tags(finalMp3)
	if err != nil {
		t.Fatalf("ReadID3Tags failed: %v", err)
	}
	if meta == nil {
		t.Fatalf("ReadID3Tags returned nil metadata")
	}

	embeddedLyrics, err := ExtractLyrics(finalMp3)
	if err != nil {
		t.Fatalf("ExtractLyrics failed: %v (metadata=%+v)", err, meta)
	}
	if !strings.Contains(embeddedLyrics, "Hello from embedded lyrics") {
		t.Fatalf("embedded lyrics missing, got %q (metadata=%+v)", embeddedLyrics, meta)
	}
	if !strings.Contains(meta.Lyrics, "Hello from embedded lyrics") {
		t.Fatalf("ReadID3Tags lyrics missing, got %+v", meta)
	}

	if _, err := os.Stat(finalMp3); err != nil {
		t.Fatalf("expected final mp3 to exist: %v", err)
	}
}
