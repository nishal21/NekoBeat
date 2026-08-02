package gobackend

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type CueSheet struct {
	Performer string     `json:"performer"`
	Title     string     `json:"title"`
	FileName  string     `json:"file_name"`
	FileType  string     `json:"file_type"` // WAVE, FLAC, MP3, AIFF, etc.
	Genre     string     `json:"genre,omitempty"`
	Date      string     `json:"date,omitempty"`
	Comment   string     `json:"comment,omitempty"`
	Composer  string     `json:"composer,omitempty"`
	Tracks    []CueTrack `json:"tracks"`
}

type CueTrack struct {
	Number    int     `json:"number"`
	Title     string  `json:"title"`
	Performer string  `json:"performer"`
	ISRC      string  `json:"isrc,omitempty"`
	Composer  string  `json:"composer,omitempty"`
	StartTime float64 `json:"start_time"` // INDEX 01 in seconds
	PreGap    float64 `json:"pre_gap"`    // INDEX 00 in seconds (or -1 if not present)
}

type CueSplitInfo struct {
	CuePath   string          `json:"cue_path"`
	AudioPath string          `json:"audio_path"`
	Album     string          `json:"album"`
	Artist    string          `json:"artist"`
	Genre     string          `json:"genre,omitempty"`
	Date      string          `json:"date,omitempty"`
	Tracks    []CueSplitTrack `json:"tracks"`
}

type CueSplitTrack struct {
	Number   int     `json:"number"`
	Title    string  `json:"title"`
	Artist   string  `json:"artist"`
	ISRC     string  `json:"isrc,omitempty"`
	Composer string  `json:"composer,omitempty"`
	StartSec float64 `json:"start_sec"`
	EndSec   float64 `json:"end_sec"` // -1 means until end of file
}

var (
	reRemCommand = regexp.MustCompile(`^REM\s+(\S+)\s+(.+)$`)
	reQuoted     = regexp.MustCompile(`"([^"]*)"`)
)

func ParseCueFile(cuePath string) (*CueSheet, error) {
	f, err := os.Open(cuePath)
	if err != nil {
		return nil, fmt.Errorf("failed to open cue file: %w", err)
	}
	defer f.Close()

	sheet := &CueSheet{}
	var currentTrack *CueTrack

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		if strings.HasPrefix(line, "\xef\xbb\xbf") {
			line = strings.TrimPrefix(line, "\xef\xbb\xbf")
			line = strings.TrimSpace(line)
		}

		upper := strings.ToUpper(line)

		if strings.HasPrefix(upper, "REM ") {
			matches := reRemCommand.FindStringSubmatch(line)
			if len(matches) == 3 {
				key := strings.ToUpper(matches[1])
				value := unquoteCue(matches[2])
				switch key {
				case "GENRE":
					sheet.Genre = value
				case "DATE":
					sheet.Date = value
				case "COMMENT":
					sheet.Comment = value
				case "COMPOSER":
					if currentTrack != nil {
						currentTrack.Composer = value
					} else {
						sheet.Composer = value
					}
				}
			}
			continue
		}

		if strings.HasPrefix(upper, "PERFORMER ") {
			value := unquoteCue(line[len("PERFORMER "):])
			if currentTrack != nil {
				currentTrack.Performer = value
			} else {
				sheet.Performer = value
			}
			continue
		}

		if strings.HasPrefix(upper, "TITLE ") {
			value := unquoteCue(line[len("TITLE "):])
			if currentTrack != nil {
				currentTrack.Title = value
			} else {
				sheet.Title = value
			}
			continue
		}

		if strings.HasPrefix(upper, "FILE ") {
			rest := line[len("FILE "):]
			fname, ftype := parseCueFileLine(rest)
			sheet.FileName = fname
			sheet.FileType = ftype
			continue
		}

		if strings.HasPrefix(upper, "TRACK ") {
			if currentTrack != nil {
				sheet.Tracks = append(sheet.Tracks, *currentTrack)
			}

			parts := strings.Fields(line)
			trackNum := 0
			if len(parts) >= 2 {
				trackNum, _ = strconv.Atoi(parts[1])
			}

			currentTrack = &CueTrack{
				Number: trackNum,
				PreGap: -1,
			}
			continue
		}

		if strings.HasPrefix(upper, "INDEX ") && currentTrack != nil {
			parts := strings.Fields(line)
			if len(parts) >= 3 {
				indexNum, _ := strconv.Atoi(parts[1])
				timeSec := parseCueTimestamp(parts[2])
				switch indexNum {
				case 0:
					currentTrack.PreGap = timeSec
				case 1:
					currentTrack.StartTime = timeSec
				}
			}
			continue
		}

		if strings.HasPrefix(upper, "ISRC ") && currentTrack != nil {
			currentTrack.ISRC = strings.TrimSpace(line[len("ISRC "):])
			continue
		}

		if strings.HasPrefix(upper, "SONGWRITER ") {
			value := unquoteCue(line[len("SONGWRITER "):])
			if currentTrack != nil {
				currentTrack.Composer = value
			} else {
				sheet.Composer = value
			}
			continue
		}
	}

	if currentTrack != nil {
		sheet.Tracks = append(sheet.Tracks, *currentTrack)
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("error reading cue file: %w", err)
	}

	if len(sheet.Tracks) == 0 {
		return nil, fmt.Errorf("no tracks found in cue file")
	}

	return sheet, nil
}

func parseCueTimestamp(ts string) float64 {
	parts := strings.Split(ts, ":")
	if len(parts) != 3 {
		return 0
	}

	minutes, _ := strconv.Atoi(parts[0])
	seconds, _ := strconv.Atoi(parts[1])
	frames, _ := strconv.Atoi(parts[2])

	return float64(minutes)*60 + float64(seconds) + float64(frames)/75.0
}

func formatCueTimestamp(seconds float64) string {
	if seconds < 0 {
		return "0"
	}
	hours := int(seconds) / 3600
	mins := (int(seconds) % 3600) / 60
	secs := seconds - float64(hours*3600) - float64(mins*60)
	return fmt.Sprintf("%02d:%02d:%06.3f", hours, mins, secs)
}

func unquoteCue(s string) string {
	s = strings.TrimSpace(s)
	if matches := reQuoted.FindStringSubmatch(s); len(matches) == 2 {
		return matches[1]
	}
	return s
}

func parseCueFileLine(rest string) (string, string) {
	rest = strings.TrimSpace(rest)

	var filename, ftype string

	if strings.HasPrefix(rest, "\"") {
		endQuote := strings.Index(rest[1:], "\"")
		if endQuote >= 0 {
			filename = rest[1 : endQuote+1]
			remaining := strings.TrimSpace(rest[endQuote+2:])
			ftype = remaining
		} else {
			filename = rest
		}
	} else {
		parts := strings.Fields(rest)
		if len(parts) >= 2 {
			ftype = parts[len(parts)-1]
			filename = strings.Join(parts[:len(parts)-1], " ")
		} else if len(parts) == 1 {
			filename = parts[0]
		}
	}

	return filename, strings.TrimSpace(ftype)
}

func ResolveCueAudioPath(cuePath string, cueFileName string) string {
	cueDir := filepath.Dir(cuePath)

	candidate := filepath.Join(cueDir, cueFileName)
	if _, err := os.Stat(candidate); err == nil {
		return candidate
	}

	baseName := strings.TrimSuffix(cueFileName, filepath.Ext(cueFileName))
	commonExts := []string{".flac", ".wav", ".aiff", ".aif", ".ape", ".mp3", ".ogg", ".wv", ".m4a"}
	for _, ext := range commonExts {
		candidate = filepath.Join(cueDir, baseName+ext)
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		candidate = filepath.Join(cueDir, baseName+strings.ToUpper(ext))
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}

	cueBase := strings.TrimSuffix(filepath.Base(cuePath), filepath.Ext(cuePath))
	for _, ext := range commonExts {
		candidate = filepath.Join(cueDir, cueBase+ext)
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}

	entries, err := os.ReadDir(cueDir)
	if err == nil {
		audioExts := map[string]bool{
			".flac": true, ".wav": true, ".ape": true, ".mp3": true,
			".ogg": true, ".wv": true, ".m4a": true, ".aiff": true,
		}
		var audioFiles []string
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			ext := strings.ToLower(filepath.Ext(entry.Name()))
			if audioExts[ext] {
				audioFiles = append(audioFiles, filepath.Join(cueDir, entry.Name()))
			}
		}
		if len(audioFiles) == 1 {
			return audioFiles[0]
		}
	}

	return ""
}

func BuildCueSplitInfo(cuePath string, sheet *CueSheet, audioDir string) (*CueSplitInfo, error) {
	resolveDir := cuePath
	if audioDir != "" {
		resolveDir = filepath.Join(audioDir, filepath.Base(cuePath))
	}
	audioPath := ResolveCueAudioPath(resolveDir, sheet.FileName)
	if audioPath == "" {
		return nil, fmt.Errorf("audio file not found for cue sheet: %s (referenced: %s)", cuePath, sheet.FileName)
	}

	info := &CueSplitInfo{
		CuePath:   cuePath,
		AudioPath: audioPath,
		Album:     sheet.Title,
		Artist:    sheet.Performer,
		Genre:     sheet.Genre,
		Date:      sheet.Date,
	}

	for i, track := range sheet.Tracks {
		performer := track.Performer
		if performer == "" {
			performer = sheet.Performer
		}

		composer := track.Composer
		if composer == "" {
			composer = sheet.Composer
		}

		endSec := float64(-1)
		if i+1 < len(sheet.Tracks) {
			nextTrack := sheet.Tracks[i+1]
			if nextTrack.PreGap >= 0 {
				endSec = nextTrack.PreGap
			} else {
				endSec = nextTrack.StartTime
			}
		}

		info.Tracks = append(info.Tracks, CueSplitTrack{
			Number:   track.Number,
			Title:    track.Title,
			Artist:   performer,
			ISRC:     track.ISRC,
			Composer: composer,
			StartSec: track.StartTime,
			EndSec:   endSec,
		})
	}

	return info, nil
}

func ParseCueFileJSON(cuePath string, audioDir string) (string, error) {
	sheet, err := ParseCueFile(cuePath)
	if err != nil {
		return "", fmt.Errorf("failed to parse cue file: %w", err)
	}

	info, err := BuildCueSplitInfo(cuePath, sheet, audioDir)
	if err != nil {
		return "", err
	}

	jsonBytes, err := json.Marshal(info)
	if err != nil {
		return "", fmt.Errorf("failed to marshal cue split info: %w", err)
	}

	return string(jsonBytes), nil
}

func ScanCueFileForLibrary(cuePath string, scanTime string) ([]LibraryScanResult, error) {
	sheet, err := ParseCueFile(cuePath)
	if err != nil {
		return nil, err
	}
	audioPath, err := resolveCueAudioPathForLibrary(cuePath, sheet, "")
	if err != nil {
		return nil, err
	}
	return scanCueSheetForLibrary(cuePath, sheet, audioPath, "", 0, "", scanTime)
}

func ScanCueFileForLibraryExt(cuePath, audioDir, virtualPathPrefix string, fileModTime int64, scanTime string) ([]LibraryScanResult, error) {
	return ScanCueFileForLibraryExtWithCoverCacheKey(
		cuePath,
		audioDir,
		virtualPathPrefix,
		fileModTime,
		"",
		scanTime,
	)
}

func ScanCueFileForLibraryExtWithCoverCacheKey(cuePath, audioDir, virtualPathPrefix string, fileModTime int64, coverCacheKey, scanTime string) ([]LibraryScanResult, error) {
	sheet, err := ParseCueFile(cuePath)
	if err != nil {
		return nil, err
	}
	audioPath, err := resolveCueAudioPathForLibrary(cuePath, sheet, audioDir)
	if err != nil {
		return nil, err
	}
	return scanCueSheetForLibrary(
		cuePath,
		sheet,
		audioPath,
		virtualPathPrefix,
		fileModTime,
		coverCacheKey,
		scanTime,
	)
}

func resolveCueAudioPathForLibrary(cuePath string, sheet *CueSheet, audioDir string) (string, error) {
	if sheet == nil {
		return "", fmt.Errorf("cue sheet is nil for %s", cuePath)
	}
	resolveBase := cuePath
	if audioDir != "" {
		resolveBase = filepath.Join(audioDir, filepath.Base(cuePath))
	}
	audioPath := ResolveCueAudioPath(resolveBase, sheet.FileName)
	if audioPath == "" {
		return "", fmt.Errorf("audio file not found for cue: %s (referenced: %s)", cuePath, sheet.FileName)
	}
	return audioPath, nil
}

func scanCueSheetForLibrary(cuePath string, sheet *CueSheet, audioPath, virtualPathPrefix string, fileModTime int64, coverCacheKey, scanTime string) ([]LibraryScanResult, error) {
	if sheet == nil {
		return nil, fmt.Errorf("cue sheet is nil for %s", cuePath)
	}

	var bitDepth, sampleRate int
	var totalDurationSec float64
	audioExt := strings.ToLower(filepath.Ext(audioPath))
	switch audioExt {
	case ".flac":
		quality, qErr := GetAudioQuality(audioPath)
		if qErr == nil {
			bitDepth = quality.BitDepth
			sampleRate = quality.SampleRate
			if quality.SampleRate > 0 && quality.TotalSamples > 0 {
				totalDurationSec = float64(quality.TotalSamples) / float64(quality.SampleRate)
			}
		}
	case ".mp3":
		quality, qErr := GetMP3Quality(audioPath)
		if qErr == nil {
			sampleRate = quality.SampleRate
			totalDurationSec = float64(quality.Duration)
		}
	}

	var coverPath string
	libraryCoverCacheMu.RLock()
	coverCacheDir := libraryCoverCacheDir
	libraryCoverCacheMu.RUnlock()
	if coverCacheDir != "" {
		cp, err := SaveCoverToCacheWithHintAndKey(
			audioPath,
			"",
			coverCacheDir,
			coverCacheKey,
		)
		if err == nil && cp != "" {
			coverPath = cp
		}
	}

	pathBase := cuePath
	if virtualPathPrefix != "" {
		pathBase = virtualPathPrefix
	}

	modTime := fileModTime
	if modTime <= 0 {
		if info, err := os.Stat(cuePath); err == nil {
			modTime = info.ModTime().UnixMilli()
		}
	}

	var results []LibraryScanResult
	for i, track := range sheet.Tracks {
		performer := track.Performer
		if performer == "" {
			performer = sheet.Performer
		}
		if performer == "" {
			performer = "Unknown Artist"
		}

		title := track.Title
		if title == "" {
			title = fmt.Sprintf("Track %02d", track.Number)
		}

		album := sheet.Title
		if album == "" {
			album = "Unknown Album"
		}

		composer := track.Composer
		if composer == "" {
			composer = sheet.Composer
		}

		var duration int
		if i+1 < len(sheet.Tracks) {
			nextStart := sheet.Tracks[i+1].StartTime
			if sheet.Tracks[i+1].PreGap >= 0 {
				nextStart = sheet.Tracks[i+1].PreGap
			}
			duration = int(nextStart - track.StartTime)
		} else if totalDurationSec > 0 {
			duration = int(totalDurationSec - track.StartTime)
		}

		id := generateLibraryID(fmt.Sprintf("%s#track%d", pathBase, track.Number))

		virtualFilePath := fmt.Sprintf("%s#track%02d", pathBase, track.Number)

		result := LibraryScanResult{
			ID:          id,
			TrackName:   title,
			ArtistName:  performer,
			AlbumName:   album,
			AlbumArtist: sheet.Performer,
			FilePath:    virtualFilePath,
			CoverPath:   coverPath,
			ScannedAt:   scanTime,
			ISRC:        track.ISRC,
			TrackNumber: track.Number,
			TotalTracks: len(sheet.Tracks),
			DiscNumber:  1,
			TotalDiscs:  1,
			Duration:    duration,
			ReleaseDate: sheet.Date,
			BitDepth:    bitDepth,
			SampleRate:  sampleRate,
			Genre:       sheet.Genre,
			Composer:    composer,
			Format:      "cue+" + strings.TrimPrefix(audioExt, "."),
		}

		result.FileModTime = modTime

		results = append(results, result)
	}

	return results, nil
}
