#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::TryRecvError;
use std::sync::Mutex;

use rust_tokenizers::tokenizer::{Gpt2Tokenizer, Tokenizer, TruncationStrategy};
use sqlx::{Connection, Row};
use tauri::api::http::{Body, ClientBuilder, HttpRequestBuilder, ResponseType};
use tempfile::NamedTempFile;

static mut APP_DATA_DIR: Option<PathBuf> = None;
static AUDIO_PLAYBACK_COUNTER: AtomicI64 = AtomicI64::new(0);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|context| {
            let app_data_dir_local = Some(
                tauri::api::path::resolve_path(
                    &context.config(),
                    context.package_info(),
                    &tauri::Env::default(),
                    "db/tauri.sqlite",
                    Some(tauri::api::path::BaseDirectory::AppData),
                )
                .unwrap(),
            );
            unsafe {
                APP_DATA_DIR = app_data_dir_local;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sound_test,
            sound_focus_input,
            sound_waiting_text_completion,
            speak_azure,
            count_tokens,
            speak_pico2wave
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
async fn sound_test() {
    tokio::task::spawn_blocking(|| {
        let (_stream, stream_handle) = rodio::OutputStream::try_default().unwrap();
        let sink = rodio::Sink::try_new(&stream_handle).unwrap();
        sink.set_volume(0.5);
        sink.append(rodio::source::SineWave::new(256.0));
        std::thread::sleep(std::time::Duration::from_secs(1));
    })
    .await
    .unwrap();
}

#[tauri::command]
async fn sound_focus_input() {
    tokio::task::spawn_blocking(|| {
        let (_stream, stream_handle) = rodio::OutputStream::try_default().unwrap();
        let sink = rodio::Sink::try_new(&stream_handle).unwrap();
        sink.set_volume(0.5);
        sink.append(rodio::source::SineWave::new(880.0));
        std::thread::sleep(std::time::Duration::from_millis(100));
    })
    .await
    .unwrap();
}

#[tauri::command]
async fn sound_waiting_text_completion() {
    tokio::task::spawn_blocking(|| {
        let (_stream, stream_handle) = rodio::OutputStream::try_default().unwrap();
        let sink = rodio::Sink::try_new(&stream_handle).unwrap();
        sink.set_volume(0.5);
        sink.append(rodio::source::SineWave::new(440.0)); // A
        std::thread::sleep(std::time::Duration::from_millis(200));
    })
    .await
    .unwrap();
}

async fn play_audio(data: Vec<u8>, precedence: i64) -> std::io::Result<()> {
    if data.is_empty() {
        return Ok(()); // fixes UnrecognizedFormat error
    }
    tokio::task::spawn_blocking(move || {
        let (_stream, stream_handle) = rodio::OutputStream::try_default().unwrap();
        // sink.set_volume(0.5);
        let source = rodio::Decoder::new(std::io::Cursor::new(data)).unwrap();
        let sink = rodio::Sink::try_new(&stream_handle).unwrap();
        sink.append(source);
        while !sink.empty() && precedence == AUDIO_PLAYBACK_COUNTER.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    })
    .await?;
    Ok(())
}

async fn azure_text_to_speech_request(
    region: String,
    resource_key: String,
    ssml: String,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    // fetch in @tauri-apps/api/http in frontend seems not to support binary response body, and the webview didn't play the audio even if it is tied to a mouse event.
    let client = ClientBuilder::new().max_redirections(3).build()?;
    let request = HttpRequestBuilder::new(
        "POST",
        format!(
            "https://{}.tts.speech.microsoft.com/cognitiveservices/v1",
            region
        ),
    )?
    .header("Ocp-Apim-Subscription-Key", resource_key.to_owned())?
    .header("Content-Type", "application/ssml+xml")?
    .header(
        "X-Microsoft-OutputFormat",
        "audio-48khz-96kbitrate-mono-mp3",
    )?
    .body(Body::Text(ssml.to_owned()))
    .response_type(ResponseType::Binary);

    let response = client.send(request).await?;
    let status = response.status();
    if status != 200 {
        return Err(status.to_string().into());
    }
    let data = response.bytes().await?.data;

    let mut conn = sqlx::SqliteConnection::connect(
        unsafe { APP_DATA_DIR.clone() }
            .unwrap()
            .join("audioCache.sqlite")
            .to_str()
            .unwrap(),
    )
    .await?;
    sqlx::query("INSERT OR REPLACE INTO audioCache (ssml, audio) VALUES (?, ?)")
        .bind(ssml)
        .bind(data.clone())
        .execute(&mut conn)
        .await?;

    Ok(data)
}

#[tauri::command]
async fn speak_azure(
    region: String,
    resource_key: String,
    ssml: String,
    beep_volume: f32,
) -> (bool, String) {
    let precedence = AUDIO_PLAYBACK_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;

    {
        std::fs::create_dir_all(unsafe { APP_DATA_DIR.clone().unwrap() }).unwrap();
        let mut conn = sqlx::SqliteConnection::connect(&format!(
            "sqlite://{}?mode=rwc",
            unsafe { APP_DATA_DIR.clone() }
                .unwrap()
                .join("audioCache.sqlite")
                .to_str()
                .unwrap()
        ))
        .await
        .unwrap();
        sqlx::query("CREATE TABLE IF NOT EXISTS audioCache (ssml TEXT NOT NULL PRIMARY KEY, audio BLOB NOT NULL) STRICT").execute(&mut conn).await.unwrap();
        let cached_audio = sqlx::query("SELECT audio FROM audioCache WHERE ssml = ?")
            .bind(ssml.clone())
            .fetch_optional(&mut conn)
            .await
            .unwrap();
        if let Some(data) = cached_audio {
            play_audio(data.get("audio"), precedence).await.unwrap();
            return (true, "".to_owned());
        }
    }

    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let (_stream, stream_handle) = rodio::OutputStream::try_default().unwrap();
        let sink = rodio::Sink::try_new(&stream_handle).unwrap();
        sink.set_volume(0.5 * beep_volume);
        sink.append(rodio::source::SineWave::new(659.25)); // E
        let mut i = 0;
        loop {
            match receiver.try_recv() {
                Err(TryRecvError::Empty) => {}
                _ => break,
            }
            sink.set_volume(if i % 5 == 0 { 0.5 } else { 0.0 } * beep_volume);
            std::thread::sleep(std::time::Duration::from_millis(200));
            i += 1;
        }
    });

    let data = match azure_text_to_speech_request(region, resource_key, ssml).await {
        Err(err) => {
            sender.send(()).unwrap();
            return (true, err.to_string());
        }
        Ok(data) => data,
    };

    sender.send(()).unwrap();
    play_audio(data, precedence).await.unwrap();
    (true, "".to_owned())
}

lazy_static::lazy_static! {
    static ref TOKEN_COUNT_CACHE: Mutex<VecDeque<(String, usize)>> = Mutex::new(VecDeque::new());
    static ref VOCAB_FILE: NamedTempFile = {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(include_bytes!("vocab.json")).unwrap();
        f
    };
    static ref MERGES_FILE: NamedTempFile = {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(include_bytes!("merges.txt")).unwrap();
        f
    };
}

#[tauri::command]
async fn count_tokens(content: String) -> usize {
    if let Some(&(_, count)) = TOKEN_COUNT_CACHE
        .lock()
        .unwrap()
        .iter()
        .find(|v| v.0 == content)
    {
        return count;
    }

    let count = {
        let content = content.clone();
        tokio::task::spawn_blocking(move || {
            Gpt2Tokenizer::from_file(VOCAB_FILE.path(), MERGES_FILE.path(), false)
                .unwrap()
                .encode(
                    &content,
                    None,
                    usize::MAX,
                    &TruncationStrategy::DoNotTruncate,
                    0,
                )
                .token_ids
                .len()
        })
        .await
        .unwrap()
    };

    {
        let mut cache = TOKEN_COUNT_CACHE.lock().unwrap();
        cache.push_back((content, count));
        if cache.len() > 10 {
            cache.pop_front();
        }
    }

    count
}

/// lang: en-US, en-GB, de-DE, es-ES, fr-FR, or it-IT
async fn pico2wave(content: &str, lang: &str) -> std::io::Result<()> {
    let precedence = AUDIO_PLAYBACK_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    let mut f = tempfile::Builder::new().suffix(".wav").tempfile()?;
    let path = f.path().to_str().unwrap();
    let output = Command::new("pico2wave")
        .args(&[&format!("-w={path}"), &format!("--lang={lang}"), content])
        .output()?;
    if !output.status.success() {
        let s: &str = std::str::from_utf8(&output.stderr).unwrap();
        return Err(std::io::Error::new(std::io::ErrorKind::Other, s));
    }
    println!("{:?}", output.status.success());
    let mut buf = Vec::<u8>::new();
    f.read_to_end(&mut buf)?;
    println!("{:?}", buf.len());
    play_audio(buf, precedence).await?;
    Ok(())
}

#[tauri::command]
async fn speak_pico2wave(content: String, lang: String) {
    pico2wave(&content, &lang).await.unwrap();
}

#[tokio::test]
async fn test_pico2wave() {
    pico2wave("hello", "en-US").await.unwrap();
}
