# Voice Agent

A phone-based conversational agent that answers real phone calls and talks
back like a person, not a script-reading bot. It's bilingual: callers can
speak English or Hindi and switch between them mid-call, and the agent
answers in kind, in an Indian-accented voice. Speech processing (hearing
the caller, speaking back) is fully self-hosted, and telephony has no
cloud API or vendor lock-in either — you run your own PBX and can plug in
whichever SIP trunk provider you like.

It's built from independent pieces wired together over a phone call, rather
than one bundled "speech-to-speech" API:

- **Telephony:** [Asterisk](https://www.asterisk.org) (free, self-hosted,
  open-source PBX) answers the call and bridges its audio to this app over
  [AudioSocket](https://docs.asterisk.org/Configuration/Channel-Drivers/AudioSocket/) —
  a small binary protocol Asterisk speaks natively, purpose-built for
  exactly this "hand call audio to a custom app" use case. Whatever SIP
  trunk actually terminates the call (any provider — that part of getting
  an Indian number is unavoidably regulated, see below) is Asterisk's
  problem; this app never talks to a telephony vendor's API directly, so
  the provider is swappable with a one-line dialplan/trunk config change.
- **Speech-to-text:** fully self-hosted, no cloud STT API at all. A local
  voice-activity detector (`src/utils/vad.ts`) buffers and segments the
  caller's audio itself, and each finished utterance is transcribed by a
  self-hosted [Whisper](https://github.com/SYSTRAN/faster-whisper) model
  (via `faster-whisper`) running in `tts-service/`, which also reports
  whether it heard English or Hindi.
- **Conversation:** [OpenAI's GPT](https://platform.openai.com) generates
  replies with a system prompt tuned for spoken, human-sounding dialogue in
  either language — short turns, contractions, no lists or markdown,
  natural acknowledgements — and always answers in whichever language the
  caller just used.
- **Text-to-speech:** also fully self-hosted. The same local service runs
  two more open-source models in-process: [Piper](https://github.com/OHF-Voice/piper1-gpl)
  for Hindi (a native Hindi voice), and [MeloTTS](https://github.com/myshell-ai/MeloTTS)'s
  `EN_INDIA` speaker for English (English spoken with an Indian accent).
  The Node server picks which one to call per sentence just by checking
  whether that sentence contains Devanagari script.

Text streams from GPT straight into TTS sentence-by-sentence (instead of
waiting for the full reply), and the agent supports **barge-in**: if the
caller starts talking while the agent is still speaking, playback stops
immediately and the agent listens, the way a real conversation works.

## How a call flows

1. A call comes in on whichever number/SIP trunk you've pointed at
   Asterisk. Asterisk's dialplan answers it and hands the call to its
   `AudioSocket()` application, which opens a plain TCP connection to this
   app (`src/services/audioSocketServer.ts`).
2. Inbound audio frames (raw 16-bit PCM, 8kHz, mono - AudioSocket's native
   format) are fed frame-by-frame into the local voice-activity detector,
   which buffers audio while the caller is talking and fires once a
   sustained pause follows it.
3. That buffered utterance is sent to the local Whisper model to transcribe.
   The resulting text, tagged with its detected language, is sent to GPT
   as the next turn in the conversation.
4. As GPT streams its reply, completed sentences are sent to the local
   `tts-service` (Piper for Hindi sentences, MeloTTS for English ones),
   resampled to 8kHz in-process (no subprocess per sentence), and played
   out in real-time-paced 20ms frames. Synthesis of the next sentence
   starts as soon as the current one finishes rendering — it doesn't wait
   for the current one to finish *playing* — so there's minimal dead air
   between sentences.
5. If the voice-activity detector notices the caller speaking again before
   the agent finishes, the in-flight turn is aborted mid-playback
   immediately — the agent yields the floor.

### On latency

Everything above is tuned to minimize latency within a CPU-only, fully
self-hosted setup, but there's a real ceiling, and it's worth being honest
about where it is:

- **Text-to-speech:** Piper (Hindi) is fast enough for real-time synthesis
  on CPU alone. MeloTTS (English) is heavier and takes noticeably longer
  per sentence on CPU than a cloud TTS API would. The pipelining in step 4
  hides most of that *between* sentences, but the first sentence of a
  reply still has to actually finish rendering before anything plays —
  there's no way around that on CPU.
- **Speech-to-text:** this is where self-hosting costs the most latency.
  A cloud streaming ASR service (like Deepgram, which this project used
  before) is often producing a transcript incrementally, as the caller
  talks — by the time they finish a sentence, most of the transcription
  work is already done. Our local setup instead has to wait for the
  voice-activity detector's silence hangover (default 700ms, tunable via
  `VAD_SILENCE_HANGOVER_MS`) and *then* run the whole utterance through
  Whisper in one go. That's real, additional, sequential latency that a
  streaming cloud STT doesn't have. It also means the simple energy-based
  VAD needs `VAD_ENERGY_THRESHOLD` tuned to your actual phone line/mic
  noise floor — too low and background noise triggers false utterances,
  too high and quiet speech gets missed.

If responsiveness isn't good enough, the biggest lever for both is a GPU:
set `MELO_DEVICE=cuda` and `WHISPER_DEVICE=cuda` in `tts-service` and both
render/transcribe times drop sharply with no quality loss.

## Setup

You're running three things: the Node voice-agent server, the Python
speech microservice, and your own Asterisk instance.

### 1. The app

1. `npm install`
2. Set up `tts-service/` per its own [README](tts-service/README.md) —
   Python venv, Piper + MeloTTS + faster-whisper install, downloading the
   Hindi voice model — then leave it running:
   `uvicorn server:app --host 127.0.0.1 --port 8001`
3. Copy `.env.example` to `.env` and fill in your **OpenAI** API key.
   The defaults for everything else are fine for local dev.
4. `npm run dev`. You'll see it listening for AudioSocket connections on
   port 8090 (configurable via `AUDIOSOCKET_PORT`).

### 2. Asterisk

Install Asterisk ([asterisk.org](https://www.asterisk.org) has packages
for most Linux distros) on the same machine or network as this app. Two
pieces of config:

**A SIP trunk** to whichever provider gives you a number — this is the one
piece that's genuinely unavoidable to outsource: only a licensed telecom
carrier can hand you a real, dial-able number and terminate calls from
India's phone network (that's regulation, not a limitation of any
provider). Get SIP trunk credentials from your provider of choice and
register them in `pjsip.conf` — the exact config is provider-specific, so
follow their SIP trunking docs. The point of routing through Asterisk is
that this is the *only* place provider-specific config lives — swapping
providers later means changing this file, not this app.

**The dialplan** (`extensions.conf`) that answers the call and hands it to
this app:

```ini
[from-trunk]
exten => YOUR_NUMBER,1,Answer()
 same => n,AudioSocket(11111111-1111-1111-1111-111111111111,127.0.0.1:8090)
 same => n,Hangup()
```

The UUID is arbitrary (any valid UUID string) - it's just an identifier
Asterisk sends us for this call, not something you need to register
anywhere. Point `127.0.0.1:8090` at wherever this app's `AUDIOSOCKET_PORT`
is actually reachable from Asterisk.

### 3. Call it

Dial the number. The agent should greet you and take it from there — try
speaking in Hindi partway through the call and it should switch.

## The admin UI

Everything below lives behind one Express server (`src/server.ts`) and a
no-build-step static frontend in `public/`. Open
**`http://localhost:3000/`** (locally; add `?token=<ADMIN_TOKEN>` once on a
VPS, see below) and it walks you through:

- **Home** (`index.html`) — your list of agents. Each one is an
  independent configuration (intro line, data to collect, voices,
  telephony trunk) plus its own call history; you can run several side by
  side (e.g. one per client/business). Create one here, then everything
  else acts on whichever agent you select.
- **Setup** (`setup.html`) — a chat with GPT that *trains* the selected
  agent instead of you filling out a form. Describe your business in plain
  language ("say 'Thanks for calling Acme Dental' and collect the caller's
  name and preferred day") and it extracts the opening line, how the agent
  should introduce/describe itself, and the list of fields to collect —
  via OpenAI tool-calling (`src/services/setupChat.ts`'s `update_agent_config`
  tool), not regex/keyword matching — saving each piece as soon as it's
  confident, so you can see the config fill in live in the panel beside
  the chat. An agent starts as `draft`; flip it to `active` once you're
  happy, and the dashboard/telephony fall back to whichever agent is
  `active` (or the newest one) when no agent is explicitly specified.
- **Voices** (`voices.html`) — every available voice (two Piper Hindi
  voices, five MeloTTS English accents) with a one-click preview
  (synthesizes a sample sentence on the spot) and a button to make it this
  agent's Hindi or English voice.
- **Telephony** (`telephony.html`) — the Plivo-specific "interface"
  mentioned above: enter your trunk's Auth ID/Token, phone number, and
  Termination SIP domain (copy that one from the Plivo Console - it's
  account-specific) and it generates the exact `pjsip.conf`/`extensions.conf`
  blocks to paste into Asterisk (`src/services/telephony.ts`). This app
  still never talks to Plivo's API directly - it only turns your trunk's
  details into Asterisk config, the same config you'd otherwise hand-write
  following Plivo's docs. The vendor type is a discriminated union
  (`TelephonyVendorConfig`), so adding a second vendor later is one more
  union variant and one more generator function, not a rewrite.
- **Calls** (`calls.html`) — every call the selected agent has taken (from
  the dashboard or a real phone line), with its full transcript, whatever
  data got collected, and a playable recording. Recording and logging are
  automatic and on by default for every call — see below.
- **Test** (`dashboard.html`) — see the next section. The agent picker at
  the top lets you test any agent, not just the active one.

All of it (every `/api/*` route and the `/dashboard` WebSocket) is gated by
a single `ADMIN_TOKEN` - see "Deploying to a VPS" below for how that token
gets to the browser.

### Call recording and data collection

Every call — dashboard or real phone — is logged from the moment it starts
(`src/db/`, a local SQLite file at `DB_PATH`, default `./data/voice-agent.sqlite3`):
the full transcript turn-by-turn, whatever structured data the agent pulled
out of the conversation, and a mixed recording of both sides of the audio
(`src/services/callRecorder.ts` — caller and agent frames are mixed at
their actual wall-clock offsets, so overlapping speech from a barge-in
sums correctly rather than getting concatenated out of order), saved as a
WAV file under `RECORDINGS_DIR` (default `./data/recordings/`) and playable
from the Calls page.

Data collection uses the same data fields you train in Setup: the
caller-facing agent has its own OpenAI tool (`record_field`, built per-agent
from its configured `dataFields`) that it calls as soon as it has heard a
piece of data worth saving, live during the call — not a post-call
re-read of the transcript.

## Testing without a phone: the dashboard

You don't need Asterisk, a SIP trunk, or any phone at all to iterate on
conversation quality. With just `npm run dev` and `tts-service` running,
open **`http://localhost:3000/dashboard.html`**, pick an agent, and click
"Start conversation." It talks to the exact same `CallSession` logic a
real call uses — same VAD, same Whisper, same GPT prompt and config,
same Piper/MeloTTS, same recording/logging — over your computer's
mic/speakers instead of a phone line.

Audio is downsampled to 8kHz in *both* directions before it ever reaches
the AI pipeline or your speakers, matching a real phone line's bandwidth
exactly — so what you hear here is a genuine preview of call quality, not
cleaned-up browser audio. The page also shows a live transcript, the
detected language per turn, and the time from "caller finished speaking"
to "first audio of the reply," so you can actually see where latency goes
as you tune things like `VAD_SILENCE_HANGOVER_MS`, the system prompt, or
the TTS voices.

This is a separate transport (`src/services/dashboardServer.ts`, a plain
WebSocket) sitting next to AudioSocket — `CallSession` itself doesn't know
or care which one is driving it, and both get recorded/logged identically.

## Deploying to a VPS

1. Clone this repo onto the VPS, then run `bash deploy/setup.sh` from the
   repo root - optionally passing a domain that already has an A record
   pointing at this VPS's IP, e.g. `bash deploy/setup.sh voice.example.com`.
   On a fresh Ubuntu/Debian box this installs Node, Python, all
   dependencies, downloads both Hindi voice models, generates `.env` (with
   a random `ADMIN_TOKEN` already filled in), installs two systemd
   services (`voice-agent`, `voice-speech`) so both halves run persistently
   and restart on failure or reboot, and - only if you passed a domain -
   installs nginx as a reverse proxy in front of the app and gets it a
   free TLS certificate via Let's Encrypt/certbot.
2. Edit `.env` and set `OPENAI_API_KEY`.
3. `sudo systemctl enable --now voice-speech` then
   `sudo systemctl enable --now voice-agent`. Check status/logs with
   `systemctl status voice-agent` / `journalctl -u voice-agent -f`.
4. Asterisk, if/when you're ready for real phone calls, is a separate
   install - see the Asterisk section above. It isn't needed to reach the
   admin UI/dashboard.

**Reaching the admin UI safely - read this before opening any port.**
The app itself binds to `127.0.0.1` only (`HOST` in `.env`, same pattern as
`AUDIOSOCKET_HOST`) - it is never directly reachable from the internet.
Two ways to actually reach it:

- **With a domain (recommended, and the only way to use the Test
  dashboard's microphone from a browser other than on the VPS itself)** -
  pass the domain to `setup.sh` as above. It writes an nginx config from
  `deploy/nginx.conf.template` (proxying the domain to the app, with the
  WebSocket upgrade headers `/dashboard` needs) and runs certbot, which
  gets a cert and rewrites that config to redirect HTTP to HTTPS. Browsers
  only allow microphone access (`getUserMedia`) over HTTPS or `localhost` -
  a bare `http://<ip>:3000` can't use the mic at all, which is why this
  matters beyond just security. Once that's done, open
  `https://<your-domain>/?token=<the ADMIN_TOKEN from .env>` once; the
  frontend (`public/app.js`) reads the token from that URL, stores it for
  the rest of the browser session, strips it back out of the visible URL,
  and carries it to every admin page (`index.html`, `dashboard.html`,
  etc.) you navigate to from there. If you add the domain later, re-run
  `bash deploy/setup.sh <domain>` - it's safe to re-run.
- **Without a domain** - an SSH tunnel: `ssh -L 3000:localhost:3000
  you@your-vps`, then open `http://localhost:3000/?token=...` on your own
  machine. This also satisfies the HTTPS-or-localhost rule above since the
  browser sees it as `localhost`, but it only works from the machine
  running the tunnel.
- `AUDIOSOCKET_PORT` (8090) has no authentication in its protocol at all
  and binds to `127.0.0.1` by default - never open this to the public
  internet. Only widen `AUDIOSOCKET_HOST` if Asterisk runs on a different
  machine, and firewall that port to Asterisk's IP specifically if you do.

## Notes / next steps

- OpenAI (the LLM) is the only paid cloud API left. Telephony,
  speech-to-text, and text-to-speech are all fully self-hosted, and the
  SIP trunk provider is swappable without touching any code or redeploying
  — it's a per-agent config value filled in on the Telephony page.
- Multiple agents, each with their own config/voices/trunk/call history,
  can run side by side (useful per-client or for A/B-ing a prompt) - the
  `agentId` just follows you across pages via `AgentContext` in
  `public/app.js` (backed by `localStorage`), and the dashboard/AudioSocket
  fall back to the newest `active` agent (`getDefaultAgent()` in
  `src/db/agents.ts`) when none is specified.
- The telephony layer is deliberately vendor-agnostic even though only
  Plivo is wired up today: `TelephonyVendorConfig` in
  `src/services/agentConfig.ts` is a discriminated union on `vendor`, and
  `generateAsteriskConfig()` in `src/services/telephony.ts` switches on it.
  Adding a second vendor is one more union variant and one more generator
  function - nothing about call handling, recording, or the rest of the
  admin UI needs to change.
- To change an agent's personality/tone beyond what the setup chatbot
  covers, edit `BASE_PROMPT` in `src/services/llm.ts` (applies to every
  agent). Per-agent voice choice lives in the Voices page, not code.
- `tts-service` has its own licensing note (Piper's current release line is
  GPL-3.0) — see its README.
- Outbound calling (agent calls someone) isn't wired up yet — it'd be a
  short addition to the dialplan/Asterisk originate side, not this app.
