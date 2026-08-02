package gobackend

import (
	"bufio"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	flacvorbis "github.com/go-flac/flacvorbis/v2"
)

// Native Vorbis-comment editor for Ogg Opus/Vorbis files. Rebuilds only the
// comment header packet and repaginates the header pages; audio pages are
// copied verbatim (renumbered + re-CRC'd only when the header page count
// changes). No ffmpeg remux, so foreign comments survive and the container
// layout is untouched. Published via temp+fsync+rename.

// oggCRCTable implements the Ogg page checksum: CRC-32 with polynomial
// 0x04c11db7, no bit reflection, zero init, zero final xor.
var oggCRCTable = func() [256]uint32 {
	var table [256]uint32
	for i := range table {
		r := uint32(i) << 24
		for range 8 {
			if r&0x80000000 != 0 {
				r = (r << 1) ^ 0x04c11db7
			} else {
				r <<= 1
			}
		}
		table[i] = r
	}
	return table
}()

func oggCRC(data []byte) uint32 {
	var crc uint32
	for _, b := range data {
		crc = (crc << 8) ^ oggCRCTable[byte(crc>>24)^b]
	}
	return crc
}

type oggEditPage struct {
	headerType byte
	granule    uint64
	serial     uint32
	seq        uint32
	segments   []byte
	data       []byte
}

func (p *oggEditPage) serialize(w io.Writer) error {
	header := make([]byte, 27)
	copy(header[0:4], "OggS")
	header[5] = p.headerType
	binary.LittleEndian.PutUint64(header[6:14], p.granule)
	binary.LittleEndian.PutUint32(header[14:18], p.serial)
	binary.LittleEndian.PutUint32(header[18:22], p.seq)
	// CRC (bytes 22-26) is computed over the whole page with the field zeroed.
	header[26] = byte(len(p.segments))

	page := make([]byte, 0, len(header)+len(p.segments)+len(p.data))
	page = append(page, header...)
	page = append(page, p.segments...)
	page = append(page, p.data...)
	binary.LittleEndian.PutUint32(page[22:26], oggCRC(page))
	_, err := w.Write(page)
	return err
}

// readNextOggEditPage parses a single page from r. Returns io.EOF at a clean
// page boundary.
func readNextOggEditPage(r *bufio.Reader) (*oggEditPage, error) {
	header := make([]byte, 27)
	if _, err := io.ReadFull(r, header); err != nil {
		if err == io.EOF {
			return nil, io.EOF
		}
		return nil, fmt.Errorf("truncated ogg page header: %w", err)
	}
	if string(header[0:4]) != "OggS" || header[4] != 0 {
		return nil, fmt.Errorf("invalid ogg page")
	}
	page := &oggEditPage{
		headerType: header[5],
		granule:    binary.LittleEndian.Uint64(header[6:14]),
		serial:     binary.LittleEndian.Uint32(header[14:18]),
		seq:        binary.LittleEndian.Uint32(header[18:22]),
		segments:   make([]byte, int(header[26])),
	}
	if _, err := io.ReadFull(r, page.segments); err != nil {
		return nil, err
	}
	size := 0
	for _, s := range page.segments {
		size += int(s)
	}
	page.data = make([]byte, size)
	if _, err := io.ReadFull(r, page.data); err != nil {
		return nil, err
	}
	return page, nil
}

func (p *oggEditPage) byteSize() int64 {
	return int64(27 + len(p.segments) + len(p.data))
}

// readAllOggEditPages parses the entire file into pages, rejecting multiplexed
// (multi-serial) streams the editor cannot safely rewrite. Test helper; the
// editor itself streams and never holds the whole file.
func readAllOggEditPages(f *os.File) ([]oggEditPage, error) {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	br := bufio.NewReader(f)
	var pages []oggEditPage
	for {
		page, err := readNextOggEditPage(br)
		if err == io.EOF {
			if len(pages) > 0 {
				return pages, nil
			}
			return nil, fmt.Errorf("truncated ogg page header: %w", io.EOF)
		}
		if err != nil {
			return nil, err
		}
		if len(pages) > 0 && page.serial != pages[0].serial {
			return nil, fmt.Errorf("multiplexed ogg streams are not supported")
		}
		pages = append(pages, *page)
	}
}

// assembleOggHeaderPackets extracts the first count packets and verifies the
// last one ends exactly at the end of its page (spec-required for Opus/Vorbis
// headers), returning the packets and the index of that last header page.
func assembleOggHeaderPackets(pages []oggEditPage, count int) ([][]byte, int, error) {
	var packets [][]byte
	var cur []byte
	for pageIdx, page := range pages {
		offset := 0
		for segIdx, seg := range page.segments {
			cur = append(cur, page.data[offset:offset+int(seg)]...)
			offset += int(seg)
			if seg < 255 { // packet complete
				packets = append(packets, cur)
				cur = nil
				if len(packets) == count {
					if segIdx != len(page.segments)-1 {
						return nil, 0, fmt.Errorf("header packet shares a page with audio")
					}
					return packets, pageIdx, nil
				}
			}
		}
	}
	return nil, 0, errOggHeaderIncomplete
}

var errOggHeaderIncomplete = errors.New("incomplete ogg header packets")

// paginateOggPackets lays consecutive packets into pages (max 255 segments
// per page), setting the continued-packet flag on pages that begin mid-packet.
func paginateOggPackets(packets [][]byte, serial uint32, firstSeq uint32) []oggEditPage {
	// Build the full lacing sequence with packet-spanning continuation info.
	type lacing struct {
		value byte
		data  []byte
	}
	var segs []lacing
	for _, pkt := range packets {
		rest := pkt
		for {
			n := len(rest)
			if n >= 255 {
				segs = append(segs, lacing{value: 255, data: rest[:255]})
				rest = rest[255:]
				continue
			}
			segs = append(segs, lacing{value: byte(n), data: rest})
			break
		}
	}

	var pages []oggEditPage
	seq := firstSeq
	for start := 0; start < len(segs); {
		end := min(start+255, len(segs))
		page := oggEditPage{granule: 0, serial: serial, seq: seq}
		if start > 0 && segs[start-1].value == 255 {
			page.headerType = 0x01 // continues a packet from the previous page
		}
		for _, s := range segs[start:end] {
			page.segments = append(page.segments, s.value)
			page.data = append(page.data, s.data...)
		}
		pages = append(pages, page)
		seq++
		start = end
	}
	return pages
}

// parseVorbisCommentBlock decodes vendor + raw comment strings.
func parseVorbisCommentBlock(data []byte) (string, []string, error) {
	if len(data) < 4 {
		return "", nil, fmt.Errorf("comment block too short")
	}
	vendorLen := int(binary.LittleEndian.Uint32(data[0:4]))
	pos := 4 + vendorLen
	if vendorLen < 0 || pos+4 > len(data) {
		return "", nil, fmt.Errorf("invalid vendor length")
	}
	vendor := string(data[4 : 4+vendorLen])
	count := int(binary.LittleEndian.Uint32(data[pos : pos+4]))
	pos += 4
	comments := make([]string, 0, count)
	for range count {
		if pos+4 > len(data) {
			return "", nil, fmt.Errorf("truncated comment list")
		}
		l := int(binary.LittleEndian.Uint32(data[pos : pos+4]))
		pos += 4
		if l < 0 || pos+l > len(data) {
			return "", nil, fmt.Errorf("truncated comment entry")
		}
		comments = append(comments, string(data[pos:pos+l]))
		pos += l
	}
	return vendor, comments, nil
}

func serializeVorbisCommentBlock(vendor string, comments []string) []byte {
	size := 4 + len(vendor) + 4
	for _, c := range comments {
		size += 4 + len(c)
	}
	out := make([]byte, 0, size)
	var num [4]byte
	binary.LittleEndian.PutUint32(num[:], uint32(len(vendor)))
	out = append(out, num[:]...)
	out = append(out, vendor...)
	binary.LittleEndian.PutUint32(num[:], uint32(len(comments)))
	out = append(out, num[:]...)
	for _, c := range comments {
		binary.LittleEndian.PutUint32(num[:], uint32(len(c)))
		out = append(out, num[:]...)
		out = append(out, c...)
	}
	return out
}

// EditOggFields updates only the Vorbis comments whose keys are explicitly
// present in the fields map (same semantics as EditFlacFields) in an Ogg
// Opus or Vorbis file, preserving all other comments and the audio verbatim.
func EditOggFields(filePath string, fields map[string]string) error {
	f, err := os.Open(filePath)
	if err != nil {
		return err
	}
	// Read only the header pages into memory; audio pages are streamed to the
	// temp file later — a full-album Opus file would otherwise sit whole on
	// the heap.
	br := bufio.NewReaderSize(f, 64<<10)
	firstPage, err := readNextOggEditPage(br)
	if err != nil {
		f.Close()
		if err == io.EOF {
			return fmt.Errorf("ogg stream too short")
		}
		return err
	}

	// Identify the codec from the first packet (BOS page).
	first := firstPage.data
	var headerPacketCount int
	var isOpus bool
	switch {
	case len(first) >= 8 && string(first[0:8]) == "OpusHead":
		isOpus = true
		headerPacketCount = 2 // OpusHead, OpusTags
	case len(first) >= 7 && first[0] == 0x01 && string(first[1:7]) == "vorbis":
		headerPacketCount = 3 // id, comment, setup
	default:
		f.Close()
		return fmt.Errorf("unsupported ogg codec")
	}

	headerPages := []oggEditPage{*firstPage}
	headerBytes := firstPage.byteSize()
	var packets [][]byte
	for {
		var assembleErr error
		packets, _, assembleErr = assembleOggHeaderPackets(headerPages, headerPacketCount)
		if assembleErr == nil {
			break
		}
		if !errors.Is(assembleErr, errOggHeaderIncomplete) {
			f.Close()
			return assembleErr
		}
		if len(headerPages) >= 1024 {
			f.Close()
			return fmt.Errorf("ogg header spans too many pages")
		}
		page, readErr := readNextOggEditPage(br)
		if readErr != nil {
			f.Close()
			if readErr == io.EOF {
				return assembleErr
			}
			return readErr
		}
		if page.serial != firstPage.serial {
			f.Close()
			return fmt.Errorf("multiplexed ogg streams are not supported")
		}
		headerPages = append(headerPages, *page)
		headerBytes += page.byteSize()
	}

	// Decode the comment packet.
	commentPacket := packets[1]
	var commentBody []byte
	switch {
	case isOpus && len(commentPacket) >= 8 && string(commentPacket[0:8]) == "OpusTags":
		commentBody = commentPacket[8:]
	case !isOpus && len(commentPacket) >= 7 && commentPacket[0] == 0x03 && string(commentPacket[1:7]) == "vorbis":
		commentBody = commentPacket[7:] // trailing framing bit is ignored by the length-driven parser
	default:
		f.Close()
		return fmt.Errorf("comment header not found")
	}

	vendor, comments, err := parseVorbisCommentBlock(commentBody)
	if err != nil {
		f.Close()
		return err
	}

	cmt := flacvorbis.New()
	cmt.Vendor = vendor
	cmt.Comments = comments
	applyVorbisFieldEdits(cmt, fields)

	coverPath := strings.TrimSpace(fields["cover_path"])
	if coverPath != "" && fileExists(coverPath) {
		if coverData, err := os.ReadFile(coverPath); err == nil && len(coverData) > 0 {
			if picBlock, err := buildPictureBlock("", coverData); err == nil {
				removeCommentKey(cmt, "METADATA_BLOCK_PICTURE")
				encoded := base64.StdEncoding.EncodeToString(picBlock.Data)
				cmt.Comments = append(cmt.Comments, "METADATA_BLOCK_PICTURE="+encoded)
			}
		}
	}

	newBody := serializeVorbisCommentBlock(cmt.Vendor, cmt.Comments)
	var newComment []byte
	if isOpus {
		newComment = append([]byte("OpusTags"), newBody...)
	} else {
		newComment = append([]byte{0x03}, []byte("vorbis")...)
		newComment = append(newComment, newBody...)
		newComment = append(newComment, 0x01) // framing bit
	}

	headerPackets := [][]byte{newComment}
	if !isOpus {
		headerPackets = append(headerPackets, packets[2]) // setup header, verbatim
	}
	newHeaderPages := paginateOggPackets(headerPackets, firstPage.serial, 1)

	tmpPath := filePath + ".tag.partial"
	os.Remove(tmpPath)
	tmp, err := os.Create(tmpPath)
	if err != nil {
		f.Close()
		return err
	}
	cleanup := func(err error) error {
		tmp.Close()
		os.Remove(tmpPath)
		f.Close()
		return err
	}

	if err := firstPage.serialize(tmp); err != nil {
		return cleanup(err)
	}
	for i := range newHeaderPages {
		if err := newHeaderPages[i].serialize(tmp); err != nil {
			return cleanup(err)
		}
	}
	if len(newHeaderPages)+1 == len(headerPages) {
		// Header page count unchanged: audio pages' sequence numbers and CRCs
		// are still valid, copy them through verbatim.
		if _, err := f.Seek(headerBytes, io.SeekStart); err != nil {
			return cleanup(err)
		}
		if _, err := io.Copy(tmp, f); err != nil {
			return cleanup(err)
		}
	} else {
		nextSeq := uint32(1 + len(newHeaderPages))
		for {
			page, readErr := readNextOggEditPage(br)
			if readErr == io.EOF {
				break
			}
			if readErr != nil {
				return cleanup(readErr)
			}
			if page.serial != firstPage.serial {
				return cleanup(fmt.Errorf("multiplexed ogg streams are not supported"))
			}
			page.seq = nextSeq
			nextSeq++
			if err := page.serialize(tmp); err != nil {
				return cleanup(err)
			}
		}
	}

	if err := tmp.Sync(); err != nil {
		return cleanup(err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		f.Close()
		return err
	}
	f.Close() // release before rename (required on Windows)
	if err := os.Rename(tmpPath, filePath); err != nil {
		os.Remove(tmpPath)
		return err
	}
	syncDir(filepath.Dir(filePath))
	return nil
}
