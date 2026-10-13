# Local Speech Service

A small FastAPI service that does **all speech processing locally, on your
own machine** - no ElevenLabs, no Deepgram, no cloud speech API of any
kind. The Node voice agent calls it over plain HTTP on localhost (or
wherever you run it on your own network).

**Text-to-speech:**
- **Hindi** text is spoken by [Piper](https://github.com/OHF-Voice/piper1-gpl)
  using a native Hindi voice.
- **English** text is spoken by [MeloTTS](https://github.com/myshell-ai/MeloTTS)'s
  `EN_INDIA` speaker - English synthesized with an Indian accent.

`src/services/localTts.ts` on the Node side decides which language a given
sentence is in (checking for Devanagari script) and calls this service with
`{"text": "...", "language": "en" | "hi"}`, getting back a WAV file.

**Speech-to-text:**
- Caller audio is transcribed by a self-hosted [Whisper](https://github.com/SYSTRAN/faster-whisper)
  model (via `faster-whisper`), which handles both English and Hindi and
  reports which one it detected.

Node buffers and segments caller audio itself (`src/utils/vad.ts` - a
simple energy-based voice-activity detector that replaced Deepgram's
hosted one) and, once an utterance finishes, sends the whole clip as WAV
bytes to `POST /transcribe` (`src/services/localStt.ts`), getting back
`{"text": "...", "language": "en" | "hi"}`.

## Setup

First, some system packages the Python deps below need to build (Debian/Ubuntu):

```bash
sudo apt-get install -y build-essential mecab libmecab-dev mecab-ipadic-utf8
```

`mecab`/`libmecab-dev` are needed by `fugashi` (a MeloTTS dependency for
Japanese tokenization, even though this project only uses English/Hindi).

**Use Python 3.11 for this venv specifically, not whatever `python3` is
on a newer OS.** MeloTTS pins `transformers==4.27.4`, which caps
`tokenizers<0.14`, and the newest version in that range (`0.13.3`) has no
prebuilt wheel for Python 3.12+ on PyPI at all (confirmed directly - its
last wheel builds stop at cp311). On Python 3.12+, pip falls back to
compiling `tokenizers` from source, which hits a dead end: it needs a
newer Rust toolchain for one of its own dependencies (`clap_lex` requires
the `edition2024` cargo feature), but its *own* source code then fails to
compile on that same newer Rust (stricter lifetime checks than existed
when it was published in 2023) - there's no single Rust version that
satisfies both sides. Sidestep all of it with a Python 3.11 venv instead,
via [uv](https://docs.astral.sh/uv/) (installs a portable Python build,
independent of your OS's package repos):

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
source "$HOME/.local/bin/env" 2>/dev/null || export PATH="$HOME/.local/bin:$PATH"
uv python install 3.11
```

```bash
cd tts-service
"$(uv python find 3.11)" -m venv .venv
source .venv/bin/activate

pip install -r requirements.txt

# CPU-only torch + torchaudio - installing these first means MeloTTS's
# own install (which depends on both) finds them already satisfied and
# skips the default PyPI wheels, which pull in CUDA libraries you don't
# need for an all-CPU setup (torchaudio's compiled extension specifically
# links against libcudart.so and fails to even import without it).
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu

# MeloTTS isn't on a requirements-friendly index; install from source and
# run its one-time data download.
pip install git+https://github.com/myshell-ai/MeloTTS.git
python -m unidic download
```

### Download the Hindi voice models

Piper voice models aren't bundled here (they're binary assets). The admin
UI's Voices page lets you preview and pick between both of Piper's Hindi
voices per agent - `pratham` (male) and `priyamvada` (female), both medium
quality - so download both into `models/` (named `{voice_id}.onnx` -
`PIPER_MODELS_DIR`, default `models/`):

```bash
mkdir -p models
for voice in pratham priyamvada; do
  curl -L -o "models/hi_IN-${voice}-medium.onnx" \
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/hi/hi_IN/${voice}/medium/hi_IN-${voice}-medium.onnx"
  curl -L -o "models/hi_IN-${voice}-medium.onnx.json" \
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/hi/hi_IN/${voice}/medium/hi_IN-${voice}-medium.onnx.json"
done
```

Voices are loaded lazily and cached in memory the first time each one is
used, so it's fine to have both installed even if a given agent only ever
uses one.

MeloTTS and the Whisper model (via `faster-whisper`) both download their
own checkpoints automatically (via Hugging Face) the first time the
service starts.

## Running

```bash
uvicorn server:app --host 127.0.0.1 --port 8001
```

Leave this running alongside `npm run dev` in the main project - the Node
server expects it at `LOCAL_SPEECH_SERVICE_URL` (default `http://127.0.0.1:8001`).

First startup will be slow (loading three models); after that, requests
are fast since everything stays warm in memory.

## Compute

All three models run on CPU. Piper is fast enough for real-time Hindi
synthesis; MeloTTS and Whisper are heavier and will noticeably lag a cloud
API's latency on CPU alone, especially the STT round trip (buffer the
utterance → send it → wait for Whisper to run). A GPU isn't required, but
if you have one, set `MELO_DEVICE=cuda` and `WHISPER_DEVICE=cuda` - both
drop render/transcribe time sharply with no quality loss.

`WHISPER_MODEL_SIZE` (default `small`) trades accuracy for speed: `base`
is faster but noticeably worse on Hindi; `medium` is more accurate but
slower on CPU. `WHISPER_COMPUTE_TYPE` defaults to `int8`, which is
meaningfully faster on CPU than `float32` for a small accuracy cost.

## Licensing note

Piper's actively-developed fork is GPL-3.0. That only matters if you ever
*redistribute* this service (or a product built on it) to others - running
it privately as your own backend, as this project does, isn't a
distribution event under GPL, so there's nothing to do here. If you do plan
to ship this service itself to customers, get your own legal read on that
first. MeloTTS and faster-whisper are both MIT-licensed.
