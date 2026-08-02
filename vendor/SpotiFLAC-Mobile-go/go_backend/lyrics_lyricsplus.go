package gobackend

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// LyricsPlus (KPOE) provider.
//
// LyricsPlus aggregates word-by-word ("karaoke") synced lyrics from Apple
// Music, Musixmatch, Spotify and QQ Music via a community-run backend. It
// frequently has word-level timing for tracks that other providers only offer
// line-synced or not at all.
//
// API: GET {server}/v2/lyrics/get?title=&artist=&album=&duration=&isrc=
// The response is the KPOE JSON format which we convert into the same enhanced
// LRC text the Apple/QQ providers emit, so embedding/export behaves identically.

// Public LyricsPlus / KPOE servers (mirrors). Tried in order with failover.
// Sourced from the upstream YouLy+ client server list.
var lyricsPlusServers = []string{
	"https://lyricsplus.prjktla.workers.dev",
	"https://lyricsplus.binimum.org",
}

type LyricsPlusClient struct {
	httpClient *http.Client
}

func NewLyricsPlusClient() *LyricsPlusClient {
	return &LyricsPlusClient{httpClient: NewMetadataHTTPClient(15 * time.Second)}
}

type lyricsPlusSyllable struct {
	Text         string  `json:"text"`
	Time         float64 `json:"time"`     // absolute ms
	Duration     float64 `json:"duration"` // ms
	IsBackground bool    `json:"isBackground"`
}

type lyricsPlusLine struct {
	Time     float64              `json:"time"`     // absolute ms
	Duration float64              `json:"duration"` // ms
	Text     string               `json:"text"`
	Syllabus []lyricsPlusSyllable `json:"syllabus"`
}

type lyricsPlusResponse struct {
	Type   string           `json:"type"` // "Word" | "Line" | "Syllable" | "None"
	Lyrics []lyricsPlusLine `json:"lyrics"`
}

// FetchLyrics tries each LyricsPlus server in order until one returns usable
// lyrics. multiPersonWordByWord and preserveWordTiming mirror the Apple/QQ
// options so word/background timing is only emitted when the user enabled it.
func (c *LyricsPlusClient) FetchLyrics(
	trackName,
	artistName,
	isrc string,
	durationSec float64,
	multiPersonWordByWord bool,
	preserveWordTiming bool,
) (*LyricsResponse, error) {
	if strings.TrimSpace(trackName) == "" || strings.TrimSpace(artistName) == "" {
		return nil, fmt.Errorf("lyricsplus: missing track or artist")
	}

	var lastErr error
	for _, server := range lyricsPlusServers {
		lyrics, err := c.fetchFromServer(server, trackName, artistName, isrc, durationSec, multiPersonWordByWord, preserveWordTiming)
		if err == nil && lyricsHasUsableText(lyrics) {
			return lyrics, nil
		}
		if err != nil {
			lastErr = err
			GoLog("[Lyrics] LyricsPlus server %s failed: %v\n", server, err)
		}
	}

	if lastErr != nil {
		return nil, lastErr
	}
	return nil, lyricsNotFoundErrorf("lyricsplus: no lyrics found")
}

func (c *LyricsPlusClient) fetchFromServer(
	server,
	trackName,
	artistName,
	isrc string,
	durationSec float64,
	multiPersonWordByWord bool,
	preserveWordTiming bool,
) (*LyricsResponse, error) {
	base := strings.TrimRight(strings.TrimSpace(server), "/")
	if base == "" {
		return nil, fmt.Errorf("empty server")
	}

	params := url.Values{}
	params.Set("title", trackName)
	params.Set("artist", artistName)
	if durationSec > 0 {
		params.Set("duration", strconv.FormatFloat(durationSec, 'f', 3, 64))
	}
	if strings.TrimSpace(isrc) != "" {
		params.Set("isrc", strings.TrimSpace(isrc))
	}

	fullURL := base + "/v2/lyrics/get?" + params.Encode()

	req, err := http.NewRequest("GET", fullURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", appUserAgent())

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		// Retry without the ISRC filter, which can be too strict.
		if strings.TrimSpace(isrc) != "" {
			return c.fetchFromServer(server, trackName, artistName, "", durationSec, multiPersonWordByWord, preserveWordTiming)
		}
		return nil, lyricsNotFoundErrorf("lyrics not found")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, lyricsHTTPStatusError(resp.StatusCode, "HTTP %d", resp.StatusCode)
	}

	var payload lyricsPlusResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("failed to decode lyricsplus response: %w", err)
	}
	if len(payload.Lyrics) == 0 {
		return nil, fmt.Errorf("lyricsplus returned no lines")
	}

	lrcText := buildLyricsPlusLRC(&payload, multiPersonWordByWord, preserveWordTiming)
	if strings.TrimSpace(lrcText) == "" {
		return nil, fmt.Errorf("lyricsplus produced empty lyrics")
	}

	lyrics := lyricsResponseFromText(lrcText, "LyricsPlus")
	return lyrics, nil
}

// buildLyricsPlusLRC converts the KPOE JSON into enhanced LRC text. When word
// timing is available and enabled, each syllable is emitted as an inline
// <mm:ss.xx> tag (matching the Apple/QQ output); otherwise a line-synced LRC
// is produced from the full line text.
func buildLyricsPlusLRC(resp *lyricsPlusResponse, multiPersonWordByWord bool, preserveWordTiming bool) string {
	isWordType := strings.EqualFold(resp.Type, "Word") || strings.EqualFold(resp.Type, "Syllable")

	var sb strings.Builder
	first := true
	for _, line := range resp.Lyrics {
		lineText := line.Text
		hasSyllables := len(line.Syllabus) > 0

		timestamp := msToLRCTimestamp(int64(line.Time))

		if isWordType && preserveWordTiming && hasSyllables {
			mainSyllables := make([]lyricsPlusSyllable, 0, len(line.Syllabus))
			bgSyllables := make([]lyricsPlusSyllable, 0)
			for _, syl := range line.Syllabus {
				if syl.IsBackground {
					bgSyllables = append(bgSyllables, syl)
				} else {
					mainSyllables = append(mainSyllables, syl)
				}
			}
			if len(mainSyllables) == 0 {
				mainSyllables = line.Syllabus
				bgSyllables = nil
			}

			if !first {
				sb.WriteString("\n")
			}
			first = false

			sb.WriteString(timestamp)
			appendLyricsPlusSyllables(&sb, mainSyllables)

			if multiPersonWordByWord && len(bgSyllables) > 0 {
				sb.WriteString("\n[bg:")
				appendLyricsPlusSyllables(&sb, bgSyllables)
				sb.WriteString("]")
			}
			continue
		}

		// Line-synced fallback. Reconstruct text from syllables if needed.
		if strings.TrimSpace(lineText) == "" && hasSyllables {
			var lineBuilder strings.Builder
			for _, syl := range line.Syllabus {
				lineBuilder.WriteString(syl.Text)
			}
			lineText = lineBuilder.String()
		}

		lineText = strings.TrimSpace(lineText)
		if lineText == "" {
			continue
		}

		if !first {
			sb.WriteString("\n")
		}
		first = false

		sb.WriteString(timestamp)
		sb.WriteString(lineText)
	}

	return strings.TrimSpace(sb.String())
}

// appendLyricsPlusSyllables writes each syllable as "<mm:ss.xx>text". KPOE
// already embeds spacing inside the syllable text, so no extra spaces are added.
func appendLyricsPlusSyllables(sb *strings.Builder, syllables []lyricsPlusSyllable) {
	for _, syl := range syllables {
		sb.WriteString("<")
		sb.WriteString(msToLRCTimestampInline(int64(syl.Time)))
		sb.WriteString(">")
		sb.WriteString(syl.Text)
	}
}
