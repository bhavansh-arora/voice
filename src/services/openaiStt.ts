import { config } from "../config";

export interface TranscriptionResult {
  text: string;
  language: "en" | "hi";
}

/**
 * Sends a buffered utterance (WAV) to OpenAI's hosted transcription API
 * (replaces the formerly self-hosted faster-whisper model in
 * tts-service/ -- see git history if you ever want to go back to fully
 * self-hosted speech). verbose_json gets us the detected language back
 * in the same response as the transcript.
 */
export async function transcribeSpeech(wavBuffer: Buffer): Promise<TranscriptionResult> {
  const form = new FormData();
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");
  form.append("model", config.openai.sttModel);
  form.append("response_format", "verbose_json");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openai.apiKey}` },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`OpenAI transcription error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { text: string; language?: string };
  const language = (data.language ?? "").toLowerCase().startsWith("hin") ? "hi" : "en";
  return { text: data.text, language };
}
