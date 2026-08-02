package gobackend

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
	"strings"
)

// Native editor for the standard iTunes ilst atoms plus freeform tags, in one
// atomic pass. Unlike the ffmpeg remux path it preserves every atom it does
// not control, fixes stco/co64 chunk offsets when moov precedes mdat, and
// publishes via temp+fsync+rename.

// m4aTextAtoms maps editor field keys to iTunes text atom types.
var m4aTextAtoms = map[string]string{
	"title":        "\xa9nam",
	"artist":       "\xa9ART",
	"album":        "\xa9alb",
	"album_artist": "aART",
	"date":         "\xa9day",
	"genre":        "\xa9gen",
	"composer":     "\xa9wrt",
	"comment":      "\xa9cmt",
	"copyright":    "cprt",
	"lyrics":       "\xa9lyr",
}

func buildM4ADataAtom(dataType uint32, payload []byte) []byte {
	buf := make([]byte, 8+len(payload))
	binary.BigEndian.PutUint32(buf[0:4], dataType)
	copy(buf[8:], payload)
	return buildM4AAtom("data", buf)
}

func buildM4ATextAtom(typ, value string) []byte {
	return buildM4AAtom(typ, buildM4ADataAtom(1, []byte(value)))
}

func buildM4AIndexAtom(typ string, num, total int) []byte {
	size := 8 // trkn: pad(2) num(2) total(2) pad(2)
	if typ == "disk" {
		size = 6
	}
	payload := make([]byte, size)
	binary.BigEndian.PutUint16(payload[2:4], uint16(num))
	binary.BigEndian.PutUint16(payload[4:6], uint16(total))
	return buildM4AAtom(typ, buildM4ADataAtom(0, payload))
}

func buildM4ACoverAtom(coverData []byte) []byte {
	dataType := uint32(13) // JPEG
	if bytes.HasPrefix(coverData, []byte("\x89PNG")) {
		dataType = 14
	}
	return buildM4AAtom("covr", buildM4ADataAtom(dataType, coverData))
}

type m4aIlstLocation struct {
	moov mp4Box
	ilst mp4Box
	// ancestors whose size field must grow when ilst changes size; all start
	// before ilst so their offsets survive the splice.
	ancestors []mp4Box
}

// locateM4AIlstInBuf finds moov > [udta >] meta > ilst. The meta box is a full
// box, so its children start 4 bytes into the body.
func locateM4AIlstInBuf(data []byte) (m4aIlstLocation, bool) {
	n := int64(len(data))
	moov, ok := findChildMP4(data, 0, n, "moov")
	if !ok {
		return m4aIlstLocation{}, false
	}
	if udta, ok := findChildMP4(data, moov.body(), moov.end(), "udta"); ok {
		if meta, ok := findChildMP4(data, udta.body(), udta.end(), "meta"); ok {
			if ilst, ok := findChildMP4(data, meta.body()+4, meta.end(), "ilst"); ok {
				return m4aIlstLocation{moov: moov, ilst: ilst, ancestors: []mp4Box{moov, udta, meta}}, true
			}
		}
	}
	if meta, ok := findChildMP4(data, moov.body(), moov.end(), "meta"); ok {
		if ilst, ok := findChildMP4(data, meta.body()+4, meta.end(), "ilst"); ok {
			return m4aIlstLocation{moov: moov, ilst: ilst, ancestors: []mp4Box{moov, meta}}, true
		}
	}
	return m4aIlstLocation{}, false
}

// buildM4AMetaBox returns a meta full box containing the iTunes mdir hdlr and
// an empty ilst.
func buildM4AMetaBox() []byte {
	hdlrPayload := make([]byte, 25) // ver/flags + pre_defined + handler + 3x reserved + empty name
	copy(hdlrPayload[8:12], "mdir")
	copy(hdlrPayload[12:16], "appl")
	body := append([]byte{0, 0, 0, 0}, buildM4AAtom("hdlr", hdlrPayload)...)
	body = append(body, buildM4AAtom("ilst", nil)...)
	return buildM4AAtom("meta", body)
}

// ensureM4AIlstInBuf returns a buffer guaranteed to contain the
// moov>[udta>]meta>ilst chain, creating the missing tail at the end of the
// deepest existing ancestor. Chunk offsets are shifted for the inserted bytes;
// base is the buffer's absolute file offset (0 for a whole-file buffer) so the
// shift compares against the absolute positions stco/co64 entries hold.
func ensureM4AIlstInBuf(data []byte, base int64) ([]byte, m4aIlstLocation, error) {
	if loc, ok := locateM4AIlstInBuf(data); ok {
		return data, loc, nil
	}

	n := int64(len(data))
	moov, ok := findChildMP4(data, 0, n, "moov")
	if !ok {
		return nil, m4aIlstLocation{}, fmt.Errorf("moov not found")
	}

	var insertPos int64
	var insert []byte
	var grow []mp4Box

	if udta, ok := findChildMP4(data, moov.body(), moov.end(), "udta"); ok {
		if meta, ok := findChildMP4(data, udta.body(), udta.end(), "meta"); ok {
			insertPos = meta.end()
			insert = buildM4AAtom("ilst", nil)
			grow = []mp4Box{moov, udta, meta}
		} else {
			insertPos = udta.end()
			insert = buildM4AMetaBox()
			grow = []mp4Box{moov, udta}
		}
	} else {
		insertPos = moov.end()
		insert = buildM4AAtom("udta", buildM4AMetaBox())
		grow = []mp4Box{moov}
	}

	updated := make([]byte, 0, len(data)+len(insert))
	updated = append(updated, data[:insertPos]...)
	updated = append(updated, insert...)
	updated = append(updated, data[insertPos:]...)

	delta := int64(len(insert))
	for _, b := range grow {
		growBoxSize(updated, b, delta)
	}
	if newMoov, ok := findChildMP4(updated, 0, int64(len(updated)), "moov"); ok {
		shiftChunkOffsets(updated, newMoov, base+insertPos, delta)
	}

	loc, ok := locateM4AIlstInBuf(updated)
	if !ok {
		return nil, m4aIlstLocation{}, fmt.Errorf("failed to create ilst")
	}
	return updated, loc, nil
}

// m4aFreeformNameInBuf extracts the freeform ("----") atom's name from a
// buffer-backed child box.
func m4aFreeformNameInBuf(data []byte, box mp4Box) string {
	pos := box.body()
	for pos+8 <= box.end() {
		child, ok := readMP4Box(data, pos)
		if !ok {
			return ""
		}
		if child.typ == "name" && child.size > child.hdr+4 {
			raw := data[child.body()+4 : child.end()]
			return strings.TrimSpace(strings.TrimRight(string(raw), "\x00"))
		}
		pos = child.end()
	}
	return ""
}

// m4aIndexPairInBuf reads the (number, total) pair from a trkn/disk box.
func m4aIndexPairInBuf(data []byte, box mp4Box) (int, int) {
	pos := box.body()
	for pos+8 <= box.end() {
		child, ok := readMP4Box(data, pos)
		if !ok {
			return 0, 0
		}
		if child.typ == "data" && child.size >= child.hdr+8+6 {
			payload := data[child.body()+8 : child.end()]
			return int(binary.BigEndian.Uint16(payload[2:4])), int(binary.BigEndian.Uint16(payload[4:6]))
		}
		pos = child.end()
	}
	return 0, 0
}

// EditM4AFields updates only the ilst entries whose keys are explicitly
// present in the fields map (set-or-clear semantics, mirroring EditFlacFields)
// while preserving every other atom. Standard atoms, freeform ISRC/LABEL, and
// ReplayGain freeform tags are all written in a single file rewrite. Only the
// moov box is held in memory; the audio bulk is streamed.
func EditM4AFields(filePath string, fields map[string]string) error {
	f, err := os.Open(filePath)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	moovBuf, moovOffset, found, err := loadTopLevelMP4Box(f, info.Size(), "moov")
	f.Close()
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("moov not found")
	}
	moovLen := int64(len(moovBuf))

	data, loc, err := ensureM4AIlstInBuf(moovBuf, moovOffset)
	if err != nil {
		return err
	}

	dropStandard := map[string]bool{}
	var appended []byte

	for fieldKey, atomType := range m4aTextAtoms {
		v, ok := fields[fieldKey]
		if !ok {
			continue
		}
		dropStandard[atomType] = true
		if fieldKey == "genre" {
			dropStandard["gnre"] = true // legacy numeric genre
		}
		if strings.TrimSpace(v) != "" {
			appended = append(appended, buildM4ATextAtom(atomType, v)...)
		}
	}

	// Freeform tags: ISRC, LABEL, ReplayGain (+iTunNORM).
	removeFreeform := map[string]struct{}{}
	var freeformTags []m4aFreeformTag
	if _, ok := fields["isrc"]; ok {
		removeFreeform["ISRC"] = struct{}{}
		freeformTags = append(freeformTags, m4aFreeformTag{name: "ISRC", value: strings.TrimSpace(fields["isrc"])})
	}
	if _, ok := fields["label"]; ok {
		removeFreeform["LABEL"] = struct{}{}
		removeFreeform["ORGANIZATION"] = struct{}{}
		freeformTags = append(freeformTags, m4aFreeformTag{name: "LABEL", value: strings.TrimSpace(fields["label"])})
	}
	replayGain := collectM4AReplayGainFields(fields)
	if len(replayGain) > 0 {
		for _, key := range []string{"replaygain_track_gain", "replaygain_track_peak", "replaygain_album_gain", "replaygain_album_peak"} {
			removeFreeform[strings.ToUpper(key)] = struct{}{}
			if value := replayGain[key]; value != "" {
				freeformTags = append(freeformTags, m4aFreeformTag{name: key, value: value})
			}
		}
		removeFreeform["ITUNNORM"] = struct{}{}
		if norm := replayGain["iTunNORM"]; norm != "" {
			freeformTags = append(freeformTags, m4aFreeformTag{name: "iTunNORM", value: norm})
		}
	}
	for _, tag := range freeformTags {
		if tag.value != "" {
			appended = append(appended, buildM4AFreeformAtom(tag.name, tag.value)...)
		}
	}

	editTrack := hasMapKey(fields, "track_number") || hasMapKey(fields, "track_total")
	editDisc := hasMapKey(fields, "disc_number") || hasMapKey(fields, "disc_total")

	coverPath := strings.TrimSpace(fields["cover_path"])
	var coverData []byte
	if coverPath != "" {
		if b, err := os.ReadFile(coverPath); err == nil && len(b) > 0 {
			coverData = b
			dropStandard["covr"] = true
		}
	}

	// Rebuild the ilst body, keeping untouched children verbatim.
	var newBody []byte
	curTrack, curTrackTotal := 0, 0
	curDisc, curDiscTotal := 0, 0
	for pos := loc.ilst.body(); pos+8 <= loc.ilst.end(); {
		child, ok := readMP4Box(data, pos)
		if !ok {
			return fmt.Errorf("malformed ilst child at %d", pos)
		}
		keep := true
		switch {
		case dropStandard[child.typ]:
			keep = false
		case child.typ == "trkn":
			curTrack, curTrackTotal = m4aIndexPairInBuf(data, child)
			keep = !editTrack
		case child.typ == "disk":
			curDisc, curDiscTotal = m4aIndexPairInBuf(data, child)
			keep = !editDisc
		case child.typ == "----":
			name := strings.ToUpper(m4aFreeformNameInBuf(data, child))
			if _, remove := removeFreeform[name]; remove {
				keep = false
			}
		}
		if keep {
			newBody = append(newBody, data[child.offset:child.end()]...)
		}
		pos = child.end()
	}

	if editTrack {
		if v, ok := fields["track_number"]; ok {
			curTrack = parsePositiveInt(v)
		}
		if v, ok := fields["track_total"]; ok {
			curTrackTotal = parsePositiveInt(v)
		}
		if curTrack > 0 {
			appended = append(appended, buildM4AIndexAtom("trkn", curTrack, curTrackTotal)...)
		}
	}
	if editDisc {
		if v, ok := fields["disc_number"]; ok {
			curDisc = parsePositiveInt(v)
		}
		if v, ok := fields["disc_total"]; ok {
			curDiscTotal = parsePositiveInt(v)
		}
		if curDisc > 0 {
			appended = append(appended, buildM4AIndexAtom("disk", curDisc, curDiscTotal)...)
		}
	}
	if len(coverData) > 0 {
		appended = append(appended, buildM4ACoverAtom(coverData)...)
	}
	newBody = append(newBody, appended...)

	newIlst := buildM4AAtom("ilst", newBody)
	delta := int64(len(newIlst)) - loc.ilst.size

	updated := make([]byte, 0, int64(len(data))+delta)
	updated = append(updated, data[:loc.ilst.offset]...)
	updated = append(updated, newIlst...)
	updated = append(updated, data[loc.ilst.end():]...)

	for _, b := range loc.ancestors {
		growBoxSize(updated, b, delta)
	}
	if moov, ok := findChildMP4(updated, 0, int64(len(updated)), "moov"); ok {
		shiftChunkOffsets(updated, moov, moovOffset+loc.ilst.offset, delta)
	}

	return replaceFileSectionsStreaming(filePath, []fileSection{
		{start: moovOffset, end: moovOffset + moovLen, data: updated},
	})
}
