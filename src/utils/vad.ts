import { pcm16FrameEnergy } from "./audio";

const FRAME_MS = 20; // matches AudioSocket's frame size (320 bytes @ 8kHz, 16-bit mono)
const SPEECH_START_FRAMES = 2; // ~40ms of sustained energy before starting to buffer (avoids clipping the first word)
const PRE_ROLL_FRAMES = 5; // ~100ms of audio kept from just before speech is confirmed, so onsets aren't clipped
const SILENCE_HANGOVER_MS = Number(process.env.VAD_SILENCE_HANGOVER_MS ?? 700);
const SILENCE_HANGOVER_FRAMES = Math.round(SILENCE_HANGOVER_MS / FRAME_MS);
const MAX_UTTERANCE_MS = 30_000; // hard cap so a stuck-open line can't buffer forever
const ENERGY_THRESHOLD = Number(process.env.VAD_ENERGY_THRESHOLD ?? 500);
// How long energy has to stay up before `onSpeechStarted` actually fires -
// deliberately much longer than SPEECH_START_FRAMES above. Buffering starts
// immediately (so a real utterance's first word is never clipped), but the
// *notification* callers use to decide "the caller is genuinely talking"
// (chiefly: should this interrupt the agent?) is held back until the energy
// has been sustained this long. A click, pop, breath, or echo residue from
// the agent's own TTS leaking back into the mic is almost always shorter
// than this; real speech almost never is. Without this, barge-in was firing
// off 40ms blips - see the "interrupted" spam reported against the Test page.
const SPEECH_CONFIRM_MS = Number(process.env.VAD_SPEECH_CONFIRM_MS ?? 250);
const SPEECH_CONFIRM_FRAMES = Math.round(SPEECH_CONFIRM_MS / FRAME_MS);

/**
 * A simple energy-based voice-activity detector, replacing what Deepgram's
 * hosted VAD used to do. Fed one 20ms PCM16 frame at a time; buffers audio
 * while the caller is talking and fires `onUtteranceEnded` with the whole
 * utterance once a sustained pause follows it.
 *
 * This is deliberately simple (no ML model, no new dependency) - telephone
 * audio quality varies a lot by line and handset, so `VAD_ENERGY_THRESHOLD`
 * is very likely to need tuning per deployment; see the README.
 */
export class UtteranceDetector {
  private state: "silence" | "speech" = "silence";
  private speechFrameStreak = 0;
  private silenceFrameStreak = 0;
  private frames: Buffer[] = [];
  private frameCount = 0;
  private preRoll: Buffer[] = [];
  private speechConfirmed = false;
  private loudFrameStreak = 0;

  constructor(
    private readonly onSpeechStarted: () => void,
    private readonly onUtteranceEnded: (pcm: Buffer) => void
  ) {}

  pushFrame(frame: Buffer): void {
    const isLoud = pcm16FrameEnergy(frame) > ENERGY_THRESHOLD;

    if (this.state === "silence") {
      this.preRoll.push(frame);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();

      if (isLoud) {
        this.speechFrameStreak++;
        if (this.speechFrameStreak >= SPEECH_START_FRAMES) {
          this.beginUtterance();
        }
      } else {
        this.speechFrameStreak = 0;
      }
      return;
    }

    // state === "speech"
    this.frames.push(frame);
    this.frameCount++;
    this.silenceFrameStreak = isLoud ? 0 : this.silenceFrameStreak + 1;
    // A leaky counter, not a strict consecutive-frame streak: +1 per loud
    // frame, -1 per quiet one (floored at 0, capped at the threshold).
    // Sustained real speech climbs to the threshold even through the brief
    // single-frame dips normal speech has (stops, syllable gaps); a one-off
    // blip (a click, a pop, echo residue) climbs a little and immediately
    // decays back down instead of ever getting close.
    this.loudFrameStreak = isLoud
      ? Math.min(this.loudFrameStreak + 1, SPEECH_CONFIRM_FRAMES)
      : Math.max(this.loudFrameStreak - 1, 0);

    if (!this.speechConfirmed && this.loudFrameStreak >= SPEECH_CONFIRM_FRAMES) {
      this.speechConfirmed = true;
      this.onSpeechStarted();
    }

    const finishedBySilence = this.silenceFrameStreak >= SILENCE_HANGOVER_FRAMES;
    const finishedByMaxDuration = this.frameCount * FRAME_MS >= MAX_UTTERANCE_MS;

    if (finishedBySilence || finishedByMaxDuration) {
      this.endUtterance();
    }
  }

  /** Call when the call ends, in case an utterance was left mid-buffer. */
  reset(): void {
    this.state = "silence";
    this.speechFrameStreak = 0;
    this.silenceFrameStreak = 0;
    this.frames = [];
    this.frameCount = 0;
    this.preRoll = [];
    this.speechConfirmed = false;
    this.loudFrameStreak = 0;
  }

  private beginUtterance(): void {
    this.state = "speech";
    this.speechFrameStreak = 0;
    this.silenceFrameStreak = 0;
    this.frames = [...this.preRoll];
    this.frameCount = this.frames.length;
    this.preRoll = [];
    this.speechConfirmed = false;
    this.loudFrameStreak = 0;
  }

  private endUtterance(): void {
    const audio = Buffer.concat(this.frames);
    this.state = "silence";
    this.frames = [];
    this.frameCount = 0;
    this.silenceFrameStreak = 0;
    this.speechConfirmed = false;
    this.loudFrameStreak = 0;
    this.onUtteranceEnded(audio);
  }
}
