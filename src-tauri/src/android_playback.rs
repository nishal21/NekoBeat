//! JNI bridge to Android's Media3 ExoPlayer foreground service.

#![cfg(target_os = "android")]

use jni::objects::{JObject, JString, JValue};
use jni::sys::jboolean;
use jni::JavaVM;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidPermissionEntry {
    permission: String,
    label: String,
    applicable: bool,
    granted: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidPermissionStatus {
    api_level: u32,
    audio: AndroidPermissionEntry,
    notifications: AndroidPermissionEntry,
}

fn with_activity_env<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce(&mut jni::JNIEnv, JObject) -> Result<R, String>,
{
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| format!("JavaVM: {e}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach: {e}"))?;
    let context = unsafe { JObject::from_raw(ctx.context() as jni::sys::jobject) };
    f(&mut env, context)
}

/// Native threads cannot use JNI FindClass for app classes. Load through the app ClassLoader.
fn load_app_class<'local>(
    env: &mut jni::JNIEnv<'local>,
    context: &JObject<'_>,
    binary_name: &str,
) -> Result<jni::objects::JClass<'local>, String> {
    let loader = env
        .call_method(context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .map_err(|e| format!("getClassLoader: {e}"))?
        .l()
        .map_err(|e| e.to_string())?;
    let name = env
        .new_string(binary_name)
        .map_err(|e| format!("class name: {e}"))?;
    let class = env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&name)],
        )
        .map_err(|e| format!("loadClass({binary_name}): {e}"))?
        .l()
        .map_err(|e| e.to_string())?;
    Ok(jni::objects::JClass::from(class))
}

fn call_app_static<'local>(
    env: &mut jni::JNIEnv<'local>,
    context: &JObject<'_>,
    binary_name: &str,
    method: &str,
    sig: &str,
    args: &[JValue<'_, '_>],
) -> Result<jni::objects::JValueOwned<'local>, String> {
    let class = load_app_class(env, context, binary_name)?;
    env.call_static_method(class, method, sig, args)
        .map_err(|e| format!("{binary_name}.{method}: {e}"))
}

fn call_playback_static<'local>(
    env: &mut jni::JNIEnv<'local>,
    context: &JObject<'_>,
    method: &str,
    sig: &str,
    args: &[JValue<'_, '_>],
) -> Result<jni::objects::JValueOwned<'local>, String> {
    call_app_static(
        env,
        context,
        "com.nishal21.nekobeat.PlaybackService",
        method,
        sig,
        args,
    )
}

fn call_main_activity_static<'local>(
    env: &mut jni::JNIEnv<'local>,
    context: &JObject<'_>,
    method: &str,
    sig: &str,
    args: &[JValue<'_, '_>],
) -> Result<jni::objects::JValueOwned<'local>, String> {
    call_app_static(
        env,
        context,
        "com.nishal21.nekobeat.MainActivity",
        method,
        sig,
        args,
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidCapabilityCheck {
    available: bool,
    required: bool,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidStreamingCapabilities {
    ready: bool,
    platform: AndroidCapabilityCheck,
    gstreamer: AndroidCapabilityCheck,
    playbin: AndroidCapabilityCheck,
    network_source: AndroidCapabilityCheck,
    resolver_bridge: AndroidCapabilityCheck,
    foreground_media_session: AndroidCapabilityCheck,
}

fn check(available: bool, required: bool, detail: impl Into<String>) -> AndroidCapabilityCheck {
    AndroidCapabilityCheck {
        available,
        required,
        detail: detail.into(),
    }
}

fn foreground_media_session_available() -> Result<bool, String> {
    with_activity_env(|env, context| {
        call_main_activity_static(
            env,
            &context,
            "mediaSessionSupport",
            "(Landroid/content/Context;)Z",
            &[JValue::Object(&context)],
        )?
        .z()
        .map_err(|e| e.to_string())
    })
}

/// Local, non-network capability probe used to decide whether Android Browse may be enabled.
#[tauri::command]
pub async fn android_streaming_capabilities() -> AndroidStreamingCapabilities {
    let resolver = crate::android_bin::find_ytdlp();
    let resolver_probe = match &resolver {
        Ok(path) => {
            let mut command = tokio::process::Command::new(path);
            command.arg("--version");
            crate::process_util::run_silent_timeout(command, Duration::from_secs(3)).await
        }
        Err(error) => Err(error.clone()),
    };
    let resolver_available = resolver_probe
        .as_ref()
        .map(|output| output.status.success())
        .unwrap_or(false);
    let media_session = foreground_media_session_available();
    let media_session_available = media_session.as_ref().copied().unwrap_or(false);

    let gstreamer = check(
        false,
        false,
        "Not used: Android local playback is owned by Media3 ExoPlayer",
    );
    let playbin = check(false, false, "Not used on Android");
    let network_source = check(
        false,
        false,
        "Online playback is intentionally unsupported by the Android Media3 transport",
    );
    let resolver_bridge = check(
        resolver_available,
        true,
        match (resolver, resolver_probe) {
            (Ok(path), Ok(output)) if output.status.success() => {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                format!(
                    "yt-dlp bridge executed at {}{}",
                    path.display(),
                    if version.is_empty() {
                        String::new()
                    } else {
                        format!(" ({version})")
                    }
                )
            }
            (Ok(path), Ok(output)) => format!(
                "yt-dlp bridge at {} exited with {}",
                path.display(),
                output.status
            ),
            (Ok(path), Err(error)) => {
                format!(
                    "yt-dlp bridge at {} could not execute: {error}",
                    path.display()
                )
            }
            (Err(error), _) => error,
        },
    );
    let foreground_media_session = check(
        media_session_available,
        true,
        match media_session {
            Ok(true) => "PlaybackService and MediaSession support are installed".to_string(),
            Ok(false) => "PlaybackService or MediaSession support is unavailable".to_string(),
            Err(error) => error,
        },
    );
    let platform = check(true, true, "Running on Android with Media3 local playback");
    let ready = [
        &platform,
        &gstreamer,
        &playbin,
        &network_source,
        &resolver_bridge,
        &foreground_media_session,
    ]
    .into_iter()
    .all(|item| !item.required || item.available);

    AndroidStreamingCapabilities {
        ready,
        platform,
        gstreamer,
        playbin,
        network_source,
        resolver_bridge,
        foreground_media_session,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidStreamingDiagnosticCheck {
    available: bool,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidStreamingDiagnostics {
    youtube: AndroidStreamingDiagnosticCheck,
    soundcloud: AndroidStreamingDiagnosticCheck,
    spotify_match: AndroidStreamingDiagnosticCheck,
    note: String,
}

async fn endpoint_reachable(
    client: &reqwest::Client,
    label: &str,
    url: &str,
) -> AndroidStreamingDiagnosticCheck {
    match client.get(url).send().await {
        Ok(response) => AndroidStreamingDiagnosticCheck {
            available: true,
            detail: format!("{label} responded with HTTP {}", response.status()),
        },
        Err(error) => AndroidStreamingDiagnosticCheck {
            available: false,
            detail: format!("{label} could not be reached: {error}"),
        },
    }
}

/// User-initiated connectivity smoke test. It never starts playback or resolves a track.
#[tauri::command]
pub async fn android_streaming_smoke_test() -> Result<AndroidStreamingDiagnostics, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(6))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|error| format!("Diagnostics client: {error}"))?;

    let (youtube_reachability, soundcloud_reachability, spotify_reachability) = tokio::join!(
        endpoint_reachable(&client, "YouTube", "https://www.youtube.com/generate_204"),
        endpoint_reachable(&client, "SoundCloud", "https://soundcloud.com/"),
        endpoint_reachable(&client, "Spotify", "https://open.spotify.com/"),
    );
    let capabilities = android_streaming_capabilities().await;
    let youtube_available =
        youtube_reachability.available && capabilities.resolver_bridge.available;
    let youtube = AndroidStreamingDiagnosticCheck {
        available: youtube_available,
        detail: if youtube_available {
            format!(
                "{}; {}",
                youtube_reachability.detail, capabilities.resolver_bridge.detail
            )
        } else {
            format!(
                "{}; resolver: {}",
                youtube_reachability.detail, capabilities.resolver_bridge.detail
            )
        },
    };
    let soundcloud = AndroidStreamingDiagnosticCheck {
        available: soundcloud_reachability.available,
        detail: soundcloud_reachability.detail,
    };
    let spotify_match = AndroidStreamingDiagnosticCheck {
        available: spotify_reachability.available && youtube.available,
        detail: format!(
            "{}; Spotify matching also requires the YouTube resolver ({})",
            spotify_reachability.detail,
            if youtube.available {
                "available"
            } else {
                "unavailable"
            }
        ),
    };

    Ok(AndroidStreamingDiagnostics {
        youtube,
        soundcloud,
        spotify_match,
        note: "Connectivity only: no track was resolved, downloaded, or played.".to_string(),
    })
}

#[tauri::command]
pub fn get_android_permission_status() -> Result<AndroidPermissionStatus, String> {
    with_activity_env(|env, context| {
        let value = call_main_activity_static(
            env,
            &context,
            "permissionStatus",
            "(Landroid/content/Context;)Ljava/lang/String;",
            &[JValue::Object(&context)],
        )?
        .l()
        .map_err(|e| e.to_string())?;
        let value = JString::from(value);
        let json: String = env.get_string(&value).map_err(|e| e.to_string())?.into();
        serde_json::from_str(&json).map_err(|e| format!("permission status JSON: {e}"))
    })
}

#[tauri::command]
pub fn request_android_permission(kind: String) -> Result<bool, String> {
    with_activity_env(|env, context| {
        let kind = env.new_string(kind).map_err(|e| e.to_string())?;
        call_main_activity_static(
            env,
            &context,
            "requestPermission",
            "(Landroid/content/Context;Ljava/lang/String;)Z",
            &[JValue::Object(&context), JValue::Object(&kind)],
        )?
        .z()
        .map_err(|e| e.to_string())
    })
}

fn returned_string(
    env: &mut jni::JNIEnv,
    value: JObject,
    operation: &str,
) -> Result<String, String> {
    let value = JString::from(value);
    env.get_string(&value)
        .map(Into::into)
        .map_err(|error| format!("{operation}: {error}"))
}

pub(crate) fn play_local(source: &str) -> Result<(), String> {
    with_activity_env(|env, context| {
        let source = env.new_string(source).map_err(|error| error.to_string())?;
        let result = call_playback_static(
            env,
            &context,
            "play",
            "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
            &[JValue::Object(&context), JValue::Object(&source)],
        )?
        .l()
        .map_err(|error| error.to_string())?;
        let error = returned_string(env, result, "PlaybackService.play result")?;
        if error.is_empty() {
            Ok(())
        } else {
            Err(error)
        }
    })
}

fn transport_bool(method: &str) -> Result<(), String> {
    with_activity_env(|env, context| {
        let accepted = call_playback_static(env, &context, method, "()Z", &[])?
            .z()
            .map_err(|error| error.to_string())?;
        if accepted {
            Ok(())
        } else {
            Err("Android playback service is not active".into())
        }
    })
}

pub(crate) fn pause() -> Result<(), String> {
    transport_bool("pause")
}

pub(crate) fn resume() -> Result<(), String> {
    transport_bool("resume")
}

pub(crate) fn seek(position_ms: u64) -> Result<(), String> {
    let position_ms = position_ms.min(i64::MAX as u64) as i64;
    with_activity_env(|env, context| {
        let accepted = call_playback_static(
            env,
            &context,
            "seek",
            "(J)Z",
            &[JValue::Long(position_ms)],
        )?
        .z()
        .map_err(|error| error.to_string())?;
        accepted
            .then_some(())
            .ok_or_else(|| "Android playback service is not active".into())
    })
}

pub(crate) fn set_volume(volume: f64) -> Result<(), String> {
    let volume = if volume.is_finite() {
        volume.clamp(0.0, 1.0)
    } else {
        1.0
    };
    with_activity_env(|env, context| {
        let accepted = call_playback_static(
            env,
            &context,
            "setVolume",
            "(D)Z",
            &[JValue::Double(volume)],
        )?
        .z()
        .map_err(|error| error.to_string())?;
        accepted
            .then_some(())
            .ok_or_else(|| "Android playback service is not active".into())
    })
}

pub(crate) fn clock() -> Result<(Duration, Duration), String> {
    with_activity_env(|env, context| {
        let value = call_playback_static(env, &context, "getClockJson", "()Ljava/lang/String;", &[])?
            .l()
            .map_err(|error| error.to_string())?;
        let json = returned_string(env, value, "PlaybackService clock")?;
        let value: serde_json::Value =
            serde_json::from_str(&json).map_err(|error| format!("Media3 clock JSON: {error}"))?;
        if let Some(error) = value
            .get("error")
            .and_then(serde_json::Value::as_str)
            .filter(|error| !error.is_empty())
        {
            return Err(error.to_string());
        }
        let position = value
            .get("positionMs")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let duration = value
            .get("durationMs")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        Ok((
            Duration::from_millis(position),
            Duration::from_millis(duration),
        ))
    })
}

pub(crate) fn stop() -> Result<(), String> {
    with_activity_env(|env, context| {
        call_playback_static(
            env,
            &context,
            "stop",
            "(Landroid/content/Context;)V",
            &[JValue::Object(&context)],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn update_android_playback_metadata(
    title: String,
    artist: String,
    album: String,
    artwork_url: String,
    duration_ms: i64,
) -> Result<(), String> {
    with_activity_env(|env, context| {
        let j_title: JString = env.new_string(title).map_err(|e| e.to_string())?;
        let j_artist: JString = env.new_string(artist).map_err(|e| e.to_string())?;
        let j_album: JString = env.new_string(album).map_err(|e| e.to_string())?;
        let j_artwork: JString = env.new_string(artwork_url).map_err(|e| e.to_string())?;
        call_playback_static(
            env,
            &context,
            "updateMetadata",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;J)V",
            &[
                JValue::Object(&context),
                JValue::Object(&j_title),
                JValue::Object(&j_artist),
                JValue::Object(&j_album),
                JValue::Object(&j_artwork),
                JValue::Long(duration_ms.max(0)),
            ],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn update_android_playback_state(
    is_playing: bool,
    position_ms: i64,
    duration_ms: i64,
    playback_rate: f64,
) -> Result<(), String> {
    with_activity_env(|env, context| {
        call_playback_static(
            env,
            &context,
            "updateState",
            "(Landroid/content/Context;ZJJD)V",
            &[
                JValue::Object(&context),
                JValue::Bool(is_playing as jboolean),
                JValue::Long(position_ms.max(0)),
                JValue::Long(duration_ms.max(0)),
                JValue::Double(if playback_rate.is_finite() {
                    playback_rate.clamp(0.5, 2.0)
                } else {
                    1.0
                }),
            ],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn stop_android_playback_service() -> Result<(), String> {
    stop()
}
