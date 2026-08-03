//! Push current lyric line to an Android BigText notification (Harmonoid-style).

#![cfg(target_os = "android")]

use jni::objects::{JObject, JString, JValue};
use jni::JavaVM;

fn with_activity_env<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce(&mut jni::JNIEnv, JObject) -> Result<R, String>,
{
    let ctx = ndk_context::android_context();
    let vm =
        unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| format!("JavaVM: {}", e))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach: {}", e))?;
    let context = unsafe { JObject::from_raw(ctx.context() as jni::sys::jobject) };
    f(&mut env, context)
}

pub fn show_lyrics_line(title: &str, artist: &str, line: &str) -> Result<(), String> {
    with_activity_env(|env, context| {
        let j_title: JString = env.new_string(title).map_err(|e| e.to_string())?;
        let j_artist: JString = env.new_string(artist).map_err(|e| e.to_string())?;
        let j_line: JString = env.new_string(line).map_err(|e| e.to_string())?;
        env.call_static_method(
            "com/nishal21/nekobeat/LyricsNotification",
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
        env.call_static_method(
            "com/nishal21/nekobeat/LyricsNotification",
            "clear",
            "(Landroid/content/Context;)V",
            &[JValue::Object(&context)],
        )
        .map_err(|e| format!("LyricsNotification.clear: {}", e))?;
        Ok(())
    })
}

#[tauri::command]
pub fn update_lyrics_notification(title: String, artist: String, line: String) -> Result<(), String> {
    show_lyrics_line(&title, &artist, &line)
}

#[tauri::command]
pub fn clear_lyrics_notification_cmd() -> Result<(), String> {
    clear_lyrics_notification()
}
