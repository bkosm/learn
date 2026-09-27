---
name: speech-audio
description: Record Thai practice on demand, transcribe locally, generate speech MP3s, and embed audio in Obsidian lesson artifacts.
---

# Speech audio

Use this skill when the user requests spoken audio. For this user, every Thai lesson has a standing request for TTS: generate separate audio for each newly introduced Thai word or phrase and include its embed alongside the script and romanization, before using the item in a quiz. This includes items in examples and quiz options; do not make an unvoiced Thai item a recognition target. This standing Thai preference overrides the general rule not to generate audio automatically. For other languages, generate audio only when requested.

## Record and analyze learner speech

When the user requests pronunciation practice for each new item, offer a spoken attempt after they have listened to its TTS. This is an open spoken-response exercise, not a multiple-choice `quiz`; use `start_thai_recording` to capture it.

1. When the user is ready to speak Thai, call `start_thai_recording`. Tell them to speak when the tool says recording is live; any non-empty text chat message stops the recording and is consumed as the stop signal. A 60-second safety limit stops and processes the clip if they forget.
2. On any text chat message during recording, the extension stops recording, transcribes locally with Whisper, saves only an embeddable MP3 under `audio/recordings/`, and deletes the temporary WAV. No audio is uploaded or retained as WAV.
3. In the reply and lesson artifact, include the transcript in Thai with learner-friendly romanization, compare it with the intended phrase/meaning when known, and embed the MP3 using the exact returned Obsidian link.
4. Treat Whisper's transcript as evidence about recognized words only. Do not claim that it proves correct pronunciation or tone; tone feedback needs acoustic analysis and should be presented as tentative unless validated.

## Generate and embed

1. Call `generate_speech_audio` with the Thai text and an explicit `path` inside the vault's `audio/` folder, e.g. `audio/greeting-sawasdee.mp3`. The path is required; do not omit it.
2. The tool uses the local macOS Kanya voice, converts its output to MP3 with `ffmpeg`, and saves it at the requested path under `audio/`.
3. Present the Thai text with a learner-friendly Latin-script romanization, then include the exact Obsidian embed returned by the tool in your reply, on its own line, for example:

   `![[audio/greeting-sawasdee-<timestamp>.mp3]]`

If the audio tool fails (for example, due to a missing output path), use the local macOS `say -v Kanya` command and `ffmpeg` to explicitly write the MP3 into the existing `audio/` directory. Verify the resulting file exists before embedding it; report failure if the fallback also fails.

The session's `md-log` mirrors assistant text into the lesson markdown, so the embed is recorded with the lesson. The MP3 is a separate vault file and stays local; speech generation does not call a hosted TTS API.

If generation fails because `say`, the Kanya voice, or `ffmpeg` is unavailable, report the error rather than claiming an audio file was created.
