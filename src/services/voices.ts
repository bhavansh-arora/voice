export interface VoiceOption {
  /** OpenAI TTS voice name, e.g. "onyx" -- passed straight through as the "voice" parameter. */
  id: string;
  language: "en" | "hi";
  engine: "openai";
  label: string;
  accent: string;
}

/**
 * Every voice this app can speak with. All of these are OpenAI TTS voices
 * (see src/services/openaiTts.ts) -- the same voice can technically speak
 * either language, so this split into two language groups is just for a
 * sensible admin-picker UI, not a real capability limit the way Piper vs.
 * MeloTTS used to be.
 */
export const VOICE_CATALOG: VoiceOption[] = [
  { id: "onyx", language: "hi", engine: "openai", label: "Onyx", accent: "Deep, authoritative" },
  { id: "shimmer", language: "hi", engine: "openai", label: "Shimmer", accent: "Soft, gentle" },
  { id: "echo", language: "hi", engine: "openai", label: "Echo", accent: "Clear, direct" },
  { id: "alloy", language: "en", engine: "openai", label: "Alloy", accent: "Balanced, neutral" },
  { id: "nova", language: "en", engine: "openai", label: "Nova", accent: "Warm" },
  { id: "fable", language: "en", engine: "openai", label: "Fable", accent: "Expressive" },
];

const SAMPLE_TEXT: Record<"en" | "hi", string> = {
  en: "Hey, thanks for calling! What can I help you with today?",
  hi: "नमस्ते, कॉल करने के लिए धन्यवाद! मैं आपकी कैसे मदद कर सकता हूँ?",
};

export function getVoice(id: string): VoiceOption | undefined {
  return VOICE_CATALOG.find((v) => v.id === id);
}

export function sampleTextFor(language: "en" | "hi"): string {
  return SAMPLE_TEXT[language];
}
