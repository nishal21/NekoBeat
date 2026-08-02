package gobackend

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
)

// Streaming support for MP4 tag rewrites: only the boxes being edited (moov,
// ftyp) are held in memory while the mdat bulk is streamed between file
// handles, so peak memory tracks the moov size instead of the file size.

// loadTopLevelMP4Box scans f's top-level boxes and loads only the first box of
// the given type into memory, returning its bytes and absolute file offset.
// ok is false when the box does not exist; err reports read/parse failures.
func loadTopLevelMP4Box(f *os.File, fileSize int64, typ string) (buf []byte, offset int64, ok bool, err error) {
	for pos := int64(0); pos+8 <= fileSize; {
		header, err := readAtomHeaderAt(f, pos, fileSize)
		if err != nil {
			return nil, 0, false, err
		}
		size := header.size
		if size == 0 {
			size = fileSize - pos
		}
		if size < header.headerSize || pos+size > fileSize {
			return nil, 0, false, fmt.Errorf("invalid atom size for %s", header.typ)
		}
		if header.typ == typ {
			buf := make([]byte, size)
			if _, err := f.ReadAt(buf, pos); err != nil {
				return nil, 0, false, err
			}
			return buf, pos, true, nil
		}
		pos += size
	}
	return nil, 0, false, nil
}

// fileSection is one byte range [start,end) to substitute during a streaming
// rewrite.
type fileSection struct {
	start, end int64
	data       []byte
}

// replaceFileSectionsStreaming rewrites filePath with each section replaced by
// its data, streaming every byte outside the sections, and publishes via
// temp+fsync+rename so an interruption never leaves a truncated file under the
// final name. Sections must not overlap; they are sorted internally.
func replaceFileSectionsStreaming(filePath string, sections []fileSection) error {
	sorted := append([]fileSection{}, sections...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].start < sorted[j].start })
	for i := 1; i < len(sorted); i++ {
		if sorted[i].start < sorted[i-1].end {
			return fmt.Errorf("overlapping file sections")
		}
	}

	src, err := os.Open(filePath)
	if err != nil {
		return err
	}

	tmpPath := filePath + ".tag.partial"
	os.Remove(tmpPath)
	tmp, err := os.Create(tmpPath)
	if err != nil {
		src.Close()
		return err
	}
	fail := func(err error) error {
		tmp.Close()
		src.Close()
		os.Remove(tmpPath)
		return err
	}

	pos := int64(0)
	for _, sec := range sorted {
		if sec.start < pos {
			return fail(fmt.Errorf("file section out of order"))
		}
		if _, err := io.CopyN(tmp, src, sec.start-pos); err != nil {
			return fail(err)
		}
		if _, err := tmp.Write(sec.data); err != nil {
			return fail(err)
		}
		if _, err := src.Seek(sec.end, io.SeekStart); err != nil {
			return fail(err)
		}
		pos = sec.end
	}
	if _, err := io.Copy(tmp, src); err != nil {
		return fail(err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		src.Close()
		os.Remove(tmpPath)
		return err
	}
	// Release the read handle before the rename (required on Windows).
	if err := src.Close(); err != nil {
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
