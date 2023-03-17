#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use rust_tokenizers::tokenizer::{Gpt2Tokenizer, Tokenizer, TruncationStrategy};
use serde_json::Value;
use sqlx::{Connection, Row};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::mpsc::TryRecvError;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::api::cli::ArgData;
use tauri::api::http::{Body, ClientBuilder, FormBody, FormPart, HttpRequestBuilder, ResponseType};
use tempfile::NamedTempFile;

static mut DB_PATH: Option<PathBuf> = None;
static AUDIO_PLAYBACK_COUNTER: AtomicI64 = AtomicI64::new(0);

#[derive(Debug, thiserror::Error)]
enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    SQLError(#[from] sqlx::Error),
    #[error(transparent)]
    JoinError(#[from] tokio::task::JoinError),
    #[error(transparent)]
    TauriAPIError(#[from] tauri::api::Error),
    #[error(transparent)]
    MPSCSendError(#[from] std::sync::mpsc::SendError<()>),
    #[error(transparent)]
    Utf8Error(#[from] std::str::Utf8Error),
    #[error(transparent)]
    ReqwestError(#[from] reqwest::Error),
    #[error(transparent)]
    RodioStreamError(#[from] rodio::StreamError),
    #[error(transparent)]
    RodioPlayError(#[from] rodio::PlayError),
    #[error(transparent)]
    RodioDecoderError(#[from] rodio::decoder::DecoderError),
    #[error(transparent)]
    TokenizerError(#[from] rust_tokenizers::error::TokenizerError),
    #[error(transparent)]
    CpalDefaultStreamConfigError(#[from] cpal::DefaultStreamConfigError),
    #[error(transparent)]
    CpalBuildStreamError(#[from] cpal::BuildStreamError),
    #[error(transparent)]
    CpalPlayStreamError(#[from] cpal::PlayStreamError),
    #[error(transparent)]
    HoundError(#[from] hound::Error),
    #[error("{0}")]
    SyncPoisonError(String),
    #[error("{0}")]
    StringError(String),
    #[error("{0}")]
    StatusIsNot200(String),
}

impl<T> From<std::sync::PoisonError<T>> for Error {
    fn from(value: std::sync::PoisonError<T>) -> Self {
        Error::SyncPoisonError(value.to_string())
    }
}

impl serde::Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

async fn connect_db() -> Result<sqlx::SqliteConnection, Error> {
    Ok(sqlx::SqliteConnection::connect(&format!(
        "sqlite://{}?mode=rwc", // rwc = create file if not exists
        unsafe { DB_PATH.clone() }
            .ok_or_else(|| Error::StringError("DB_PATH is not initialized yet".to_string()))?
            .to_str()
            .ok_or_else(|| Error::StringError("to_str() on DB_PATH failed".to_string()))?
    ))
    .await?)
}

fn main() {
    let mut builder = tauri::Builder::default();
    if !cfg!(target_os = "macos") {
        // Causes rendering issues on Mac
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    }
    builder
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|context| {
            match context.get_cli_matches() {
                Ok(matches) => {
                    if let Some(ArgData {
                        value: Value::String(s),
                        ..
                    }) = matches.args.get("help")
                    {
                        println!("{}", s);
                        std::process::exit(1);
                    }
                }
                Err(_) => {}
            }
            let db_path = Some(
                tauri::api::path::resolve_path(
                    &context.config(),
                    context.package_info(),
                    &tauri::Env::default(),
                    "chatgpt_tauri.db",
                    Some(tauri::api::path::BaseDirectory::AppConfig),
                )
                .unwrap(),
            );
            unsafe {
                DB_PATH = db_path;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sound_test,
            sound_focus_input,
            sound_waiting_text_completion,
            speak_azure,
            count_tokens,
            speak_pico2wave,
            get_input_loudness,
            start_listening,
            stop_listening,
            cancel_listening,
            start_chat_completion,
            stop_all_chat_completions,
            get_chat_completion,
            stop_audio,
            count_tokens_gpt3_5_turbo_0301,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
async fn sound_test() -> Result<(), Error> {
    tokio::task::spawn_blocking(|| -> Result<(), Error> {
        let (_stream, stream_handle) = rodio::OutputStream::try_default()?;
        let sink = rodio::Sink::try_new(&stream_handle)?;
        sink.set_volume(0.5);
        sink.append(rodio::source::SineWave::new(256.0));
        std::thread::sleep(std::time::Duration::from_secs(1));
        Ok(())
    })
    .await??;
    Ok(())
}

#[tauri::command]
async fn sound_focus_input() -> Result<(), Error> {
    tokio::task::spawn_blocking(|| -> Result<(), Error> {
        let (_stream, stream_handle) = rodio::OutputStream::try_default()?;
        let sink = rodio::Sink::try_new(&stream_handle)?;
        sink.set_volume(0.5);
        sink.append(rodio::source::SineWave::new(880.0));
        std::thread::sleep(std::time::Duration::from_millis(100));
        Ok(())
    })
    .await??;
    Ok(())
}

#[tauri::command]
async fn sound_waiting_text_completion() -> Result<(), Error> {
    tokio::task::spawn_blocking(|| -> Result<(), Error> {
        let (_stream, stream_handle) = rodio::OutputStream::try_default()?;
        let sink = rodio::Sink::try_new(&stream_handle)?;
        sink.set_volume(0.5);
        sink.append(rodio::source::SineWave::new(440.0)); // A
        std::thread::sleep(std::time::Duration::from_millis(200));
        Ok(())
    })
    .await??;
    Ok(())
}

async fn play_audio(data: Vec<u8>, precedence: i64) -> Result<(), Error> {
    if data.is_empty() {
        return Ok(()); // fixes UnrecognizedFormat error
    }
    tokio::task::spawn_blocking(move || -> Result<(), Error> {
        let (_stream, stream_handle) = rodio::OutputStream::try_default()?;
        // sink.set_volume(0.5);
        let source = rodio::Decoder::new(std::io::Cursor::new(data))?;
        let sink = rodio::Sink::try_new(&stream_handle)?;
        sink.append(source);
        while !sink.empty() && precedence == AUDIO_PLAYBACK_COUNTER.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        Ok(())
    })
    .await??;
    Ok(())
}

async fn azure_text_to_speech_request(
    message_id: Option<i64>,
    region: String,
    resource_key: String,
    ssml: String,
    no_cache: bool,
) -> Result<Vec<u8>, Error> {
    // fetch in @tauri-apps/api/http in frontend seems not to support binary response body, and the webview didn't play the audio even if it is tied to a mouse event.
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

    let client = ClientBuilder::new().max_redirections(3).build()?;
    let response = client.send(request).await?;
    let status = response.status();
    if status != 200 {
        return Err(Error::StatusIsNot200(status.to_string()));
    }
    let data = response.bytes().await?.data;

    let mut conn = connect_db().await?;

    if !no_cache {
        if let Some(message_id) = message_id {
            sqlx::query(
                "INSERT OR REPLACE INTO messageTTSCache (messageId, ssml, audio) VALUES (?, ?, ?)",
            )
            .bind(message_id)
            .bind(ssml)
            .bind(data.clone())
            .execute(&mut conn)
            .await?;
        } else {
            sqlx::query("INSERT OR REPLACE INTO systemTTSCache (ssml, audio) VALUES (?, ?)")
                .bind(ssml)
                .bind(data.clone())
                .execute(&mut conn)
                .await?;
        }
    }

    Ok(data)
}

#[tauri::command]
async fn speak_azure(
    message_id: Option<i64>,
    region: String,
    resource_key: String,
    ssml: String,
    beep_volume: f32,
    pre_fetch: bool,
    no_cache: bool,
) -> Result<String, Error> {
    if no_cache && pre_fetch {
        return Ok("".to_owned());
    }
    let precedence = if pre_fetch {
        0
    } else {
        AUDIO_PLAYBACK_COUNTER.fetch_add(1, Ordering::SeqCst) + 1
    };

    {
        let mut conn = connect_db().await?;
        let cached_audio = sqlx::query(
            "
SELECT audio FROM messageTTSCache WHERE ssml = ?1
UNION
SELECT audio FROM systemTTSCache WHERE ssml = ?1
LIMIT 1
",
        )
        .bind(message_id)
        .bind(ssml.clone())
        .fetch_optional(&mut conn)
        .await?;
        if let Some(data) = cached_audio {
            if !pre_fetch {
                play_audio(data.get("audio"), precedence).await?;
            }
            return Ok("".to_owned());
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

    let data = match azure_text_to_speech_request(message_id, region, resource_key, ssml, no_cache)
        .await
    {
        Err(err) => {
            sender.send(())?;
            return Err(err);
        }
        Ok(data) => data,
    };

    sender.send(())?;
    if !pre_fetch {
        play_audio(data, precedence).await?;
    }
    Ok("".to_owned())
}

/// https://github.com/rust-lang/rust/issues/72353#issuecomment-1093729062
pub struct AtomicF32 {
    storage: AtomicU32,
}

impl AtomicF32 {
    pub fn new(value: f32) -> Self {
        Self {
            storage: AtomicU32::new(value.to_bits()),
        }
    }
    pub fn store(&self, value: f32, ordering: Ordering) {
        self.storage.store(value.to_bits(), ordering)
    }
    pub fn load(&self, ordering: Ordering) -> f32 {
        f32::from_bits(self.storage.load(ordering))
    }
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

    /// [0, infty] -> volume
    /// -1 -> transcribing
    static ref INPUT_LOUDNESS: AtomicF32 = AtomicF32::new(0.0);

    static ref CHAT_COMPLETION_RESPONSE: Arc<Mutex<HashMap<u64, Vec<String>>>> = Arc::new(Mutex::new(HashMap::new()));
    static ref CHAT_COMPLETION_CANCELED: Arc<Mutex<HashSet<u64>>> = Arc::new(Mutex::new(HashSet::new()));
}

#[tauri::command]
async fn count_tokens(content: String) -> Result<usize, Error> {
    if let Some(&(_, count)) = TOKEN_COUNT_CACHE.lock()?.iter().find(|v| v.0 == content) {
        return Ok(count);
    }

    let count = {
        let content = content.clone();
        tokio::task::spawn_blocking(move || -> Result<usize, Error> {
            Ok(
                Gpt2Tokenizer::from_file(VOCAB_FILE.path(), MERGES_FILE.path(), false)?
                    .encode(
                        &content,
                        None,
                        usize::MAX,
                        &TruncationStrategy::DoNotTruncate,
                        0,
                    )
                    .token_ids
                    .len(),
            )
        })
        .await??
    };

    {
        let mut cache = TOKEN_COUNT_CACHE.lock()?;
        cache.push_back((content, count));
        if cache.len() > 100 {
            cache.pop_front();
        }
    }

    Ok(count)
}

/// lang: en-US, en-GB, de-DE, es-ES, fr-FR, or it-IT
#[tauri::command]
async fn speak_pico2wave(content: String, lang: String) -> Result<(), Error> {
    let precedence = AUDIO_PLAYBACK_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    let mut f = tempfile::Builder::new().suffix(".wav").tempfile()?;
    let path = f
        .path()
        .to_str()
        .ok_or_else(|| Error::StringError(format!("{f:?}.to_str() failed")))?;
    let output = Command::new("pico2wave")
        .args(&[&format!("-w={path}"), &format!("--lang={lang}"), &content])
        .output()?;
    if !output.status.success() {
        return Err(Error::StringError(
            std::str::from_utf8(&output.stderr)?.to_owned(),
        ));
    }
    println!("{:?}", output.status.success());
    let mut buf = Vec::<u8>::new();
    f.read_to_end(&mut buf)?;
    println!("{:?}", buf.len());
    play_audio(buf, precedence).await?;
    Ok(())
}

static RECORDING_COUNTER: AtomicI64 = AtomicI64::new(0);
static RECORDING_CANCELED: AtomicI64 = AtomicI64::new(-1);

#[tauri::command]
fn stop_listening() {
    RECORDING_COUNTER.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
fn cancel_listening() {
    RECORDING_CANCELED.store(
        RECORDING_COUNTER.fetch_add(1, Ordering::SeqCst),
        Ordering::SeqCst,
    );
}

#[tauri::command]
fn get_input_loudness() -> f32 {
    INPUT_LOUDNESS.load(Ordering::SeqCst)
}

#[tauri::command]
fn stop_audio() {
    AUDIO_PLAYBACK_COUNTER.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
async fn start_listening(
    openai_key: String,
    language: String, // "" to auto-detect
) -> Result<String, Error> {
    INPUT_LOUDNESS.store(0.0, Ordering::SeqCst);
    let mut f = NamedTempFile::new()?;

    {
        let path = f.path().to_owned();
        let precedence = RECORDING_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
        tokio::task::spawn_blocking(move || -> Result<(), Error> {
            use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
            use cpal::SampleFormat;
            use dasp_sample::conv;

            let device = cpal::default_host()
                .default_input_device()
                .expect("Failed to get default input device");
            let config = device.default_output_config()?;
            let mut wav_writer = hound::WavWriter::create(
                path,
                hound::WavSpec {
                    channels: 1,
                    sample_rate: config.config().sample_rate.0,
                    bits_per_sample: 32,
                    sample_format: hound::SampleFormat::Float,
                },
            )?;

            let channels = config.channels() as usize;
            fn update_input_loudness(samples: &[f32]) {
                let mut result = 0.0;
                for x in samples {
                    result += (x * x) / samples.len() as f32;
                }
                INPUT_LOUDNESS.store(result.sqrt(), Ordering::SeqCst);
            }
            macro_rules! build {
                ($sample_format:pat, $sample_converter:expr) => {
                    device.build_input_stream(
                        &config.config(),
                        move |data, _| {
                            let mut f32_samples = vec![];
                            for sample in data.chunks(channels) {
                                let sum: f32 = sample.iter().map($sample_converter).sum();
                                let avg = sum / channels as f32;
                                f32_samples.push(avg);
                                wav_writer.write_sample(avg).unwrap();
                            }
                            update_input_loudness(&f32_samples);
                        },
                        |_| {},
                        None,
                    )?
                };
            }

            let stream = match config.sample_format() {
                SampleFormat::I8 => build!(SampleFormat::I8, |&x| conv::i8::to_f32(x)),
                SampleFormat::I16 => build!(SampleFormat::I16, |&x| conv::i16::to_f32(x)),
                SampleFormat::I32 => build!(SampleFormat::I32, |&x| conv::i32::to_f32(x)),
                SampleFormat::I64 => build!(SampleFormat::I64, |&x| conv::i64::to_f32(x)),
                SampleFormat::U8 => build!(SampleFormat::U8, |&x| conv::u8::to_f32(x)),
                SampleFormat::U16 => build!(SampleFormat::U16, |&x| conv::u16::to_f32(x)),
                SampleFormat::U32 => build!(SampleFormat::U32, |&x| conv::u32::to_f32(x)),
                SampleFormat::U64 => build!(SampleFormat::U64, |&x| conv::u64::to_f32(x)),
                SampleFormat::F32 => build!(SampleFormat::F32, |x| x),
                SampleFormat::F64 => build!(SampleFormat::F64, |&x| conv::f64::to_f32(x)),
                _ => unimplemented!(),
            };
            stream.play()?;

            while precedence == RECORDING_COUNTER.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(50)); // `stream does` not implement Send`
            }

            Ok(())
        })
        .await??;
        if precedence <= RECORDING_CANCELED.load(Ordering::SeqCst) {
            return Ok("".to_owned());
        }
    }
    INPUT_LOUDNESS.store(-1f32, Ordering::SeqCst);

    let mut buf = vec![];
    f.read_to_end(&mut buf)?;
    let mut body = HashMap::new();
    body.insert(
        "file".to_owned(),
        FormPart::File {
            file: tauri::api::http::FilePart::Contents(buf),
            mime: Some("audio/x-wav".to_owned()),
            file_name: Some("audio.wav".to_owned()),
        },
    );
    body.insert("model".to_owned(), FormPart::Text("whisper-1".to_owned()));
    if !language.is_empty() {
        body.insert("language".to_owned(), FormPart::Text(language));
    }
    let request =
        HttpRequestBuilder::new("POST", "https://api.openai.com/v1/audio/transcriptions")?
            .header("Authorization", format!("Bearer {openai_key}"))?
            .header("Content-Type", "multipart/form-data")?
            .body(Body::Form(FormBody::new(body)))
            .response_type(ResponseType::Json);

    let client = ClientBuilder::new().max_redirections(3).build()?;
    let response = client.send(request).await?;
    let status = response.status();
    if status != 200 {
        return Err(Error::StringError(format!(
            "{}: {}",
            status,
            &response.read().await?.data
        )));
    }
    let data = response.read().await?.data;
    Ok(data
        .as_object()
        .ok_or_else(|| Error::StringError(format!("Unexpected response: {data}")))?
        .get("text")
        .ok_or_else(|| Error::StringError(format!("Unexpected response: {data}")))?
        .as_str()
        .ok_or_else(|| Error::StringError(format!("Unexpected response: {data}")))?
        .to_owned())
}

fn handle_chat_completion_server_event(request_id: u64, buf: &[u8]) -> Result<(), Error> {
    if !buf.starts_with(b"data: [DONE]") && buf.starts_with(b"data: ") {
        CHAT_COMPLETION_RESPONSE
            .lock()?
            .entry(request_id)
            .or_insert(vec![])
            .push(String::from_utf8_lossy(&buf[b"data: ".len()..]).into());
    }
    Ok(())
}

#[tauri::command]
fn stop_all_chat_completions() -> Result<(), Error> {
    for id in CHAT_COMPLETION_RESPONSE.lock()?.keys() {
        CHAT_COMPLETION_CANCELED.lock()?.insert(*id);
    }
    Ok(())
}

#[tauri::command]
async fn start_chat_completion(
    request_id: u64,
    secret_key: String, // OpenAI API key or Azure Active Directory token
    body: String,
    endpoint: String, // use "https://api.openai.com/v1/chat/completions" for openai
    api_key_authentication: bool, // use false for openai, see https://learn.microsoft.com/en-us/azure/cognitive-services/openai/reference#authentication for azure
) -> Result<(), Error> {
    let client = reqwest::Client::new()
        .post(endpoint)
        .header("Content-Type", "application/json");
    let client = if api_key_authentication {
        client.header("api-key", secret_key)
    } else {
        client.header("Authorization", format!("Bearer {secret_key}"))
    };
    let mut res = client.body(body).send().await?;
    let mut buf = Vec::<u8>::new();
    let mut is_prev_char_newline = false;
    if res.status() != 200 {
        return Err(Error::StatusIsNot200(format!(
            "{}: {}",
            res.status(),
            res.text().await?
        )));
    }
    while let Some(chunk) = res.chunk().await? {
        for value in chunk {
            // split with "\n\n"
            let newline = value == '\n' as u8;
            if newline && is_prev_char_newline {
                is_prev_char_newline = false;
                handle_chat_completion_server_event(request_id, &buf)?;
                buf.clear();
            } else {
                buf.push(value);
                is_prev_char_newline = newline;
            }
        }

        if CHAT_COMPLETION_CANCELED.lock()?.contains(&request_id) {
            return Ok(());
        }
    }
    handle_chat_completion_server_event(request_id, &buf)?;
    buf.clear();
    Ok(())
}

#[tauri::command]
async fn get_chat_completion(request_id: u64) -> Result<Vec<String>, Error> {
    let mut stream = CHAT_COMPLETION_RESPONSE.lock()?;
    let vec = stream.entry(request_id).or_default();
    let result = vec.clone();
    vec.clear();
    Ok(result)
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Message {
    role: String,
    name: Option<String>,
    content: String,
}

/// https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb
#[tauri::command]
async fn count_tokens_gpt3_5_turbo_0301(messages: Vec<Message>) -> Result<usize, Error> {
    let mut num_tokens: usize = 0;

    for message in messages {
        num_tokens += 4; // "<im_start>" "\n" "<im_end>" "\n"
        if let Some(name) = message.name {
            num_tokens += count_tokens(name).await?;
        } else {
            num_tokens += count_tokens(message.role).await?
        }
        num_tokens += count_tokens(message.content).await?;
    }

    num_tokens += 2; // "<im_start>" "assistant"

    Ok(num_tokens)
}
