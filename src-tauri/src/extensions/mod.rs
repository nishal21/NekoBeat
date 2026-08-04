//! Extension store + per-extension login (SpotiFLAC Mobile auth pattern).
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSettingField {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub value: Option<serde_json::Value>,
    pub options: Option<Vec<SelectOpt>>,
    pub oauth_login_url: Option<String>,
    pub secret: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectOpt {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionEntry {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    pub category: String,
    pub download_url: String,
    pub sha256: Option<String>,
    pub installed: Option<bool>,
    pub enabled: Option<bool>,
    pub logged_in: Option<bool>,
    pub needs_auth: Option<bool>,
    pub settings: Option<Vec<ExtensionSettingField>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionAuthPending {
    pub extension_id: String,
    pub auth_url: String,
    pub hint: Option<String>,
}

#[derive(Default)]
pub struct ExtState {
    pub registry_url: Mutex<String>,
    pub catalog: Mutex<Vec<ExtensionEntry>>,
    pub download_priority: Mutex<Vec<String>>,
    pub metadata_priority: Mutex<Vec<String>>,
    pub install_dir: Mutex<Option<PathBuf>>,
    /// extension_id -> settings JSON (credentials, tokens)
    pub ext_settings: Mutex<HashMap<String, serde_json::Value>>,
    /// extension_id -> session/token blob
    pub sessions: Mutex<HashMap<String, serde_json::Value>>,
    pub pending_auth: Mutex<Option<ExtensionAuthPending>>,
}

fn resolve_registry_url(url: &str) -> String {
    let u = url.trim().trim_end_matches('/');
    if u.ends_with("registry.json") {
        return u.to_string();
    }
    if let Some(rest) = u.strip_prefix("https://github.com/") {
        let mut parts = rest.split('/');
        let owner = parts.next().unwrap_or("");
        let repo = parts.next().unwrap_or("");
        if !owner.is_empty() && !repo.is_empty() {
            return format!(
                "https://raw.githubusercontent.com/{owner}/{repo}/main/registry.json"
            );
        }
    }
    u.to_string()
}

fn default_auth_fields(id: &str, category: &str) -> (bool, Vec<ExtensionSettingField>) {
    let is_download = category == "download" || matches!(
        id,
        "tidal-web" | "amazon" | "qobuz-web" | "deezer" | "apple-music"
    );
    let is_spotify = id.contains("spotify");
    if !is_download && !is_spotify {
        return (false, vec![]);
    }
    let mut fields = vec![
        ExtensionSettingField {
            key: "email".into(),
            label: "Email / username".into(),
            field_type: "string".into(),
            value: None,
            options: None,
            oauth_login_url: None,
            secret: Some(false),
        },
        ExtensionSettingField {
            key: "password".into(),
            label: "Password".into(),
            field_type: "secret".into(),
            value: None,
            options: None,
            oauth_login_url: None,
            secret: Some(true),
        },
    ];
    if is_spotify || id == "tidal-web" || id == "qobuz-web" {
        fields.push(ExtensionSettingField {
            key: "oauth_connect".into(),
            label: if is_spotify {
                "Connect to Spotify".into()
            } else {
                format!("Connect / verify ({id})")
            },
            field_type: "button".into(),
            value: None,
            options: None,
            oauth_login_url: Some(format!("https://auth.example.local/{id}/login")),
            secret: Some(false),
        });
    }
    (true, fields)
}

fn persist_auth(state: &ExtState, app_dir: &PathBuf) {
    let path = app_dir.join("extension_auth.json");
    let payload = json!({
        "settings": &*state.ext_settings.lock(),
        "sessions": &*state.sessions.lock(),
    });
    let _ = std::fs::write(path, serde_json::to_string_pretty(&payload).unwrap_or_default());
}

pub fn load_auth(state: &ExtState, app_dir: &PathBuf) {
    let path = app_dir.join("extension_auth.json");
    if let Ok(text) = std::fs::read_to_string(path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(s) = v.get("settings").and_then(|x| x.as_object()) {
                let mut map = state.ext_settings.lock();
                for (k, val) in s {
                    map.insert(k.clone(), val.clone());
                }
            }
            if let Some(s) = v.get("sessions").and_then(|x| x.as_object()) {
                let mut map = state.sessions.lock();
                for (k, val) in s {
                    map.insert(k.clone(), val.clone());
                }
            }
        }
    }
}

fn enrich_entry(state: &ExtState, mut e: ExtensionEntry) -> ExtensionEntry {
    let (needs, fields) = default_auth_fields(&e.id, &e.category);
    e.needs_auth = Some(needs);
    let mut fields = fields;
    if let Some(saved) = state.ext_settings.lock().get(&e.id) {
        for f in &mut fields {
            if let Some(v) = saved.get(&f.key) {
                f.value = Some(v.clone());
            }
        }
    }
    e.settings = Some(fields);
    e.logged_in = Some(state.sessions.lock().contains_key(&e.id));
    e
}

#[tauri::command]
pub fn extensions_list(state: tauri::State<'_, Arc<ExtState>>) -> Vec<ExtensionEntry> {
    state
        .catalog
        .lock()
        .iter()
        .cloned()
        .map(|e| enrich_entry(&state, e))
        .collect()
}

#[tauri::command]
pub fn extensions_set_registry(
    state: tauri::State<'_, Arc<ExtState>>,
    url: String,
) -> Result<(), String> {
    *state.registry_url.lock() = url;
    Ok(())
}

#[tauri::command]
pub fn extensions_refresh(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<ExtState>>,
) -> Result<Vec<ExtensionEntry>, String> {
    use tauri::Manager;
    let url = resolve_registry_url(&state.registry_url.lock());
    let body = reqwest::blocking::get(&url)
        .map_err(|e| e.to_string())?
        .text()
        .map_err(|e| e.to_string())?;

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("registry json: {e}"))?;

    let items = if let Some(arr) = parsed.get("extensions").and_then(|v| v.as_array()) {
        arr.clone()
    } else if let Some(arr) = parsed.as_array() {
        arr.clone()
    } else {
        Vec::new()
    };

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("extensions");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    *state.install_dir.lock() = Some(dir.clone());
    load_auth(&state, &app.path().app_data_dir().map_err(|e| e.to_string())?);

    let mut catalog = Vec::new();
    for item in items {
        let id = item
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let category = item
            .get("category")
            .and_then(|v| v.as_str())
            .unwrap_or("utility")
            .to_string();
        let installed = dir.join(format!("{id}.sflx")).exists()
            || dir.join(format!("{id}.spotiflac-ext")).exists();
        let entry = ExtensionEntry {
            id: id.clone(),
            name: item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&id)
                .to_string(),
            display_name: item
                .get("display_name")
                .and_then(|v| v.as_str())
                .unwrap_or_else(|| item.get("name").and_then(|v| v.as_str()).unwrap_or(&id))
                .to_string(),
            version: item
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or("0")
                .to_string(),
            description: item
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            category,
            download_url: item
                .get("download_url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            sha256: item
                .get("sha256")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            installed: Some(installed),
            enabled: Some(installed),
            logged_in: None,
            needs_auth: None,
            settings: None,
        };
        catalog.push(enrich_entry(&state, entry));
    }

    *state.catalog.lock() = catalog.clone();
    Ok(catalog)
}

#[tauri::command]
pub fn extensions_install(
    state: tauri::State<'_, Arc<ExtState>>,
    id: String,
) -> Result<(), String> {
    let catalog = state.catalog.lock().clone();
    let entry = catalog
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| "extension not in catalog".to_string())?;
    if entry.download_url.is_empty() {
        return Err("no download_url".into());
    }
    let dir = state
        .install_dir
        .lock()
        .clone()
        .ok_or_else(|| "refresh catalog first".to_string())?;
    let bytes = reqwest::blocking::get(&entry.download_url)
        .map_err(|e| e.to_string())?
        .bytes()
        .map_err(|e| e.to_string())?;
    if let Some(expected) = &entry.sha256 {
        use sha2::{Digest, Sha256};
        let hash = hex::encode(Sha256::digest(&bytes));
        if !hash.eq_ignore_ascii_case(expected) {
            return Err(format!("sha256 mismatch: got {hash}"));
        }
    }
    let path = dir.join(format!("{id}.sflx"));
    std::fs::write(path, bytes).map_err(|e| e.to_string())?;
    if let Some(e) = state.catalog.lock().iter_mut().find(|e| e.id == id) {
        e.installed = Some(true);
        e.enabled = Some(true);
    }
    Ok(())
}

#[tauri::command]
pub fn extensions_set_priority(
    state: tauri::State<'_, Arc<ExtState>>,
    kind: String,
    ids: Vec<String>,
) -> Result<(), String> {
    match kind.as_str() {
        "download" => *state.download_priority.lock() = ids,
        "metadata" => *state.metadata_priority.lock() = ids,
        _ => return Err("kind must be download|metadata".into()),
    }
    Ok(())
}

#[tauri::command]
pub fn extensions_get_settings(
    state: tauri::State<'_, Arc<ExtState>>,
    id: String,
) -> Result<Vec<ExtensionSettingField>, String> {
    let catalog = state.catalog.lock().clone();
    let entry = catalog
        .into_iter()
        .find(|e| e.id == id)
        .map(|e| enrich_entry(&state, e))
        .ok_or_else(|| "unknown extension".to_string())?;
    Ok(entry.settings.unwrap_or_default())
}

#[tauri::command]
pub fn extensions_set_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<ExtState>>,
    id: String,
    settings: serde_json::Value,
) -> Result<(), String> {
    use tauri::Manager;
    state.ext_settings.lock().insert(id, settings);
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    persist_auth(&state, &dir);
    Ok(())
}

/// Start OAuth / browser verify (SpotiFLAC Mobile Connect flow).
#[tauri::command]
pub fn extensions_start_login(
    state: tauri::State<'_, Arc<ExtState>>,
    id: String,
) -> Result<ExtensionAuthPending, String> {
    let fields = extensions_get_settings(state.clone(), id.clone())?;
    let oauth = fields
        .iter()
        .find_map(|f| f.oauth_login_url.clone())
        .unwrap_or_else(|| format!("https://auth.example.local/{id}/login"));
    let pending = ExtensionAuthPending {
        extension_id: id,
        auth_url: oauth,
        hint: Some("Open the URL, sign in, then paste the callback / grant code.".into()),
    };
    *state.pending_auth.lock() = Some(pending.clone());
    Ok(pending)
}

/// Complete login with password fields already saved, or pasted OAuth code/grant.
#[tauri::command]
pub fn extensions_complete_login(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<ExtState>>,
    id: String,
    auth_code: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;
    let saved = state.ext_settings.lock().get(&id).cloned().unwrap_or(json!({}));
    let email = saved.get("email").and_then(|v| v.as_str()).unwrap_or("");
    let password = saved.get("password").and_then(|v| v.as_str()).unwrap_or("");
    if auth_code.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
        || (!email.is_empty() && !password.is_empty())
    {
        state.sessions.lock().insert(
            id.clone(),
            json!({
                "logged_in": true,
                "at": chrono::Utc::now().timestamp(),
                "via": if auth_code.as_ref().map(|s| !s.is_empty()).unwrap_or(false) {
                    "oauth"
                } else {
                    "password"
                },
            }),
        );
        *state.pending_auth.lock() = None;
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        persist_auth(&state, &dir);
        Ok(())
    } else {
        Err("Enter email+password or paste OAuth callback / grant code".into())
    }
}

#[tauri::command]
pub fn extensions_logout(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<ExtState>>,
    id: String,
) -> Result<(), String> {
    use tauri::Manager;
    state.sessions.lock().remove(&id);
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    persist_auth(&state, &dir);
    Ok(())
}

#[tauri::command]
pub fn extensions_pending_auth(
    state: tauri::State<'_, Arc<ExtState>>,
) -> Option<ExtensionAuthPending> {
    state.pending_auth.lock().clone()
}

/// Whether preferred download service has a session (for HiFi gate).
pub fn is_logged_in(state: &ExtState, id: &str) -> bool {
    state.sessions.lock().contains_key(id)
}
