package gobackend

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
)

// mp4Box is a minimal ISO-BMFF / QuickTime box view over an in-memory buffer.
type mp4Box struct {
	offset int64
	size   int64
	hdr    int64
	typ    string
}

func (b mp4Box) body() int64 { return b.offset + b.hdr }
func (b mp4Box) end() int64  { return b.offset + b.size }

func readMP4Box(data []byte, pos int64) (mp4Box, bool) {
	n := int64(len(data))
	if pos < 0 || pos+8 > n {
		return mp4Box{}, false
	}
	size := int64(binary.BigEndian.Uint32(data[pos : pos+4]))
	typ := string(data[pos+4 : pos+8])
	hdr := int64(8)
	switch size {
	case 1:
		if pos+16 > n {
			return mp4Box{}, false
		}
		size = int64(binary.BigEndian.Uint64(data[pos+8 : pos+16]))
		hdr = 16
	case 0:
		size = n - pos
	}
	if size < hdr || pos+size > n {
		return mp4Box{}, false
	}
	return mp4Box{offset: pos, size: size, hdr: hdr, typ: typ}, true
}

func findChildMP4(data []byte, start, end int64, typ string) (mp4Box, bool) {
	pos := start
	for pos+8 <= end {
		b, ok := readMP4Box(data, pos)
		if !ok {
			return mp4Box{}, false
		}
		if b.typ == typ {
			return b, true
		}
		pos = b.end()
	}
	return mp4Box{}, false
}

func eachChildMP4(data []byte, start, end int64, typ string, fn func(mp4Box) bool) {
	pos := start
	for pos+8 <= end {
		b, ok := readMP4Box(data, pos)
		if !ok {
			return
		}
		if b.typ == typ && !fn(b) {
			return
		}
		pos = b.end()
	}
}

// findBoxBySignature scans [start,end) for a box of the given type, matching the
// 4-byte type tag and validating the preceding size field. Used to locate dac4
// which may be nested inside an encrypted (enca) sample entry.
func findBoxBySignature(data []byte, start, end int64, typ string) (mp4Box, bool) {
	if len(typ) != 4 {
		return mp4Box{}, false
	}
	for i := start; i+8 <= end; i++ {
		if data[i+4] == typ[0] && data[i+5] == typ[1] && data[i+6] == typ[2] && data[i+7] == typ[3] {
			if b, ok := readMP4Box(data, i); ok && b.typ == typ {
				return b, true
			}
		}
	}
	return mp4Box{}, false
}

// audioSampleEntryHeaderLen returns the byte length of the fixed audio sample
// entry header (from the box body start) before child boxes begin. ok is false
// for malformed/truncated entries whose declared header is not fully present.
func audioSampleEntryHeaderLen(data []byte, entry mp4Box) (hdrLen int64, ok bool) {
	// 6 bytes reserved + 2 bytes data_reference_index, then the audio fields.
	base := entry.body()
	if base+10 > entry.end() {
		return 0, false
	}
	version := binary.BigEndian.Uint16(data[base+8 : base+10])
	hdrLen = 8 + 20
	switch version {
	case 1:
		hdrLen += 16
	case 2:
		hdrLen += 36
	}
	if base+hdrLen > entry.end() {
		return 0, false
	}
	return hdrLen, true
}

type ac4Location struct {
	chain []mp4Box // moov, trak, mdia, minf, stbl, stsd (ancestors to grow)
	entry mp4Box   // the ac-4 sample entry
}

func locateAC4Entry(data []byte) (ac4Location, bool) {
	moov, ok := findChildMP4(data, 0, int64(len(data)), "moov")
	if !ok {
		return ac4Location{}, false
	}
	var found ac4Location
	var ok2 bool
	eachChildMP4(data, moov.body(), moov.end(), "trak", func(trak mp4Box) bool {
		mdia, ok := findChildMP4(data, trak.body(), trak.end(), "mdia")
		if !ok {
			return true
		}
		minf, ok := findChildMP4(data, mdia.body(), mdia.end(), "minf")
		if !ok {
			return true
		}
		stbl, ok := findChildMP4(data, minf.body(), minf.end(), "stbl")
		if !ok {
			return true
		}
		stsd, ok := findChildMP4(data, stbl.body(), stbl.end(), "stsd")
		if !ok {
			return true
		}
		entry, ok := findChildMP4(data, stsd.body()+8, stsd.end(), "ac-4")
		if !ok {
			return true
		}
		found = ac4Location{chain: []mp4Box{moov, trak, mdia, minf, stbl, stsd}, entry: entry}
		ok2 = true
		return false
	})
	return found, ok2
}

func growBoxSize(data []byte, b mp4Box, delta int64) {
	if b.hdr == 16 {
		binary.BigEndian.PutUint64(data[b.offset+8:b.offset+16], uint64(b.size+delta))
	} else {
		binary.BigEndian.PutUint32(data[b.offset:b.offset+4], uint32(b.size+delta))
	}
}

// shiftChunkOffsets adds delta to every stco/co64 entry that references a file
// offset at or beyond insertPos, keeping sample pointers valid after bytes are
// inserted into moov.
func shiftChunkOffsets(data []byte, moov mp4Box, insertPos, delta int64) {
	eachChildMP4(data, moov.body(), moov.end(), "trak", func(trak mp4Box) bool {
		mdia, ok := findChildMP4(data, trak.body(), trak.end(), "mdia")
		if !ok {
			return true
		}
		minf, ok := findChildMP4(data, mdia.body(), mdia.end(), "minf")
		if !ok {
			return true
		}
		stbl, ok := findChildMP4(data, minf.body(), minf.end(), "stbl")
		if !ok {
			return true
		}
		if stco, ok := findChildMP4(data, stbl.body(), stbl.end(), "stco"); ok {
			base := stco.body() + 4
			if base+4 <= stco.end() {
				count := int64(binary.BigEndian.Uint32(data[base : base+4]))
				p := base + 4
				for i := int64(0); i < count && p+4 <= stco.end(); i++ {
					v := int64(binary.BigEndian.Uint32(data[p : p+4]))
					if v >= insertPos {
						binary.BigEndian.PutUint32(data[p:p+4], uint32(v+delta))
					}
					p += 4
				}
			}
		}
		if co64, ok := findChildMP4(data, stbl.body(), stbl.end(), "co64"); ok {
			base := co64.body() + 4
			if base+4 <= co64.end() {
				count := int64(binary.BigEndian.Uint32(data[base : base+4]))
				p := base + 4
				for i := int64(0); i < count && p+8 <= co64.end(); i++ {
					v := int64(binary.BigEndian.Uint64(data[p : p+8]))
					if v >= insertPos {
						binary.BigEndian.PutUint64(data[p:p+8], uint64(v+delta))
					}
					p += 8
				}
			}
		}
		return true
	})
}

// normalizeQuickTimeBrandsInBuf rewrites a "qt  " ftyp brand to isom/mp42 in
// place. Works on any buffer whose top level contains the ftyp box (whole file
// or the ftyp box alone). Returns whether anything changed.
func normalizeQuickTimeBrandsInBuf(data []byte) bool {
	ftyp, ok := findChildMP4(data, 0, int64(len(data)), "ftyp")
	if !ok {
		return false
	}
	changed := false
	if ftyp.body()+4 <= int64(len(data)) && string(data[ftyp.body():ftyp.body()+4]) != "mp42" {
		copy(data[ftyp.body():ftyp.body()+4], []byte("mp42"))
		changed = true
	}
	for p := ftyp.body() + 8; p+4 <= ftyp.end(); p += 4 {
		if string(data[p:p+4]) == "qt  " {
			copy(data[p:p+4], []byte("isom"))
			changed = true
		}
	}
	return changed
}

// normalizeQuickTimeAudioEntry rewrites a version-1 QuickTime sound sample
// entry into a plain version-0 AudioSampleEntry, dropping the 16-byte v1
// extension. base is the buffer's absolute file offset (0 for a whole-file
// buffer, the moov offset for a moov-only buffer).
func normalizeQuickTimeAudioEntry(data []byte, base int64) []byte {
	loc, ok := locateAC4Entry(data)
	if !ok {
		return data
	}
	entry := loc.entry
	verPos := entry.body() + 8
	if verPos+2 > entry.end() {
		return data
	}
	if binary.BigEndian.Uint16(data[verPos:verPos+2]) != 1 {
		return data // already v0 (or v2, left untouched)
	}

	// The v1 QuickTime sound extension is the 16 bytes following the 20-byte v0
	// audio fields (samplesPerPacket, bytesPerPacket, bytesPerFrame, bytesPerSample).
	extStart := entry.body() + 8 + 20
	extEnd := extStart + 16
	if extEnd > entry.end() {
		return data
	}
	delta := int64(-16)

	binary.BigEndian.PutUint16(data[verPos:verPos+2], 0)
	shiftChunkOffsets(data, loc.chain[0], base+extStart, delta)
	for _, b := range loc.chain {
		growBoxSize(data, b, delta)
	}
	growBoxSize(data, entry, delta)

	out := make([]byte, 0, len(data)-16)
	out = append(out, data[:extStart]...)
	out = append(out, data[extEnd:]...)
	return out
}

// normalizeQuickTimeAudioToMP4 rewrites a QuickTime-flavored file (FFmpeg mov
// muxer output: ftyp brand "qt  " and a version-1 sound sample entry) into a
// standard ISO MP4: an isom/mp42 brand and a plain version-0 AudioSampleEntry.
// Windows Media Foundation (and other strict parsers) reject the QuickTime
// flavor for AC-4 even when dac4 is present.
func normalizeQuickTimeAudioToMP4(data []byte) []byte {
	normalizeQuickTimeBrandsInBuf(data)
	return normalizeQuickTimeAudioEntry(data, 0)
}

// EnsureAC4ConfigBox makes a decrypted AC-4 MP4 standards-compliant and
// playable: it normalizes FFmpeg's QuickTime-flavored mov output to an ISO MP4
// and injects the AC-4 configuration box (dac4) into the ac-4 sample entry. The
// dac4 box is copied verbatim from sourcePath (the original MP4, whose plaintext
// moov still carries it). No-op when the file has no AC-4 track. Only the ftyp
// and moov boxes are held in memory; the audio bulk is streamed.
func EnsureAC4ConfigBox(decryptedPath, sourcePath string) error {
	f, err := os.Open(decryptedPath)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	// A non-MP4 decrypt output (e.g. a raw FLAC stream) is not an AC-4 file;
	// bail out before the box parser reports it as a corrupt MP4. A real
	// ISO-BMFF box type is four printable ASCII bytes.
	var head [8]byte
	if _, err := f.ReadAt(head[:], 0); err != nil {
		f.Close()
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			return nil
		}
		return err
	}
	for _, c := range head[4:8] {
		if c < 0x20 || c > 0x7e {
			f.Close()
			return nil
		}
	}
	moovBuf, moovOffset, moovFound, err := loadTopLevelMP4Box(f, info.Size(), "moov")
	if err != nil || !moovFound {
		f.Close()
		return err // parse/read failure, or no moov: nothing to do
	}
	ftypBuf, ftypOffset, ftypFound, err := loadTopLevelMP4Box(f, info.Size(), "ftyp")
	f.Close()
	if err != nil {
		return err
	}
	moovLen := int64(len(moovBuf))

	if _, ok := locateAC4Entry(moovBuf); !ok {
		return nil // not an AC-4 file; nothing to do
	}

	ftypChanged := ftypFound && normalizeQuickTimeBrandsInBuf(ftypBuf)
	dst := normalizeQuickTimeAudioEntry(moovBuf, moovOffset)

	loc, ok := locateAC4Entry(dst)
	if !ok {
		return nil
	}

	hdrLen, ok := audioSampleEntryHeaderLen(dst, loc.entry)
	if !ok {
		return fmt.Errorf("malformed ac-4 sample entry")
	}
	childStart := loc.entry.body() + hdrLen
	if _, has := findChildMP4(dst, childStart, loc.entry.end(), "dac4"); has {
		// Already has dac4; still persist any normalization changes.
		return writeAC4Sections(decryptedPath, ftypChanged, ftypBuf, ftypOffset, dst, moovOffset, moovLen)
	}

	srcF, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	srcInfo, err := srcF.Stat()
	if err != nil {
		srcF.Close()
		return err
	}
	srcMoovBuf, _, srcFound, err := loadTopLevelMP4Box(srcF, srcInfo.Size(), "moov")
	srcF.Close()
	if err != nil {
		return err
	}
	if !srcFound {
		return fmt.Errorf("source has no moov")
	}
	srcMoov, ok := readMP4Box(srcMoovBuf, 0)
	if !ok {
		return fmt.Errorf("source has no moov")
	}
	dac4Box, ok := findBoxBySignature(srcMoovBuf, srcMoov.body(), srcMoov.end(), "dac4")
	if !ok {
		return fmt.Errorf("dac4 not found in source")
	}
	dac4 := append([]byte{}, srcMoovBuf[dac4Box.offset:dac4Box.end()]...)

	insertPos := childStart
	delta := int64(len(dac4))

	shiftChunkOffsets(dst, loc.chain[0], moovOffset+insertPos, delta)
	for _, b := range loc.chain {
		growBoxSize(dst, b, delta)
	}
	growBoxSize(dst, loc.entry, delta)

	out := make([]byte, 0, len(dst)+len(dac4))
	out = append(out, dst[:insertPos]...)
	out = append(out, dac4...)
	out = append(out, dst[insertPos:]...)

	return writeAC4Sections(decryptedPath, ftypChanged, ftypBuf, ftypOffset, out, moovOffset, moovLen)
}

// writeAC4Sections streams the edited moov (and, when changed, ftyp) back into
// the file.
func writeAC4Sections(path string, ftypChanged bool, ftypBuf []byte, ftypOffset int64, moovBuf []byte, moovOffset, origMoovLen int64) error {
	sections := []fileSection{
		{start: moovOffset, end: moovOffset + origMoovLen, data: moovBuf},
	}
	if ftypChanged {
		sections = append(sections, fileSection{
			start: ftypOffset,
			end:   ftypOffset + int64(len(ftypBuf)),
			data:  ftypBuf,
		})
	}
	return replaceFileSectionsStreaming(path, sections)
}
