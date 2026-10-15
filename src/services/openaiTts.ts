import { config } from "../config";

const DEVANAGARI = /[ऀ-ॿ]/;

const VALID_VOICES = new Set(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);

/** Falls back to a default voice for any agent still carrying a pre-migration
 * Piper/MeloTTS voice id (e.g. "hi_IN-pratham-medium", "EN_INDIA") from
 * before this app switched to OpenAI's TTS -- those aren't valid OpenAI
 * voice names and would otherwise fail the request outright. */
function resolveVoice(voiceId: string, language: "en" | "hi"): string {
  if (VALID_VOICES.has(voiceId)) return voiceId;
  return language === "hi" ? "onyx" : "alloy";
}

/** Which language a chunk of text should be spoken in, decided purely from its own script. */
export function detectSpokenLanguage(text: string): "en" | "hi" {
  return DEVANAGARI.test(text) ? "hi" : "en";
}

export interface VoiceChoice {
  /** OpenAI TTS voice name used for Hindi text, e.g. "onyx". */
  voiceHi: string;
  /** OpenAI TTS voice name used for English text, e.g. "nova". */
  voiceEn: string;
}

// Delivery instructions per language -- only gpt-4o-mini-tts actually
// follows these (tts-1/tts-1-hd ignore any "instructions" field, so this
// is only sent for that model). Without this, tts-1's output is flat and
// has no inflection at all, which is the "robotic" sound.
const DELIVERY_INSTRUCTIONS: Record<"en" | "hi", string> = {
  en:
    process.env.OPENAI_TTS_INSTRUCTIONS_EN ??
    "Speak naturally with an Indian English accent, like a warm, friendly " +
      "call-center agent having a real conversation. Vary your pitch and " +
      "pacing the way a person actually talking does -- avoid a flat, " +
      "monotone, or robotic delivery.",
  hi:
    process.env.OPENAI_TTS_INSTRUCTIONS_HI ??
    "एक गर्मजोशी से भरे, मित्रवत कॉल-सेंटर एजेंट की तरह स्वाभाविक रूप से बोलें, " +
      "जैसे कोई असली बातचीत कर रहा हो। आवाज़ में उतार-चढ़ाव और स्वाभाविक गति रखें -- " +
      "सपाट, नीरस या यंत्रवत (robotic) अंदाज़ में बोलने से बचें।",
};

async function callSynthesize(text: string, voice: string, language: "en" | "hi"): Promise<Buffer> {
  const body: Record<string, unknown> = {
    model: config.openai.ttsModel,
    voice,
    input: text,
    response_format: "wav",
  };
  if (config.openai.ttsModel === "gpt-4o-mini-tts") {
    body.instructions = DELIVERY_INSTRUCTIONS[language];
  }

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`OpenAI TTS error ${res.status}: ${await res.text()}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Synthesizes speech via OpenAI's hosted TTS API (replaces the formerly
 * self-hosted Piper/MeloTTS pipeline in tts-service/ -- see git history if
 * you ever want to go back to fully self-hosted speech). The same model
 * speaks both languages; which named voice is used per language is still
 * per-agent (see the voice catalog in voices.ts), matching the old
 * Piper-for-Hindi / MeloTTS-for-English split in spirit even though OpenAI
 * doesn't actually require different voices per language.
 */
export async function synthesizeSpeech(text: string, voices: VoiceChoice): Promise<Buffer> {
  const language = detectSpokenLanguage(text);
  const voice = resolveVoice(language === "hi" ? voices.voiceHi : voices.voiceEn, language);
  return callSynthesize(text, voice, language);
}

/** Synthesizes with a specific voice explicitly - used by the voice-picker preview, not auto-detected. */
export async function synthesizeWithVoice(text: string, language: "en" | "hi", voiceId: string): Promise<Buffer> {
  return callSynthesize(text, resolveVoice(voiceId, language), language);
}
