package gobackend

import "testing"

func TestParseALACSpecificConfigStandardPayload(t *testing.T) {
	payload := make([]byte, 24)
	payload[5] = 24
	payload[20] = 0x00
	payload[21] = 0x00
	payload[22] = 0xac
	payload[23] = 0x44

	bitDepth, sampleRate, ok := parseALACSpecificConfig(payload)
	if !ok {
		t.Fatal("expected standard ALAC payload to parse")
	}
	if bitDepth != 24 {
		t.Fatalf("bitDepth = %d, want 24", bitDepth)
	}
	if sampleRate != 44100 {
		t.Fatalf("sampleRate = %d, want 44100", sampleRate)
	}
}

func TestParseALACSpecificConfigPayloadWithLeadingFourBytes(t *testing.T) {
	payload := make([]byte, 28)
	payload[9] = 16
	payload[24] = 0x00
	payload[25] = 0x00
	payload[26] = 0xbb
	payload[27] = 0x80

	bitDepth, sampleRate, ok := parseALACSpecificConfig(payload)
	if !ok {
		t.Fatal("expected offset ALAC payload to parse")
	}
	if bitDepth != 16 {
		t.Fatalf("bitDepth = %d, want 16", bitDepth)
	}
	if sampleRate != 48000 {
		t.Fatalf("sampleRate = %d, want 48000", sampleRate)
	}
}

func TestParseALACSpecificConfigRejectsShortPayload(t *testing.T) {
	if _, _, ok := parseALACSpecificConfig(make([]byte, 12)); ok {
		t.Fatal("expected short ALAC payload to be rejected")
	}
}

func TestM4ACodecFormatMapping(t *testing.T) {
	cases := map[string]string{
		"mp4a": "aac",
		"alac": "alac",
		"fLaC": "flac",
		"ec-3": "eac3",
		"ac-3": "ac3",
		"ac-4": "ac4",
	}
	for atomType, want := range cases {
		if got := normalizeM4AAudioCodec(atomType); got != want {
			t.Fatalf("normalizeM4AAudioCodec(%q) = %q, want %q", atomType, got, want)
		}
	}

	if got := libraryFormatForM4ACodec("flac"); got != "flac" {
		t.Fatalf("libraryFormatForM4ACodec(flac) = %q", got)
	}
	if got := libraryFormatForM4ACodec("eac3"); got != "eac3" {
		t.Fatalf("libraryFormatForM4ACodec(eac3) = %q", got)
	}
	if got := libraryFormatForM4ACodec("aac"); got != "m4a" {
		t.Fatalf("libraryFormatForM4ACodec(aac) = %q", got)
	}
}

func TestParseMP4FLACSpecificConfig(t *testing.T) {
	streamInfo := make([]byte, 34)
	sampleRate := 48000
	bitsPerSample := 24
	totalSamples := int64(48000 * 180)
	streamInfo[10] = byte(sampleRate >> 12)
	streamInfo[11] = byte(sampleRate >> 4)
	streamInfo[12] = byte((sampleRate&0x0F)<<4 | ((bitsPerSample-1)>>4)&0x01)
	streamInfo[13] = byte(((bitsPerSample-1)&0x0F)<<4 | int((totalSamples>>32)&0x0F))
	streamInfo[14] = byte(totalSamples >> 24)
	streamInfo[15] = byte(totalSamples >> 16)
	streamInfo[16] = byte(totalSamples >> 8)
	streamInfo[17] = byte(totalSamples)

	payload := append([]byte{0, 0, 0, 0, 0, 0, 0, 34}, streamInfo...)
	bitDepth, parsedRate, parsedSamples, ok := parseMP4FLACSpecificConfig(payload)
	if !ok {
		t.Fatal("expected MP4 FLAC config to parse")
	}
	if bitDepth != bitsPerSample || parsedRate != sampleRate || parsedSamples != totalSamples {
		t.Fatalf("FLAC config = %d/%d/%d", bitDepth, parsedRate, parsedSamples)
	}
}
