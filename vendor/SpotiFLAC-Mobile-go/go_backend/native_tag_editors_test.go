package gobackend

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// --- MP3 -------------------------------------------------------------------

func writeTestMP3(t *testing.T, dir string, frames ...[]byte) (string, []byte) {
	t.Helper()
	audio := []byte("FAKEMP3AUDIODATA-0123456789")
	tag := buildID3v23Tag(frames...)
	path := filepath.Join(dir, "test.mp3")
	if err := os.WriteFile(path, append(append([]byte{}, tag...), audio...), 0o644); err != nil {
		t.Fatalf("write mp3: %v", err)
	}
	return path, audio
}

func TestEditMP3FieldsPreservesForeignFrames(t *testing.T) {
	dir := t.TempDir()
	popm := id3v23Frame("POPM", append([]byte("rater@example.com\x00"), 0xff))
	foreignTXXX := id3UserTextFrame("TXXX", "MusicBrainz Id", "abc-123")
	rgTXXX := id3UserTextFrame("TXXX", "REPLAYGAIN_TRACK_GAIN", "-1.00 dB")
	path, audio := writeTestMP3(t, dir,
		id3TextFrame("TIT2", "Old Title"),
		id3TextFrame("TRCK", "3"),
		popm, foreignTXXX, rgTXXX,
	)

	err := EditMP3Fields(path, map[string]string{
		"title":                 "New Title",
		"track_total":           "12",
		"replaygain_track_gain": "-2.50 dB",
	})
	if err != nil {
		t.Fatalf("EditMP3Fields: %v", err)
	}

	meta, err := ReadID3Tags(path)
	if err != nil {
		t.Fatalf("ReadID3Tags: %v", err)
	}
	if meta.Title != "New Title" {
		t.Errorf("title = %q, want New Title", meta.Title)
	}
	if meta.TrackNumber != 3 || meta.TotalTracks != 12 {
		t.Errorf("track = %d/%d, want 3/12 (merge with existing number)", meta.TrackNumber, meta.TotalTracks)
	}
	if meta.ReplayGainTrackGain != "-2.50 dB" {
		t.Errorf("replaygain = %q, want -2.50 dB", meta.ReplayGainTrackGain)
	}

	raw := mustReadFile(t, path)
	if !bytes.Contains(raw, []byte("POPM")) || !bytes.Contains(raw, []byte("rater@example.com")) {
		t.Error("foreign POPM frame was dropped")
	}
	if !bytes.Contains(raw, []byte("MusicBrainz Id")) {
		t.Error("foreign TXXX frame was dropped")
	}
	if bytes.Count(raw, []byte("REPLAYGAIN_TRACK_GAIN")) != 1 {
		t.Error("edited TXXX description duplicated or missing")
	}
	if !bytes.HasSuffix(raw, audio) {
		t.Error("audio bytes were modified")
	}
}

func TestEditMP3FieldsClearsAndWithoutTag(t *testing.T) {
	dir := t.TempDir()
	path, audio := writeTestMP3(t, dir,
		id3TextFrame("TIT2", "Old"),
		id3CommentFrame("COMM", "remove me"),
	)
	if err := EditMP3Fields(path, map[string]string{"comment": ""}); err != nil {
		t.Fatalf("clear comment: %v", err)
	}
	raw := mustReadFile(t, path)
	if bytes.Contains(raw, []byte("remove me")) {
		t.Error("cleared comment still present")
	}
	if meta, _ := ReadID3Tags(path); meta == nil || meta.Title != "Old" {
		t.Error("untouched title lost")
	}

	// A bare MP3 with no ID3v2 header gets a fresh tag prepended.
	bare := filepath.Join(dir, "bare.mp3")
	if err := os.WriteFile(bare, audio, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := EditMP3Fields(bare, map[string]string{"title": "Fresh"}); err != nil {
		t.Fatalf("EditMP3Fields on bare file: %v", err)
	}
	if meta, err := ReadID3Tags(bare); err != nil || meta.Title != "Fresh" {
		t.Errorf("bare file title = %v (err %v), want Fresh", meta, err)
	}
	if !bytes.HasSuffix(mustReadFile(t, bare), audio) {
		t.Error("bare file audio modified")
	}
}

// --- M4A -------------------------------------------------------------------

// buildTestM4A assembles ftyp + moov(trak stub with stco + udta>meta>ilst) + mdat
// with moov BEFORE mdat so chunk-offset shifting is exercised.
func buildTestM4A(t *testing.T, ilstChildren []byte, mdatPayload []byte) ([]byte, int64) {
	t.Helper()
	ftyp := buildM4AAtom("ftyp", append([]byte("M4A "), make([]byte, 8)...))

	hdlrPayload := make([]byte, 25)
	copy(hdlrPayload[8:12], "mdir")
	copy(hdlrPayload[12:16], "appl")
	meta := buildM4AAtom("meta", append(append([]byte{0, 0, 0, 0}, buildM4AAtom("hdlr", hdlrPayload)...), buildM4AAtom("ilst", ilstChildren)...))
	udta := buildM4AAtom("udta", meta)

	// stco with one entry; the real value is patched below once mdat's
	// position is known.
	stcoPayload := make([]byte, 4+4+4)
	binary.BigEndian.PutUint32(stcoPayload[4:8], 1)
	stco := buildM4AAtom("stco", stcoPayload)
	stbl := buildM4AAtom("stbl", stco)
	minf := buildM4AAtom("minf", stbl)
	mdia := buildM4AAtom("mdia", minf)
	trak := buildM4AAtom("trak", mdia)

	moov := buildM4AAtom("moov", append(append([]byte{}, trak...), udta...))
	mdat := buildM4AAtom("mdat", mdatPayload)

	file := append(append(append([]byte{}, ftyp...), moov...), mdat...)
	chunkOffset := int64(len(ftyp) + len(moov) + 8) // first byte of mdat payload
	idx := bytes.Index(file, []byte("stco"))
	if idx < 0 {
		t.Fatal("stco not found in synthetic file")
	}
	binary.BigEndian.PutUint32(file[idx+4+8:idx+4+12], uint32(chunkOffset))
	return file, chunkOffset
}

func readTestM4ATitle(t *testing.T, data []byte) string {
	t.Helper()
	loc, ok := locateM4AIlstInBuf(data)
	if !ok {
		t.Fatal("ilst not found")
	}
	for pos := loc.ilst.body(); pos+8 <= loc.ilst.end(); {
		child, ok := readMP4Box(data, pos)
		if !ok {
			t.Fatal("malformed ilst")
		}
		if child.typ == "\xa9nam" {
			d, ok := readMP4Box(data, child.body())
			if !ok || d.typ != "data" {
				t.Fatal("no data atom in \xa9nam")
			}
			return string(data[d.body()+8 : d.end()])
		}
		pos = child.end()
	}
	return ""
}

func TestEditM4AFieldsPreservesAtomsAndShiftsChunkOffsets(t *testing.T) {
	dir := t.TempDir()
	existing := append([]byte{}, buildM4ATextAtom("\xa9nam", "Old")...)
	existing = append(existing, buildM4ATextAtom("\xa9too", "SomeEncoder")...) // foreign, untouched
	existing = append(existing, buildM4AFreeformAtom("MusicBrainz Track Id", "xyz")...)
	mdatPayload := []byte("M4ADATA")
	file, oldOffset := buildTestM4A(t, existing, mdatPayload)

	path := filepath.Join(dir, "test.m4a")
	if err := os.WriteFile(path, file, 0o644); err != nil {
		t.Fatal(err)
	}

	if err := EditM4AFields(path, map[string]string{
		"title": "A Much Longer Replacement Title",
		"isrc":  "USABC1234567",
	}); err != nil {
		t.Fatalf("EditM4AFields: %v", err)
	}

	updated := mustReadFile(t, path)
	if got := readTestM4ATitle(t, updated); got != "A Much Longer Replacement Title" {
		t.Errorf("title = %q", got)
	}
	if !bytes.Contains(updated, []byte("SomeEncoder")) {
		t.Error("foreign \xa9too atom dropped")
	}
	if !bytes.Contains(updated, []byte("MusicBrainz Track Id")) {
		t.Error("foreign freeform atom dropped")
	}
	if !bytes.Contains(updated, []byte("USABC1234567")) {
		t.Error("ISRC freeform missing")
	}

	// stco entry must still point at the mdat payload.
	idx := bytes.Index(updated, []byte("stco"))
	if idx < 0 {
		t.Fatal("stco lost")
	}
	newOffset := int64(binary.BigEndian.Uint32(updated[idx+4+8 : idx+4+12]))
	payloadAt := bytes.Index(updated, mdatPayload)
	if newOffset != int64(payloadAt) {
		t.Errorf("stco offset %d does not track mdat payload at %d (was %d)", newOffset, payloadAt, oldOffset)
	}
}

func TestEditM4AFieldsCreatesMissingChain(t *testing.T) {
	dir := t.TempDir()
	// moov with only a trak stub — no udta/meta/ilst.
	stcoPayload := make([]byte, 12)
	binary.BigEndian.PutUint32(stcoPayload[4:8], 1)
	trak := buildM4AAtom("trak", buildM4AAtom("mdia", buildM4AAtom("minf", buildM4AAtom("stbl", buildM4AAtom("stco", stcoPayload)))))
	moov := buildM4AAtom("moov", trak)
	ftyp := buildM4AAtom("ftyp", append([]byte("M4A "), make([]byte, 8)...))
	mdat := buildM4AAtom("mdat", []byte("DATA"))
	file := append(append(append([]byte{}, ftyp...), moov...), mdat...)

	path := filepath.Join(dir, "bare.m4a")
	if err := os.WriteFile(path, file, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := EditM4AFields(path, map[string]string{"title": "Created"}); err != nil {
		t.Fatalf("EditM4AFields: %v", err)
	}
	if got := readTestM4ATitle(t, mustReadFile(t, path)); got != "Created" {
		t.Errorf("title = %q, want Created", got)
	}
}

// --- Ogg/Opus ---------------------------------------------------------------

func buildTestOpus(t *testing.T, path string, comments []string, audioPages int) {
	t.Helper()
	head := append([]byte("OpusHead"), make([]byte, 11)...)
	tags := append([]byte("OpusTags"), serializeVorbisCommentBlock("test-vendor", comments)...)

	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	bos := oggEditPage{headerType: 0x02, serial: 0xBEEF, seq: 0, segments: []byte{byte(len(head))}, data: head}
	if err := bos.serialize(f); err != nil {
		t.Fatal(err)
	}
	for _, p := range paginateOggPackets([][]byte{tags}, 0xBEEF, 1) {
		if err := p.serialize(f); err != nil {
			t.Fatal(err)
		}
	}
	seq := uint32(2)
	for i := 0; i < audioPages; i++ {
		audio := bytes.Repeat([]byte{byte(0x40 + i)}, 100)
		page := oggEditPage{granule: uint64((i + 1) * 960), serial: 0xBEEF, seq: seq, segments: []byte{100}, data: audio}
		if i == audioPages-1 {
			page.headerType = 0x04 // EOS
		}
		if err := page.serialize(f); err != nil {
			t.Fatal(err)
		}
		seq++
	}
}

func TestEditOggFieldsPreservesForeignComments(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.opus")
	buildTestOpus(t, path, []string{"TITLE=Old", "FOO=BAR", "ENCODER=opusenc"}, 3)

	if err := EditOggFields(path, map[string]string{"title": "New Title"}); err != nil {
		t.Fatalf("EditOggFields: %v", err)
	}

	meta, err := ReadOggVorbisComments(path)
	if err != nil {
		t.Fatalf("ReadOggVorbisComments: %v", err)
	}
	if meta.Title != "New Title" {
		t.Errorf("title = %q, want New Title", meta.Title)
	}
	raw := mustReadFile(t, path)
	if !bytes.Contains(raw, []byte("FOO=BAR")) || !bytes.Contains(raw, []byte("ENCODER=opusenc")) {
		t.Error("foreign comments dropped")
	}

	// The stream must reparse with sequential page numbers and valid layout.
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	pages, err := readAllOggEditPages(f)
	if err != nil {
		t.Fatalf("reparse: %v", err)
	}
	for i, p := range pages {
		if p.seq != uint32(i) {
			t.Errorf("page %d has seq %d", i, p.seq)
		}
	}
}

func TestEditOggFieldsGrowingCommentRenumbersAudioPages(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "grow.opus")
	buildTestOpus(t, path, []string{"TITLE=Old"}, 2)

	// >64KB of lyrics forces the OpusTags packet across multiple pages.
	if err := EditOggFields(path, map[string]string{"lyrics": strings.Repeat("la ", 30000)}); err != nil {
		t.Fatalf("EditOggFields: %v", err)
	}

	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	pages, err := readAllOggEditPages(f)
	if err != nil {
		t.Fatalf("reparse: %v", err)
	}
	if len(pages) < 4 {
		t.Fatalf("expected multi-page comment, got %d pages", len(pages))
	}
	for i, p := range pages {
		if p.seq != uint32(i) {
			t.Errorf("page %d has seq %d", i, p.seq)
		}
	}
	// Audio payloads intact after renumbering.
	last := pages[len(pages)-1]
	if last.headerType&0x04 == 0 || !bytes.Equal(last.data, bytes.Repeat([]byte{0x41}, 100)) {
		t.Error("audio pages corrupted by renumbering")
	}
	if meta, err := ReadOggVorbisComments(path); err != nil || meta.Title != "Old" {
		t.Errorf("untouched title lost: %v (err %v)", meta, err)
	}
}
