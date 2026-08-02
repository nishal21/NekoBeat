package gobackend

import (
	"strings"
	"sync"
	"time"
)

const (
	downloadPreparationCacheTTL = 5 * time.Minute
	downloadPreparationCacheMax = 128
)

type preparedDownloadRequestEntry struct {
	key              string
	request          DownloadRequest
	metadataPrepared bool
	createdAt        time.Time
}

var (
	preparedDownloadRequests   = make(map[string]preparedDownloadRequestEntry)
	preparedDownloadRequestsMu sync.Mutex
)

func downloadPreparationKey(req DownloadRequest) string {
	return strings.Join([]string{
		strings.TrimSpace(req.ItemID),
		strings.ToLower(strings.TrimSpace(req.Service)),
		strings.ToLower(strings.TrimSpace(req.Source)),
		strings.TrimSpace(req.SpotifyID),
		strings.TrimSpace(req.TidalID),
		strings.TrimSpace(req.QobuzID),
		strings.TrimSpace(req.DeezerID),
		strings.ToLower(strings.TrimSpace(req.TrackName)),
		strings.ToLower(strings.TrimSpace(req.ArtistName)),
	}, "\n")
}

func prunePreparedDownloadRequestsLocked(now time.Time) {
	for itemID, entry := range preparedDownloadRequests {
		if now.Sub(entry.createdAt) >= downloadPreparationCacheTTL {
			delete(preparedDownloadRequests, itemID)
		}
	}
	for len(preparedDownloadRequests) >= downloadPreparationCacheMax {
		var oldestID string
		var oldestAt time.Time
		for itemID, entry := range preparedDownloadRequests {
			if oldestID == "" || entry.createdAt.Before(oldestAt) {
				oldestID = itemID
				oldestAt = entry.createdAt
			}
		}
		if oldestID == "" {
			break
		}
		delete(preparedDownloadRequests, oldestID)
	}
}

func cacheDownloadRequestForVerification(key string, req DownloadRequest, metadataPrepared bool) {
	itemID := strings.TrimSpace(req.ItemID)
	if itemID == "" || strings.TrimSpace(key) == "" {
		return
	}

	preparedDownloadRequestsMu.Lock()
	defer preparedDownloadRequestsMu.Unlock()
	now := time.Now()
	prunePreparedDownloadRequestsLocked(now)
	preparedDownloadRequests[itemID] = preparedDownloadRequestEntry{
		key:              key,
		request:          req,
		metadataPrepared: metadataPrepared,
		createdAt:        now,
	}
}

func cachePreparedDownloadRequest(key string, req DownloadRequest) {
	cacheDownloadRequestForVerification(key, req, true)
}

func cacheUnpreparedDownloadRequest(key string, req DownloadRequest) {
	cacheDownloadRequestForVerification(key, req, false)
}

func takePreparedDownloadRequest(key string, fresh DownloadRequest) (DownloadRequest, bool, bool) {
	itemID := strings.TrimSpace(fresh.ItemID)
	if itemID == "" || strings.TrimSpace(key) == "" {
		return fresh, false, false
	}

	preparedDownloadRequestsMu.Lock()
	defer preparedDownloadRequestsMu.Unlock()
	now := time.Now()
	prunePreparedDownloadRequestsLocked(now)
	entry, ok := preparedDownloadRequests[itemID]
	if !ok {
		return fresh, false, false
	}
	delete(preparedDownloadRequests, itemID)
	if entry.key != key {
		return fresh, false, false
	}

	prepared := entry.request
	fresh.ISRC = prepared.ISRC
	fresh.SpotifyID = prepared.SpotifyID
	fresh.TrackName = prepared.TrackName
	fresh.ArtistName = prepared.ArtistName
	fresh.AlbumName = prepared.AlbumName
	fresh.AlbumArtist = prepared.AlbumArtist
	fresh.CoverURL = prepared.CoverURL
	fresh.TrackNumber = prepared.TrackNumber
	fresh.DiscNumber = prepared.DiscNumber
	fresh.TotalTracks = prepared.TotalTracks
	fresh.TotalDiscs = prepared.TotalDiscs
	fresh.ReleaseDate = prepared.ReleaseDate
	fresh.DurationMS = prepared.DurationMS
	fresh.Genre = prepared.Genre
	fresh.Label = prepared.Label
	fresh.Copyright = prepared.Copyright
	fresh.Composer = prepared.Composer
	fresh.TidalID = prepared.TidalID
	fresh.QobuzID = prepared.QobuzID
	fresh.DeezerID = prepared.DeezerID
	return fresh, entry.metadataPrepared, true
}
