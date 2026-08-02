package gobackend

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	flac "github.com/go-flac/go-flac/v2"
)

// saveFlacFile persists an edited FLAC crash-safely. go-flac's Save(samePath)
// rewrites the file in place by shifting the audio body within the same inode,
// so a process kill or power loss mid-save destroys the file with no recovery
// copy. Instead, stream the whole edited file to a sibling temp, fsync it, and
// rename it over the target: an interruption at any point leaves either the
// old intact file or the new complete one.
//
// fd-backed targets (/proc/self/fd/N) have no directory entry to rename over,
// so those keep the library's in-place path.
func saveFlacFile(f *flac.File, filePath string) error {
	if strings.HasPrefix(filePath, "/proc/self/fd/") {
		return f.Save(filePath)
	}

	// The ".partial" suffix keeps the temp invisible to library scans and
	// extension duplicate checks; the extra ".tag" avoids colliding with the
	// download staging sibling of the same final path.
	tmpPath := filePath + ".tag.partial"
	os.Remove(tmpPath)
	tmp, err := os.Create(tmpPath)
	if err != nil {
		return fmt.Errorf("failed to create temp tag file: %w", err)
	}
	// WriteTo streams the audio frames from the still-open source handle and
	// closes it when done, so the rename below can replace the source even on
	// Windows.
	if _, err := f.WriteTo(tmp); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("failed to sync temp tag file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, filePath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("failed to publish tagged file: %w", err)
	}
	syncDir(filepath.Dir(filePath))
	return nil
}

// syncDir best-effort fsyncs a directory so a just-renamed entry survives
// power loss. Unsupported on some platforms/filesystems; errors are ignored.
func syncDir(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		return
	}
	_ = d.Sync()
	_ = d.Close()
}
