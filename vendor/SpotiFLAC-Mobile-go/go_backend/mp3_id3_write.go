package gobackend

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Native ID3v2 editor for MP3 files. Unlike the ffmpeg remux path, this
// rewrites only the tag block and preserves every foreign frame it does not
// control (POPM ratings, SYLT synced lyrics, CHAP/CTOC chapters, custom TXXX
// from other taggers). The audio bytes are streamed through untouched, and the
// whole file is published via temp+fsync+rename so a crash never corrupts it.

// id3RawFrame is a frame preserved verbatim (payload already de-unsynced and
// stripped of grouping/data-length prefixes, so it re-serializes with flags 0).
type id3RawFrame struct {
	id      string
	payload []byte
}

// id3v22FrameIDs maps ID3v2.2 3-char IDs to their v2.4 equivalents.
var id3v22FrameIDs = map[string]string{
	"TT2": "TIT2", "TP1": "TPE1", "TP2": "TPE2", "TAL": "TALB",
	"TYE": "TDRC", "TCO": "TCON", "TRK": "TRCK", "TPA": "TPOS",
	"TCM": "TCOM", "TPB": "TPUB", "TCR": "TCOP", "TXX": "TXXX",
	"ULT": "USLT", "COM": "COMM",
}

// readMP3ID3v2Frames parses the leading ID3v2 tag of an MP3 into raw frames
// and returns the offset where the audio data begins. A file without an ID3v2
// tag yields no frames and audioStart 0. Compressed/encrypted frames cannot be
// re-serialized safely and are dropped.
func readMP3ID3v2Frames(f *os.File) (frames []id3RawFrame, audioStart int64, err error) {
	header := make([]byte, 10)
	n, err := f.ReadAt(header, 0)
	if err != nil && err != io.EOF {
		return nil, 0, err
	}
	if n < 10 || string(header[0:3]) != "ID3" {
		return nil, 0, nil
	}

	majorVersion := header[3]
	flags := header[5]
	tagUnsync := (flags & 0x80) != 0
	extendedHeader := (flags & 0x40) != 0
	footerPresent := (flags & 0x10) != 0

	size := synchsafeDecode(header[6:10])
	if size <= 0 {
		return nil, 0, fmt.Errorf("invalid ID3v2 tag size")
	}
	audioStart = int64(10 + size)
	if footerPresent {
		audioStart += 10
	}

	tagData := make([]byte, size)
	if _, err := f.ReadAt(tagData, 10); err != nil {
		return nil, 0, fmt.Errorf("truncated ID3v2 tag: %w", err)
	}
	if footerPresent && len(tagData) >= 10 {
		footerStart := len(tagData) - 10
		if string(tagData[footerStart:footerStart+3]) == "3DI" {
			tagData = tagData[:footerStart]
		}
	}
	if extendedHeader {
		if skip := extendedHeaderSize(tagData, majorVersion); skip > 0 && skip < len(tagData) {
			tagData = tagData[skip:]
		}
	}

	if majorVersion == 2 {
		return parseID3v22RawFrames(tagData, tagUnsync), audioStart, nil
	}
	return parseID3v2xRawFrames(tagData, majorVersion, tagUnsync), audioStart, nil
}

func parseID3v22RawFrames(data []byte, tagUnsync bool) []id3RawFrame {
	var frames []id3RawFrame
	pos := 0
	for pos+6 < len(data) {
		id := string(data[pos : pos+3])
		if id[0] == 0 {
			break
		}
		size := int(data[pos+3])<<16 | int(data[pos+4])<<8 | int(data[pos+5])
		if size <= 0 || pos+6+size > len(data) {
			break
		}
		payload := data[pos+6 : pos+6+size]
		if tagUnsync {
			payload = removeUnsync(payload)
		}
		pos += 6 + size

		if id == "PIC" {
			if converted := convertPICToAPIC(payload); converted != nil {
				frames = append(frames, id3RawFrame{id: "APIC", payload: converted})
			}
			continue
		}
		mapped, ok := id3v22FrameIDs[id]
		if !ok {
			continue // no safe v2.4 equivalent
		}
		frames = append(frames, id3RawFrame{id: mapped, payload: append([]byte(nil), payload...)})
	}
	return frames
}

// convertPICToAPIC rewrites a v2.2 PIC payload (3-char image format) into the
// v2.3+ APIC layout (null-terminated MIME string). Returns nil when malformed.
func convertPICToAPIC(payload []byte) []byte {
	if len(payload) < 5 {
		return nil
	}
	mime := "image/jpeg"
	if strings.EqualFold(string(payload[1:4]), "PNG") {
		mime = "image/png"
	}
	out := []byte{payload[0]}
	out = append(out, []byte(mime)...)
	out = append(out, 0x00)
	out = append(out, payload[4:]...) // picture type + description + data
	return out
}

func parseID3v2xRawFrames(data []byte, version byte, tagUnsync bool) []id3RawFrame {
	var frames []id3RawFrame
	pos := 0
	for pos+10 < len(data) {
		id := string(data[pos : pos+4])
		if id[0] == 0 {
			break
		}
		var size int
		if version == 4 {
			size = synchsafeDecode(data[pos+4 : pos+8])
		} else {
			size = int(data[pos+4])<<24 | int(data[pos+5])<<16 | int(data[pos+6])<<8 | int(data[pos+7])
		}
		if size <= 0 || pos+10+size > len(data) {
			break
		}
		payload := data[pos+10 : pos+10+size]
		formatFlags := data[pos+9]
		pos += 10 + size

		if version == 3 {
			if formatFlags&(0x80|0x40) != 0 { // compression | encryption
				continue
			}
			if formatFlags&0x20 != 0 { // grouping
				if len(payload) < 1 {
					continue
				}
				payload = payload[1:]
			}
			if tagUnsync {
				payload = removeUnsync(payload)
			}
		} else {
			if formatFlags&(0x08|0x04) != 0 { // compression | encryption
				continue
			}
			if formatFlags&0x40 != 0 { // grouping
				if len(payload) < 1 {
					continue
				}
				payload = payload[1:]
			}
			if formatFlags&0x01 != 0 { // data length indicator
				if len(payload) < 4 {
					continue
				}
				payload = payload[4:]
			}
			if formatFlags&0x02 != 0 || tagUnsync { // frame unsync
				payload = removeUnsync(payload)
			}
		}
		frames = append(frames, id3RawFrame{id: id, payload: append([]byte(nil), payload...)})
	}
	return frames
}

func id3TextPayload(value string) []byte {
	return append([]byte{0x03}, []byte(value)...) // UTF-8
}

func id3LangTextPayload(text string) []byte {
	payload := []byte{0x03}
	payload = append(payload, []byte("eng")...)
	payload = append(payload, 0x00) // empty description
	payload = append(payload, []byte(text)...)
	return payload
}

func id3TXXXPayload(desc, value string) []byte {
	payload := []byte{0x03}
	payload = append(payload, []byte(desc)...)
	payload = append(payload, 0x00)
	payload = append(payload, []byte(value)...)
	return payload
}

// firstFrameText returns the decoded text of the first frame with the given ID.
func firstFrameText(frames []id3RawFrame, id string) string {
	for _, fr := range frames {
		if fr.id == id {
			return firstTextValue(extractTextFrame(fr.payload))
		}
	}
	return ""
}

// EditMP3Fields updates only the ID3v2 frames whose keys are explicitly present
// in the fields map (set-or-clear semantics, mirroring EditFlacFields) while
// preserving every other frame byte-for-byte. The tag is rewritten as ID3v2.4.
func EditMP3Fields(filePath string, fields map[string]string) error {
	f, err := os.Open(filePath)
	if err != nil {
		return err
	}
	frames, audioStart, err := readMP3ID3v2Frames(f)
	if err != nil {
		f.Close()
		return err
	}

	drop := map[string]bool{}
	var added []id3RawFrame

	setOrClear := func(frameID, value string, aliases ...string) {
		drop[frameID] = true
		for _, alias := range aliases {
			drop[alias] = true
		}
		if strings.TrimSpace(value) != "" {
			added = append(added, id3RawFrame{id: frameID, payload: id3TextPayload(value)})
		}
	}

	simpleKeys := []struct {
		fieldKey string
		frameID  string
		aliases  []string
	}{
		{"title", "TIT2", nil},
		{"artist", "TPE1", nil},
		{"album", "TALB", nil},
		{"album_artist", "TPE2", nil},
		{"date", "TDRC", []string{"TYER", "TDAT", "TIME"}},
		{"genre", "TCON", nil},
		{"label", "TPUB", nil},
		{"copyright", "TCOP", nil},
		{"composer", "TCOM", nil},
		{"isrc", "TSRC", nil},
	}
	for _, key := range simpleKeys {
		if v, ok := fields[key.fieldKey]; ok {
			setOrClear(key.frameID, v, key.aliases...)
		}
	}

	if v, ok := fields["comment"]; ok {
		drop["COMM"] = true
		if strings.TrimSpace(v) != "" {
			added = append(added, id3RawFrame{id: "COMM", payload: id3LangTextPayload(v)})
		}
	}
	if v, ok := fields["lyrics"]; ok {
		drop["USLT"] = true // synced SYLT frames are intentionally preserved
		if strings.TrimSpace(v) != "" {
			added = append(added, id3RawFrame{id: "USLT", payload: id3LangTextPayload(v)})
		}
	}

	// Track/disc numbers: merge with the current value when only one half is
	// edited, mirroring the FLAC editor's semantics.
	if hasMapKey(fields, "track_number") || hasMapKey(fields, "track_total") {
		num, total := parseIndexPair(firstFrameText(frames, "TRCK"))
		if v, ok := fields["track_number"]; ok {
			num = parsePositiveInt(v)
		}
		if v, ok := fields["track_total"]; ok {
			total = parsePositiveInt(v)
		}
		setOrClear("TRCK", formatIndexValue(num, total))
	}
	if hasMapKey(fields, "disc_number") || hasMapKey(fields, "disc_total") {
		num, total := parseIndexPair(firstFrameText(frames, "TPOS"))
		if v, ok := fields["disc_number"]; ok {
			num = parsePositiveInt(v)
		}
		if v, ok := fields["disc_total"]; ok {
			total = parsePositiveInt(v)
		}
		setOrClear("TPOS", formatIndexValue(num, total))
	}

	// ReplayGain lives in TXXX frames matched by description; only the edited
	// descriptions are dropped so foreign TXXX frames survive.
	dropTXXXDesc := map[string]bool{}
	for _, key := range []string{
		"replaygain_track_gain", "replaygain_track_peak",
		"replaygain_album_gain", "replaygain_album_peak",
	} {
		if v, ok := fields[key]; ok {
			desc := strings.ToUpper(key)
			dropTXXXDesc[desc] = true
			if strings.TrimSpace(v) != "" {
				added = append(added, id3RawFrame{id: "TXXX", payload: id3TXXXPayload(desc, v)})
			}
		}
	}

	coverPath := strings.TrimSpace(fields["cover_path"])
	if coverPath != "" {
		if coverData, err := os.ReadFile(coverPath); err == nil && len(coverData) > 0 {
			drop["APIC"] = true
			mime := http.DetectContentType(coverData)
			payload := []byte{0x03}
			payload = append(payload, []byte(mime)...)
			payload = append(payload, 0x00, 0x03, 0x00) // front cover, no description
			payload = append(payload, coverData...)
			added = append(added, id3RawFrame{id: "APIC", payload: payload})
		}
	}

	var kept []id3RawFrame
	for _, fr := range frames {
		if drop[fr.id] {
			continue
		}
		if fr.id == "TXXX" && len(dropTXXXDesc) > 0 {
			desc, _ := extractUserTextFrame(fr.payload)
			if dropTXXXDesc[strings.ToUpper(strings.TrimSpace(desc))] {
				continue
			}
		}
		kept = append(kept, fr)
	}
	kept = append(kept, added...)

	tag := serializeID3v24Tag(kept)
	err = spliceFileAtomic(filePath, f, tag, audioStart)
	f.Close() // harmless double close when the splice already closed it
	return err
}

func serializeID3v24Tag(frames []id3RawFrame) []byte {
	var body bytes.Buffer
	for _, fr := range frames {
		body.WriteString(fr.id)
		body.Write(synchsafeEncode(len(fr.payload)))
		body.Write([]byte{0, 0})
		body.Write(fr.payload)
	}
	const padding = 512
	var out bytes.Buffer
	out.WriteString("ID3")
	out.Write([]byte{0x04, 0x00, 0x00})
	out.Write(synchsafeEncode(body.Len() + padding))
	out.Write(body.Bytes())
	out.Write(make([]byte, padding))
	return out.Bytes()
}

// spliceFileAtomic writes head followed by src's bytes from tailStart onward to
// a sibling temp, fsyncs, and renames over filePath. On success src (the open
// original) is closed before the rename, which Windows requires.
func spliceFileAtomic(filePath string, src *os.File, head []byte, tailStart int64) error {
	tmpPath := filePath + ".tag.partial"
	os.Remove(tmpPath)
	tmp, err := os.Create(tmpPath)
	if err != nil {
		return err
	}
	cleanup := func() {
		tmp.Close()
		os.Remove(tmpPath)
	}
	if _, err := tmp.Write(head); err != nil {
		cleanup()
		return err
	}
	if _, err := src.Seek(tailStart, io.SeekStart); err != nil {
		cleanup()
		return err
	}
	if _, err := io.Copy(tmp, src); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	// Release the source handle before replacing the file (required on Windows).
	src.Close()
	if err := os.Rename(tmpPath, filePath); err != nil {
		os.Remove(tmpPath)
		return err
	}
	syncDir(filepath.Dir(filePath))
	return nil
}
