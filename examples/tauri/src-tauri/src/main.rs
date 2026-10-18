#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::sync::{Arc, Mutex};
use std::process::Child;
use tauri::Manager;
#[derive(Default)]
struct Playback { serial: u64, pending: bool, child: Option<(u64, Child)> }
type VoiceState = Arc<Mutex<Playback>>;
#[tauri::command]
fn local_speech_cancel(state: tauri::State<'_, VoiceState>) -> Result<(), String> {
    stop_voice(state.inner())
}
fn stop_voice(state: &VoiceState) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "Voice lock poisoned")?;
    state.serial = state.serial.wrapping_add(1); state.pending = false;
    if let Some((_, mut child)) = state.child.take() { let _ = child.kill(); let _ = child.wait(); }
    Ok(())
}
#[tauri::command]
async fn local_speech_speak(text: String, language: String, voice_uri: Option<String>, rate: f64, pitch: f64, state: tauri::State<'_, VoiceState>) -> Result<(), String> {
    if text.trim().is_empty() || text.chars().count() > 4000 || text.contains('\0') { return Err("Invalid speech text".into()); }
    if !rate.is_finite() || !(0.5..=2.0).contains(&rate) || pitch != 1.0 || voice_uri.is_some() { return Err("Native demo supports rate 0.5–2, pitch 1 and automatic local voice".into()); }
    if !["ru", "ru-RU", "en", "en-US", "en-GB"].contains(&language.as_str()) { return Err("Unsupported voice language".into()); }
    let shared = state.inner().clone();
    let id = { let mut state = shared.lock().map_err(|_| "Voice lock poisoned")?;
        if state.pending || state.child.is_some() { return Err("Native voice busy".into()); }
        state.serial = state.serial.wrapping_add(1); state.pending = true; state.serial };
    let worker = shared.clone();
    let result = tauri::async_runtime::spawn_blocking(move || speak_local(text, language, rate, worker, id)).await.map_err(|e| e.to_string()).and_then(|r| r);
    if let Ok(mut state) = shared.lock() { if state.serial == id { state.pending = false; } }
    result
}
#[cfg(target_os = "macos")]
fn speak_local(text: String, language: String, rate: f64, shared: VoiceState, id: u64) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let locale = if language.starts_with("ru") { "ru_RU" } else { "en_US" };
    let voices = Command::new("/usr/bin/say").args(["-v", "?"]).output().map_err(|e| e.to_string())?;
    let listing = String::from_utf8_lossy(&voices.stdout);
    let name = listing.lines().find_map(|line| line.find(locale).map(|i| line[..i].trim())).ok_or("No installed native voice for this language")?;
    let id = {
        let mut state = shared.lock().map_err(|_| "Voice lock poisoned")?;
        if state.serial != id || !state.pending { return Err("Speech cancelled".into()); }
        // Literal argv; never interpret dictated text as a shell command.
        let child = Command::new("/usr/bin/say").args(["-v", name, "-r", &(180.0 * rate).round().to_string(), "--", &text]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
        state.pending = false; state.child = Some((id, child)); id
    };
    loop {
        {
            let mut state = shared.lock().map_err(|_| "Voice lock poisoned")?;
            let Some((current, child)) = state.child.as_mut() else { return Err("Speech cancelled".into()); };
            if *current != id { return Err("Speech cancelled".into()); }
            match child.try_wait() {
                Ok(Some(status)) => { state.child = None; return if status.success() { Ok(()) } else { Err("Native synthesis failed".into()) }; }
                Err(error) => { if let Some((_, mut child)) = state.child.take() { let _ = child.kill(); let _ = child.wait(); } return Err(error.to_string()); }
                Ok(None) => {}
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}
#[cfg(not(target_os = "macos"))]
fn speak_local(_: String, _: String, _: f64, _: VoiceState, _: u64) -> Result<(), String> { Err("Provide a local native TTS adapter for this OS".into()) }
fn main() {
    tauri::Builder::default().manage(VoiceState::default())
        .invoke_handler(tauri::generate_handler![local_speech_speak, local_speech_cancel])
        .on_window_event(|window, event| { if matches!(event, tauri::WindowEvent::Destroyed) { let _ = stop_voice(window.state::<VoiceState>().inner()); } })
        .run(tauri::generate_context!()).expect("Failed to start LocalSpeech example");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_invalidates_pending_generation() {
        let shared = VoiceState::default();
        { let mut state = shared.lock().unwrap(); state.pending = true; state.serial = 7; }
        stop_voice(&shared).unwrap();
        let state = shared.lock().unwrap(); assert!(!state.pending); assert_eq!(state.serial, 8); assert!(state.child.is_none());
    }
}
