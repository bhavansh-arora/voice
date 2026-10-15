import "dotenv/config";
import path from "path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");

export const config = {
  // HTTP health-check + admin API server. Binds to localhost only by
  // default - put a reverse proxy (nginx/caddy) in front for TLS and a
  // real domain, same pattern as AUDIOSOCKET_HOST below. Only widen HOST
  // if you specifically need the Node process reachable without a proxy.
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST || "127.0.0.1",

  // Asterisk's AudioSocket() dialplan application connects here. No cloud
  // telephony API/account is involved - whatever SIP trunk you point
  // Asterisk at is entirely swappable without touching this app. The
  // protocol has no auth, so this only binds beyond localhost if you
  // explicitly widen it - see audioSocketServer.ts.
  audioSocketPort: Number(process.env.AUDIOSOCKET_PORT ?? 8090),
  audioSocketHost: process.env.AUDIOSOCKET_HOST || "127.0.0.1",

  openai: {
    apiKey: required("OPENAI_API_KEY"),
    // gpt-4o-mini by default - fast and cheap, which matters for a live
    // voice call. Swap to a different OpenAI model via OPENAI_MODEL if you
    // want more quality at the cost of latency.
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    // Speech (STT + TTS) also runs through OpenAI's API by default -- see
    // src/services/openaiTts.ts / openaiStt.ts. This replaced the
    // originally self-hosted Piper/MeloTTS/Whisper pipeline in
    // tts-service/ (still in the repo, unused by default) after that
    // pipeline's memory footprint (1GB+) proved too large to share a small
    // VPS with other sites.
    ttsModel: process.env.OPENAI_TTS_MODEL ?? "tts-1",
    sttModel: process.env.OPENAI_STT_MODEL ?? "whisper-1",
  },

  // Only relevant if you switch back to the self-hosted tts-service/
  // pipeline (src/services/localTts.ts, localStt.ts) -- unused by default.
  localSpeechServiceUrl: process.env.LOCAL_SPEECH_SERVICE_URL ?? "http://127.0.0.1:8001",

  // Shared secret guarding every admin surface: the /dashboard WebSocket,
  // the setup chatbot, voice previews, call logs/recordings, and telephony
  // config - all of it can run real billed conversations or expose call
  // transcripts, so all of it sits behind the same gate. Required reading
  // if this server is reachable from anywhere beyond localhost - see README.
  adminToken: process.env.ADMIN_TOKEN || null,

  // Where the SQLite database and call recordings live on disk.
  dbPath: process.env.DB_PATH || path.join(dataDir, "voice-agent.sqlite3"),
  recordingsDir: process.env.RECORDINGS_DIR || path.join(dataDir, "recordings"),
};
