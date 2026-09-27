import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const execFileAsync = promisify(execFile);
const VOICE = "Kanya";
const AUDIO_DIR = "audio";
const RECORDINGS_DIR = path.join(AUDIO_DIR, "recordings");
const WHISPER_MODEL = path.join(os.homedir(), ".local", "share", "whisper.cpp", "models", "ggml-large-v3-turbo-q5_0.bin");
const MAX_RECORDING_MS = 60_000;

type CloseInfo = { code: number | null; signal: NodeJS.Signals | null };
interface ActiveRecording {
	child: ChildProcess;
	wavPath: string;	mp3Path: string;
	tempDir: string;
	relativeMp3: string;
	stderr: string;
	closeInfo?: CloseInfo;
	closePromise: Promise<CloseInfo>;
	timeout: NodeJS.Timeout;
}

let activeRecording: ActiveRecording | null = null;

function slugify(value: string): string {
	return value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48) || "thai-speech";
}

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

async function finalizeRecording(recording: ActiveRecording): Promise<string> {
	clearTimeout(recording.timeout);
	if (!recording.closeInfo) {
		try {
			recording.child.stdin?.write("q\n");
		} catch {
			// The process may already have exited; closePromise reports its status.
		}
		const forcedStop = setTimeout(() => {
			if (!recording.closeInfo) recording.child.kill("SIGINT");
		}, 5_000);
		await recording.closePromise;
		clearTimeout(forcedStop);
	}

	try {
		if (recording.closeInfo?.code !== 0) {
			throw new Error(`ffmpeg stopped unexpectedly (${recording.closeInfo?.signal || recording.closeInfo?.code}). ${recording.stderr.trim()}`);
		}
		const wavStat = await fs.stat(recording.wavPath).catch(() => null);
		if (!wavStat?.size) throw new Error("No audio was captured. Check microphone permission and try again.");

		await execFileAsync(
			"ffmpeg",
			["-hide_banner", "-loglevel", "error", "-y", "-i", recording.wavPath, "-codec:a", "libmp3lame", "-b:a", "128k", recording.mp3Path],
			{ timeout: 120_000 },
		);

		let transcript = "";
		let transcriptionNote = "";
		try {
			const result = await execFileAsync(
				"whisper-cli",
				["-m", WHISPER_MODEL, "-l", "th", "-f", recording.wavPath, "-nt", "-np"],
				{ timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
			);
			transcript = result.stdout.trim();
			if (!transcript) transcriptionNote = "Whisper returned no transcript (possibly silence or unclear speech).";
		} catch (error) {
			transcriptionNote = `Local transcription failed: ${error instanceof Error ? error.message : String(error)}`;
		}

		return [
			transcript ? `Spoken attempt transcript: ${transcript}` : transcriptionNote,
			`![[${recording.relativeMp3}]]`,
		].join("\n");
	} finally {
		await fs.rm(recording.tempDir, { recursive: true, force: true });
	}
}

export default function speechAudio(pi: ExtensionAPI) {
	pi.registerTool({
		name: "generate_speech_audio",
		label: "Generate Speech Audio",
		description:
			"Generate a Thai MP3 locally using the macOS Kanya voice. Requires an explicit output " +
			"path inside the vault's audio/ folder. Returns an Obsidian embed. Use only when the " +
			"user asks for audio; do not generate audio automatically for every language example. " +
			"After the tool succeeds, include the returned `![[audio/filename.mp3]]` embed " +
			"in your reply so md-log records it with the lesson.",
		parameters: Type.Object({
			text: Type.String({ description: "Thai text to speak." }),
			path: Type.String({
				description: "Required destination MP3 path such as 'audio/greeting-sawasdee.mp3', relative to the vault root. Must stay inside audio/.",
			}),
		}),
		async execute(_id, params, ctx) {
			const text = String(params.text ?? "").trim();
			if (!text) throw new Error("`generate_speech_audio` requires non-empty text.");
			const requestedPath = String(params.path ?? "").trim();
			if (!requestedPath) throw new Error("`generate_speech_audio` requires an explicit output `path`.");
			if (process.platform !== "darwin") {
				throw new Error("Thai MP3 generation currently requires macOS (`say` with the Kanya voice).");
			}

			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-speech-audio-"));
			try {
				const aiffPath = path.join(tempDir, "speech.aiff");
				const cwd = ctx.cwd || process.cwd();
				const outDir = path.resolve(cwd, AUDIO_DIR);
				const mp3Path = path.resolve(cwd, requestedPath);
				const relativeToAudio = path.relative(outDir, mp3Path);
				if (relativeToAudio.startsWith("..") || path.isAbsolute(relativeToAudio)) {
					throw new Error("The output path must stay inside the vault's audio/ directory.");
				}
				if (path.extname(mp3Path).toLowerCase() !== ".mp3") {
					throw new Error("The output path must end with .mp3.");
				}
				await fs.mkdir(path.dirname(mp3Path), { recursive: true });

				try {
					await execFileAsync("say", ["-v", VOICE, "-o", aiffPath, text], { timeout: 120_000 });
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					throw new Error(`macOS speech synthesis failed for voice ${VOICE}: ${detail}`);
				}

				try {
					await execFileAsync(
						"ffmpeg",
						["-hide_banner", "-loglevel", "error", "-y", "-i", aiffPath, "-codec:a", "libmp3lame", "-q:a", "3", mp3Path],
						{ timeout: 120_000 },
					);
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					throw new Error(`MP3 encoding failed. Install ffmpeg and retry: ${detail}`);
				}

				const stat = await fs.stat(mp3Path);
				if (!stat.size) throw new Error("MP3 generation produced an empty file.");

				const relativePath = path.relative(cwd, mp3Path).split(path.sep).join("/");
				const embed = `![[${relativePath}]]`;
				return {
					content: [{ type: "text", text: `Generated Thai audio with macOS ${VOICE}.\nFile: ${relativePath}\nObsidian embed: ${embed}` }],
					details: { ok: true, path: mp3Path, relativePath, embed, voice: VOICE, bytes: stat.size },
				};
			} finally {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		},
	});

	pi.registerTool({
		name: "start_thai_recording",
		label: "Start Thai Recording",
		description:
			"When the user is ready to speak Thai, start an open-ended local microphone recording. " +
			"Tell the user to speak; any non-empty text chat message stops the recording. The input handler " +
			"stops ffmpeg, transcribes locally with whisper.cpp, saves only an embeddable MP3 in " +
			"audio/recordings/, and passes the transcript and embed back to the agent. Recording " +
			"auto-stops after 60 seconds. Never claim ASR alone proves correct pronunciation or tones.",
		parameters: Type.Object({
			slug: Type.Optional(
				Type.String({ description: "Short kebab-case topic slug, e.g. 'sawasdee-practice'." }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (process.platform !== "darwin") throw new Error("Thai recording currently requires macOS and a microphone.");
			if (activeRecording) throw new Error("A Thai recording is already active. Send any text chat message to stop it.");
			const modelStat = await fs.stat(WHISPER_MODEL).catch(() => null);
			if (!modelStat?.isFile()) throw new Error(`Whisper model not found at ${WHISPER_MODEL}. See README.md.`);

			const outDir = path.join(ctx.cwd, RECORDINGS_DIR);
			await fs.mkdir(outDir, { recursive: true });
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-thai-recording-"));
			const base = `${slugify(String(params.slug || "thai-practice"))}-${timestamp()}`;
			const wavPath = path.join(tempDir, "recording.wav");
			const mp3Path = path.join(outDir, `${base}.mp3`);
			const relativeMp3 = `${RECORDINGS_DIR}/${path.basename(mp3Path)}`;
			const child = spawn(
				"ffmpeg",
				[
					"-hide_banner", "-loglevel", "error", "-y", "-thread_queue_size", "512",
					"-f", "avfoundation", "-i", ":0",
					"-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", wavPath,
				],
				{ stdio: ["pipe", "ignore", "pipe"] },
			);

			const recording: ActiveRecording = {
				child,
				wavPath,
				mp3Path,
				tempDir,
				relativeMp3,
				stderr: "",
				closePromise: Promise.resolve({ code: null, signal: null }),
				timeout: setTimeout(() => {}, MAX_RECORDING_MS),
			};
			clearTimeout(recording.timeout);
			recording.timeout = setTimeout(() => {
				if (activeRecording !== recording) return;
				activeRecording = null;
				void finalizeRecording(recording)
					.then((result) => pi.sendUserMessage(`[[thai-speaking-practice-internal]]\n${result}`))
					.catch(async (error) => {
						await fs.rm(recording.tempDir, { recursive: true, force: true });
						pi.sendUserMessage(`Recording stopped at the safety limit, but processing failed: ${error instanceof Error ? error.message : String(error)}.`);
					});
			}, MAX_RECORDING_MS);
			recording.closePromise = new Promise((resolve) => {
				child.stderr?.on("data", (chunk: Buffer) => {
					recording.stderr = (recording.stderr + chunk.toString()).slice(-8000);
				});
				child.on("close", (code, signal) => {
					recording.closeInfo = { code, signal };
					resolve(recording.closeInfo);
				});
				child.on("error", (error) => {
					recording.stderr += String(error);
					recording.closeInfo = { code: null, signal: null };
					resolve(recording.closeInfo);
				});
			});
			activeRecording = recording;

			await new Promise((resolve) => setTimeout(resolve, 500));
			if (recording.closeInfo) {
				activeRecording = null;
				clearTimeout(recording.timeout);
				await fs.rm(tempDir, { recursive: true, force: true });
				throw new Error(`Could not start microphone recording. Check Terminal microphone permission. ${recording.stderr.trim()}`);
			}

			return {
				content: [{ type: "text", text: "Recording is live. Speak Thai now; send any text chat message to stop and get the transcript. That message is used only as the stop signal. The clip will be saved as an MP3 in the lesson vault." }],
				details: { ok: true, status: "recording", stopSignal: "any non-empty text chat message", autoStopSeconds: MAX_RECORDING_MS / 1000 },
				terminate: true,
			};
		},
	});

	pi.on("input", async (event) => {
		const recording = activeRecording;
		if (!recording || !event.text.trim()) return;
		activeRecording = null;
		try {
			const result = await finalizeRecording(recording);
			return {
				action: "transform",
				text: `[[thai-speaking-practice-internal]]\n${result}`,
			};
		} catch (error) {
			await fs.rm(recording.tempDir, { recursive: true, force: true });
			return {
				action: "transform",
				text: `The user stopped their Thai recording, but processing failed: ${error instanceof Error ? error.message : String(error)}. Explain the failure and offer to retry.`,
			};
		}
	});

	pi.on("session_shutdown", async () => {
		const recording = activeRecording;
		if (!recording) return;
		activeRecording = null;
		clearTimeout(recording.timeout);
		recording.child.kill("SIGINT");
		await recording.closePromise;
		await fs.rm(recording.tempDir, { recursive: true, force: true });
	});
}
