use crate::library::{init_db, TrackData};
use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use serde::Serialize;

const HISTORY_NAME: &str = "History";
const HISTORY_LIMIT: i64 = 100;

#[derive(Debug, Serialize)]
pub struct PlaylistSummary {
    pub id: i64,
    pub name: String,
    pub is_history: bool,
    pub track_count: i64,
}

fn init_schema(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS playlists (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            is_history INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS playlist_tracks (
            playlist_id INTEGER NOT NULL,
            filepath TEXT NOT NULL,
            position INTEGER NOT NULL,
            added_at INTEGER NOT NULL DEFAULT (unixepoch()),
            PRIMARY KEY (playlist_id, filepath),
            FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_playlist_tracks_order
            ON playlist_tracks(playlist_id, position);",
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO playlists (name, is_history) VALUES (?1, 1)",
        [HISTORY_NAME],
    )?;
    Ok(())
}

fn connection(app: &tauri::AppHandle) -> Result<Connection, String> {
    let conn = init_db(app).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| e.to_string())?;
    init_schema(&conn).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn summary_rows(conn: &Connection) -> SqlResult<Vec<PlaylistSummary>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, p.is_history, COUNT(pt.filepath)
         FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
         GROUP BY p.id
         ORDER BY p.is_history DESC, p.name COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(PlaylistSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                is_history: row.get::<_, i64>(2)? != 0,
                track_count: row.get(3)?,
            })
        })?
        .collect();
    rows
}

#[tauri::command]
pub fn list_playlists(app: tauri::AppHandle) -> Result<Vec<PlaylistSummary>, String> {
    let conn = connection(&app)?;
    summary_rows(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_playlist(app: tauri::AppHandle, name: String) -> Result<i64, String> {
    let clean = name.trim();
    if clean.is_empty() || clean.eq_ignore_ascii_case(HISTORY_NAME) {
        return Err("Choose another playlist name".into());
    }
    let conn = connection(&app)?;
    conn.execute("INSERT INTO playlists (name) VALUES (?1)", [clean])
        .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn rename_playlist(
    app: tauri::AppHandle,
    playlist_id: i64,
    name: String,
) -> Result<(), String> {
    let clean = name.trim();
    if clean.is_empty() || clean.eq_ignore_ascii_case(HISTORY_NAME) {
        return Err("Choose another playlist name".into());
    }
    let conn = connection(&app)?;
    let changed = conn
        .execute(
            "UPDATE playlists SET name=?1, updated_at=unixepoch()
             WHERE id=?2 AND is_history=0",
            params![clean, playlist_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Playlist not found or cannot be renamed".into());
    }
    Ok(())
}

#[tauri::command]
pub fn delete_playlist(app: tauri::AppHandle, playlist_id: i64) -> Result<(), String> {
    let conn = connection(&app)?;
    let changed = conn
        .execute(
            "DELETE FROM playlists WHERE id=?1 AND is_history=0",
            [playlist_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Playlist not found or cannot be deleted".into());
    }
    Ok(())
}

#[tauri::command]
pub fn add_playlist_track(
    app: tauri::AppHandle,
    playlist_id: i64,
    filepath: String,
) -> Result<(), String> {
    let conn = connection(&app)?;
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM tracks WHERE filepath=?1)",
            [&filepath],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("Track is not in the local library".into());
    }
    let next: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_tracks WHERE playlist_id=?1",
            [playlist_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO playlist_tracks (playlist_id, filepath, position)
         SELECT id, ?2, ?3 FROM playlists WHERE id=?1 AND is_history=0",
        params![playlist_id, filepath, next],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_playlist_track(
    app: tauri::AppHandle,
    playlist_id: i64,
    filepath: String,
) -> Result<(), String> {
    let conn = connection(&app)?;
    conn.execute(
        "DELETE FROM playlist_tracks WHERE playlist_id=?1 AND filepath=?2",
        params![playlist_id, filepath],
    )
    .map_err(|e| e.to_string())?;
    normalize_positions(&conn, playlist_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reorder_playlist_track(
    app: tauri::AppHandle,
    playlist_id: i64,
    from_index: i64,
    to_index: i64,
) -> Result<(), String> {
    let mut conn = connection(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let filepath: Option<String> = tx
        .query_row(
            "SELECT filepath FROM playlist_tracks WHERE playlist_id=?1 AND position=?2",
            params![playlist_id, from_index],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let filepath = filepath.ok_or_else(|| "Playlist track not found".to_string())?;
    tx.execute(
        "UPDATE playlist_tracks SET position = CASE
            WHEN ?2 < ?3 AND position > ?2 AND position <= ?3 THEN position - 1
            WHEN ?2 > ?3 AND position >= ?3 AND position < ?2 THEN position + 1
            ELSE position END
         WHERE playlist_id=?1",
        params![playlist_id, from_index, to_index],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE playlist_tracks SET position=?3 WHERE playlist_id=?1 AND filepath=?2",
        params![playlist_id, filepath, to_index],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn normalize_positions(conn: &Connection, playlist_id: i64) -> SqlResult<()> {
    conn.execute(
        "WITH ordered AS (
            SELECT filepath, ROW_NUMBER() OVER (ORDER BY position, added_at) - 1 AS new_position
            FROM playlist_tracks WHERE playlist_id=?1
         )
         UPDATE playlist_tracks SET position=(
            SELECT new_position FROM ordered WHERE ordered.filepath=playlist_tracks.filepath
         ) WHERE playlist_id=?1",
        [playlist_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn get_playlist_tracks(
    app: tauri::AppHandle,
    playlist_id: i64,
) -> Result<Vec<TrackData>, String> {
    let conn = connection(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT t.filepath, t.title, t.artist, t.album, t.album_artist, t.duration_ms,
                    t.local_lyrics, t.artwork_url, t.format, t.bitrate_kbps,
                    t.sample_rate_hz, t.channels, t.genre, t.track_number,
                    t.disc_number, t.year, t.date_added, t.replaygain_track_gain,
                    t.replaygain_track_peak, t.replaygain_album_gain, t.replaygain_album_peak
             FROM playlist_tracks pt JOIN tracks t ON t.filepath=pt.filepath
             WHERE pt.playlist_id=?1 ORDER BY pt.position",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([playlist_id], map_track)
        .map_err(|e| e.to_string())?;
    rows.collect::<SqlResult<Vec<_>>>()
        .map_err(|e| e.to_string())
}

fn map_track(row: &rusqlite::Row<'_>) -> SqlResult<TrackData> {
    Ok(TrackData {
        filepath: row.get(0)?,
        title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        artist: row
            .get::<_, Option<String>>(2)?
            .unwrap_or_else(|| "Unknown Artist".into()),
        album: row
            .get::<_, Option<String>>(3)?
            .unwrap_or_else(|| "Unknown Album".into()),
        album_artist: row.get(4)?,
        duration_ms: u64::try_from(row.get::<_, i64>(5)?).unwrap_or(0),
        source: Some("local".into()),
        local_lyrics: row.get(6)?,
        artwork_url: row.get(7)?,
        format: row.get(8)?,
        bitrate_kbps: row
            .get::<_, Option<i64>>(9)?
            .and_then(|v| u32::try_from(v).ok()),
        sample_rate_hz: row
            .get::<_, Option<i64>>(10)?
            .and_then(|v| u32::try_from(v).ok()),
        channels: row
            .get::<_, Option<i64>>(11)?
            .and_then(|v| u8::try_from(v).ok()),
        genre: row.get(12)?,
        track_number: row
            .get::<_, Option<i64>>(13)?
            .and_then(|v| u32::try_from(v).ok()),
        disc_number: row
            .get::<_, Option<i64>>(14)?
            .and_then(|v| u32::try_from(v).ok()),
        year: row
            .get::<_, Option<i64>>(15)?
            .and_then(|v| u32::try_from(v).ok()),
        date_added: row.get(16)?,
        replaygain_track_gain: row.get(17)?,
        replaygain_track_peak: row.get(18)?,
        replaygain_album_gain: row.get(19)?,
        replaygain_album_peak: row.get(20)?,
    })
}

#[tauri::command]
pub fn append_history(app: tauri::AppHandle, filepath: String) -> Result<(), String> {
    let mut conn = connection(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let history_id: i64 = tx
        .query_row(
            "SELECT id FROM playlists WHERE is_history=1 LIMIT 1",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM tracks WHERE filepath=?1)",
            [&filepath],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Ok(());
    }
    tx.execute(
        "DELETE FROM playlist_tracks WHERE playlist_id=?1 AND filepath=?2",
        params![history_id, filepath],
    )
    .map_err(|e| e.to_string())?;
    normalize_positions(&tx, history_id).map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE playlist_tracks SET position=position+1 WHERE playlist_id=?1",
        [history_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO playlist_tracks (playlist_id, filepath, position) VALUES (?1, ?2, 0)",
        params![history_id, filepath],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM playlist_tracks WHERE playlist_id=?1 AND position>=?2",
        params![history_id, HISTORY_LIMIT],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_is_idempotent_and_history_is_unique() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        init_schema(&conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM playlists WHERE is_history=1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn normalize_closes_playlist_position_gaps() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let id: i64 = conn
            .query_row("SELECT id FROM playlists LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO playlist_tracks (playlist_id, filepath, position) VALUES (?1,'a',2), (?1,'b',7)",
            [id],
        ).unwrap();
        normalize_positions(&conn, id).unwrap();
        let positions: Vec<i64> = conn
            .prepare("SELECT position FROM playlist_tracks ORDER BY position")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<SqlResult<_>>()
            .unwrap();
        assert_eq!(positions, vec![0, 1]);
    }
}
