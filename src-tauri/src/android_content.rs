//! Copy Android `content://` URIs into app-private storage so GStreamer can play them.
//! Materialize a real filesystem path before the audio engine sees the file.

#![cfg(target_os = "android")]

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use jni::objects::{JObject, JString, JValue};
use jni::JavaVM;
use sha1::{Digest, Sha1};

fn guess_ext(uri: &str, mime: &str) -> &'static str {
    let lower = format!("{} {}", uri.to_lowercase(), mime.to_lowercase());
    if lower.contains("flac") {
        "flac"
    } else if lower.contains("mpeg") || lower.contains(".mp3") {
        "mp3"
    } else if lower.contains("mp4")
        || lower.contains("m4a")
        || lower.contains("aac")
        || lower.contains("alac")
    {
        "m4a"
    } else if lower.contains("opus") {
        "opus"
    } else if lower.contains("ogg") {
        "ogg"
    } else if lower.contains("wav") {
        "wav"
    } else if lower.contains("wma") {
        "wma"
    } else if lower.contains("aiff") || lower.contains("aif") {
        "aiff"
    } else if lower.contains("ape") {
        "ape"
    } else if lower.contains("wv") || lower.contains("wavpack") {
        "wv"
    } else if lower.contains("webm") {
        "webm"
    } else if lower.contains("dsf") {
        "dsf"
    } else if lower.contains("dff") || lower.contains("dsd") {
        "dff"
    } else {
        "audio"
    }
}

/// Copy a `content://` (or other ContentResolver URI) into `dest_dir/<hash>.<ext>`.
pub fn materialize_content_uri(uri: &str, dest_dir: &Path) -> Result<PathBuf, String> {
    if !uri.starts_with("content:") {
        return Err(format!("Not a content URI: {}", uri));
    }
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;

    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| format!("JavaVM: {}", e))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach: {}", e))?;
    let context = unsafe { JObject::from_raw(ctx.context() as jni::sys::jobject) };

    let resolver = env
        .call_method(
            &context,
            "getContentResolver",
            "()Landroid/content/ContentResolver;",
            &[],
        )
        .map_err(|e| format!("getContentResolver: {}", e))?
        .l()
        .map_err(|e| format!("resolver obj: {}", e))?;

    let j_uri_str: JString = env
        .new_string(uri)
        .map_err(|e| format!("new_string uri: {}", e))?;
    let android_uri = env
        .call_static_method(
            "android/net/Uri",
            "parse",
            "(Ljava/lang/String;)Landroid/net/Uri;",
            &[JValue::Object(&j_uri_str)],
        )
        .map_err(|e| format!("Uri.parse: {}", e))?
        .l()
        .map_err(|e| format!("uri obj: {}", e))?;

    // Best-effort MIME for extension
    let mime: String = env
        .call_method(
            &resolver,
            "getType",
            "(Landroid/net/Uri;)Ljava/lang/String;",
            &[JValue::Object(&android_uri)],
        )
        .ok()
        .and_then(|v| v.l().ok())
        .map(|s| {
            let js = JString::from(s);
            env.get_string(&js).map(String::from).unwrap_or_default()
        })
        .unwrap_or_default();

    let stream = env
        .call_method(
            &resolver,
            "openInputStream",
            "(Landroid/net/Uri;)Ljava/io/InputStream;",
            &[JValue::Object(&android_uri)],
        )
        .map_err(|e| format!("openInputStream: {}", e))?
        .l()
        .map_err(|e| format!("stream: {}", e))?;

    if stream.is_null() {
        return Err("Could not open content URI (null stream)".into());
    }

    let mut hasher = Sha1::new();
    hasher.update(uri.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    let ext = guess_ext(uri, &mime);
    let out_path = dest_dir.join(format!("{}.{}", &hash[..16.min(hash.len())], ext));

    // Stream bytes through a Java buffer into Rust
    let buf_size = 64 * 1024;
    let jbuf = env
        .new_byte_array(buf_size as i32)
        .map_err(|e| format!("byte array: {}", e))?;

    let copy_result: Result<(), String> = (|| {
        let mut file = File::create(&out_path).map_err(|e| e.to_string())?;
        loop {
            let n = env
                .call_method(&stream, "read", "([B)I", &[JValue::from(&jbuf)])
                .map_err(|e| format!("InputStream.read: {}", e))?
                .i()
                .map_err(|e| format!("read int: {}", e))?;
            if n <= 0 {
                break;
            }
            let chunk = env
                .convert_byte_array(&jbuf)
                .map_err(|e| format!("convert_byte_array: {}", e))?;
            file.write_all(&chunk[..n as usize])
                .map_err(|e| e.to_string())?;
        }
        file.flush().map_err(|e| e.to_string())?;
        Ok(())
    })();

    let _ = env.call_method(&stream, "close", "()V", &[]);
    if let Err(error) = copy_result {
        let _ = fs::remove_file(&out_path);
        return Err(error);
    }

    if !out_path.is_file() || fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0) == 0 {
        let _ = fs::remove_file(&out_path);
        return Err("Copied content URI was empty".into());
    }

    println!(
        "Android: materialized {} → {:?} ({} bytes)",
        uri,
        out_path,
        fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0)
    );
    Ok(out_path)
}
