//! Push the current lyric line to an Android BigText notification.
//! Timed cues are owned by native LyricsSync so updates continue in the background.

#![cfg(target_os = "android")]

use jni::objects::{JObject, JString, JValue};
use jni::JavaVM;

fn with_activity_env<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce(&mut jni::JNIEnv, JObject) -> Result<R, String>,
{
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| format!("JavaVM: {}", e))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach: {}", e))?;
    let context = unsafe { JObject::from_raw(ctx.context() as jni::sys::jobject) };
    f(&mut env, context)
}

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
        .map_err(|e| e.to_string())?;
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

fn load_lyrics_class<'local>(
    env: &mut jni::JNIEnv<'local>,
    context: &JObject<'_>,
) -> Result<jni::objects::JClass<'local>, String> {
    load_app_class(env, context, "com.nishal21.nekobeat.LyricsNotification")
}

pub fn show_lyrics_line(title: &str, artist: &str, line: &str) -> Result<(), String> {
    with_activity_env(|env, context| {
        let class = load_lyrics_class(env, &context)?;
        let j_title: JString = env.new_string(title).map_err(|e| e.to_string())?;
        let j_artist: JString = env.new_string(artist).map_err(|e| e.to_string())?;
        let j_line: JString = env.new_string(line).map_err(|e| e.to_string())?;
        env.call_static_method(
            class,
            "show",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
            &[
                JValue::Object(&context),
                JValue::Object(&j_title),
                JValue::Object(&j_artist),
                JValue::Object(&j_line),
            ],
        )
        .map_err(|e| format!("LyricsNotification.show: {}", e))?;
        Ok(())
    })
}

pub fn clear_lyrics_notification() -> Result<(), String> {
    with_activity_env(|env, context| {
        let playback = load_app_class(env, &context, "com.nishal21.nekobeat.PlaybackService")?;
        let _ = env.call_static_method(playback, "clearLyricsCues", "()V", &[]);
        let class = load_lyrics_class(env, &context)?;
        env.call_static_method(
            class,
            "clear",
            "(Landroid/content/Context;)V",
            &[JValue::Object(&context)],
        )
        .map_err(|e| format!("LyricsNotification.clear: {}", e))?;
        Ok(())
    })
}

pub fn set_lyrics_cues_native(
    title: &str,
    artist: &str,
    cues_json: &str,
    offset_ms: i64,
) -> Result<(), String> {
    with_activity_env(|env, context| {
        let class = load_app_class(env, &context, "com.nishal21.nekobeat.PlaybackService")?;
        let j_title: JString = env.new_string(title).map_err(|e| e.to_string())?;
        let j_artist: JString = env.new_string(artist).map_err(|e| e.to_string())?;
        let j_cues: JString = env.new_string(cues_json).map_err(|e| e.to_string())?;
        env.call_static_method(
            class,
            "setLyricsCues",
            "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;J)V",
            &[
                JValue::Object(&j_title),
                JValue::Object(&j_artist),
                JValue::Object(&j_cues),
                JValue::Long(offset_ms),
            ],
        )
        .map_err(|e| format!("PlaybackService.setLyricsCues: {}", e))?;
        Ok(())
    })
}

#[tauri::command]
pub fn update_lyrics_notification(
    title: String,
    artist: String,
    line: String,
) -> Result<(), String> {
    show_lyrics_line(&title, &artist, &line)
}

#[tauri::command]
pub fn set_lyrics_cues(
    title: String,
    artist: String,
    cues_json: String,
    offset_ms: i64,
) -> Result<(), String> {
    set_lyrics_cues_native(&title, &artist, &cues_json, offset_ms)
}

#[tauri::command]
pub fn clear_lyrics_notification_cmd() -> Result<(), String> {
    clear_lyrics_notification()
}
