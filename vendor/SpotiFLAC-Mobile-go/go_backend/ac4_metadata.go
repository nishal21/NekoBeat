package gobackend

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"strconv"
	"strings"
)

// ac4Metadata mirrors the tag fields the app embeds for other formats. Numeric
// fields are strings because they arrive as a JSON-encoded map of strings.
type ac4Metadata struct {
	Title       string `json:"title"`
	Artist      string `json:"artist"`
	Album       string `json:"album"`
	AlbumArtist string `json:"albumArtist"`
	Date        string `json:"date"`
	Genre       string `json:"genre"`
	Composer    string `json:"composer"`
	TrackNumber string `json:"trackNumber"`
	TotalTracks string `json:"totalTracks"`
	DiscNumber  string `json:"discNumber"`
	TotalDiscs  string `json:"totalDiscs"`
	ISRC        string `json:"isrc"`
	Label       string `json:"label"`
	Copyright   string `json:"copyright"`
	Lyrics      string `json:"lyrics"`
}

func atoiSafe(s string) int {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0
	}
	return n
}

func itunesTextTag(atomType, value string) []byte {
	data := make([]byte, 8+len(value))
	binary.BigEndian.PutUint32(data[0:4], 1) // well-known type 1 = UTF-8
	copy(data[8:], []byte(value))
	return buildM4AAtom(atomType, buildM4AAtom("data", data))
}

func itunesNumberPairTag(atomType string, number, total int) []byte {
	payload := make([]byte, 8)
	binary.BigEndian.PutUint16(payload[2:4], uint16(number))
	binary.BigEndian.PutUint16(payload[4:6], uint16(total))
	data := make([]byte, 8+len(payload))
	binary.BigEndian.PutUint32(data[0:4], 0) // type 0 = implicit/binary
	copy(data[8:], payload)
	return buildM4AAtom(atomType, buildM4AAtom("data", data))
}

func itunesCoverTag(image []byte) []byte {
	typeCode := uint32(13) // JPEG
	if len(image) >= 8 &&
		image[0] == 0x89 && image[1] == 0x50 && image[2] == 0x4E && image[3] == 0x47 {
		typeCode = 14 // PNG
	}
	data := make([]byte, 8+len(image))
	binary.BigEndian.PutUint32(data[0:4], typeCode)
	copy(data[8:], image)
	return buildM4AAtom("covr", buildM4AAtom("data", data))
}

func itunesMetadataHandler() []byte {
	payload := make([]byte, 0, 25)
	payload = append(payload, 0, 0, 0, 0)             // version + flags
	payload = append(payload, 0, 0, 0, 0)             // pre_defined
	payload = append(payload, []byte("mdir")...)      // handler type
	payload = append(payload, []byte("appl")...)      // reserved[0]
	payload = append(payload, 0, 0, 0, 0, 0, 0, 0, 0) // reserved[1..2]
	payload = append(payload, 0)                      // empty name
	return buildM4AAtom("hdlr", payload)
}

// buildITunesUdta assembles a fresh udta>meta>(hdlr+ilst) box from metadata.
func buildITunesUdta(md ac4Metadata, cover []byte) []byte {
	ilst := make([]byte, 0, 256)
	add := func(atomType, value string) {
		if strings.TrimSpace(value) != "" {
			ilst = append(ilst, itunesTextTag(atomType, value)...)
		}
	}
	add("\xa9nam", md.Title)
	add("\xa9ART", md.Artist)
	add("\xa9alb", md.Album)
	add("aART", md.AlbumArtist)
	add("\xa9day", md.Date)
	add("\xa9gen", md.Genre)
	add("\xa9wrt", md.Composer)
	if tn := atoiSafe(md.TrackNumber); tn > 0 {
		ilst = append(ilst, itunesNumberPairTag("trkn", tn, atoiSafe(md.TotalTracks))...)
	}
	if dn := atoiSafe(md.DiscNumber); dn > 0 {
		ilst = append(ilst, itunesNumberPairTag("disk", dn, atoiSafe(md.TotalDiscs))...)
	}
	if strings.TrimSpace(md.ISRC) != "" {
		ilst = append(ilst, buildM4AFreeformAtom("ISRC", strings.TrimSpace(md.ISRC))...)
	}
	if strings.TrimSpace(md.Label) != "" {
		ilst = append(ilst, buildM4AFreeformAtom("LABEL", strings.TrimSpace(md.Label))...)
	}
	if strings.TrimSpace(md.Copyright) != "" {
		add("cprt", md.Copyright)
	}
	if strings.TrimSpace(md.Lyrics) != "" {
		add("\xa9lyr", md.Lyrics)
	}
	if len(cover) > 0 {
		ilst = append(ilst, itunesCoverTag(cover)...)
	}

	ilstBox := buildM4AAtom("ilst", ilst)
	metaPayload := append([]byte{0, 0, 0, 0}, itunesMetadataHandler()...)
	metaPayload = append(metaPayload, ilstBox...)
	meta := buildM4AAtom("meta", metaPayload)
	return buildM4AAtom("udta", meta)
}

// writeMP4iTunesMetadata replaces (or inserts) a udta>meta>ilst metadata box in
// the moov of an MP4 buffer and returns the rewritten bytes. base is the
// buffer's absolute file offset (0 for a whole-file buffer) so stco/co64
// shifts compare against the absolute positions the entries hold.
func writeMP4iTunesMetadata(data []byte, base int64, md ac4Metadata, cover []byte) []byte {
	moov, ok := findChildMP4(data, 0, int64(len(data)), "moov")
	if !ok {
		return data
	}
	newUdta := buildITunesUdta(md, cover)

	if udta, ok := findChildMP4(data, moov.body(), moov.end(), "udta"); ok {
		delta := int64(len(newUdta)) - udta.size
		shiftChunkOffsets(data, moov, base+udta.offset, delta)
		growBoxSize(data, moov, delta)
		out := make([]byte, 0, len(data)+len(newUdta))
		out = append(out, data[:udta.offset]...)
		out = append(out, newUdta...)
		out = append(out, data[udta.end():]...)
		return out
	}

	delta := int64(len(newUdta))
	insertPos := moov.end()
	shiftChunkOffsets(data, moov, base+insertPos, delta)
	growBoxSize(data, moov, delta)
	out := make([]byte, 0, len(data)+len(newUdta))
	out = append(out, data[:insertPos]...)
	out = append(out, newUdta...)
	out = append(out, data[insertPos:]...)
	return out
}

// WriteAC4MetadataIfApplicable writes iTunes metadata into an AC-4 MP4. Returns
// true when the file was an AC-4 track and metadata was written; false when the
// file is not AC-4 (the caller should fall back to its normal metadata path).
// Only the moov box is held in memory; the audio bulk is streamed.
func WriteAC4MetadataIfApplicable(decryptedPath, metadataJSON, coverPath string) (bool, error) {
	f, err := os.Open(decryptedPath)
	if err != nil {
		return false, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return false, err
	}
	moovBuf, moovOffset, found, err := loadTopLevelMP4Box(f, info.Size(), "moov")
	f.Close()
	if err != nil {
		return false, err
	}
	if !found {
		return false, nil
	}
	moovLen := int64(len(moovBuf))
	if _, ok := locateAC4Entry(moovBuf); !ok {
		return false, nil
	}

	var md ac4Metadata
	if strings.TrimSpace(metadataJSON) != "" {
		_ = json.Unmarshal([]byte(metadataJSON), &md)
	}
	var cover []byte
	if strings.TrimSpace(coverPath) != "" {
		if b, err := os.ReadFile(coverPath); err == nil {
			cover = b
		}
	}

	out := writeMP4iTunesMetadata(moovBuf, moovOffset, md, cover)
	if err := replaceFileSectionsStreaming(decryptedPath, []fileSection{
		{start: moovOffset, end: moovOffset + moovLen, data: out},
	}); err != nil {
		return false, err
	}
	return true, nil
}
