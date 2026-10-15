import { EventEmitter } from "events";
import { streamReply, type ChatMessage } from "./llm";
import { synthesizeSpeech } from "./openaiTts";
import { transcribeSpeech } from "./openaiStt";
import { convertWavToPcm16_8k, buildWavFromPcm16_8k, sendPaced } from "../utils/audio";
import { UtteranceDetector } from "../utils/vad";
import { SentenceSplitter } from "../utils/sentenceSplitter";
import { AsyncQueue } from "../utils/asyncQueue";
import type { AgentConfig } from "./agentConfig";

/** How the call session talks to whatever's actually carrying the audio (AudioSocket, a browser dashboard, or anything else later). */
export interface CallTransport {
  sendAudio: (pcmFrame: Buffer) => void;
  hangup: () => void;
}

interface AssistantTurn {
  abortController: AbortController;
}

/**
 * Owns the whole lifecycle of one phone call: the local voice-activity
 * detector + speech-to-text, the GPT conversation, and the
 * locally-synthesized speech currently being spoken. One instance per call.
 * Deliberately knows nothing about how audio actually reaches the caller -
 * that's the transport's job - so swapping the telephony layer later never
 * touches this file. Driven entirely by an AgentConfig (greeting, persona,
 * data fields to collect, voices) rather than hardcoded constants, so the
 * same code runs whichever agent a caller/tester is talking to.
 *
 * Emits telemetry events (transcript, assistant text, speaking state,
 * barge-in, collected data, errors) purely for observers like the test
 * dashboard or call logger - nothing in the call-handling logic depends on
 * anyone listening.
 */
export class CallSession extends EventEmitter {
  private utteranceDetector: UtteranceDetector;
  private history: ChatMessage[] = [];
  private currentTurn: AssistantTurn | null = null;
  private isAgentSpeaking = false;

  constructor(private readonly transport: CallTransport, private readonly agent: AgentConfig) {
    super();
    this.utteranceDetector = new UtteranceDetector(
      () => this.handleBargeIn(),
      (pcmAudio) => this.handleUtteranceAudio(pcmAudio)
    );
    this.speakGreeting();
  }

  /** Feed one 20ms PCM16 8kHz frame of caller audio in. */
  onAudioFrame(pcmFrame: Buffer): void {
    this.utteranceDetector.pushFrame(pcmFrame);
  }

  /** Transcribes a just-finished utterance locally and feeds it into the conversation. */
  private async handleUtteranceAudio(pcmAudio: Buffer): Promise<void> {
    try {
      const wavBuffer = buildWavFromPcm16_8k(pcmAudio);
      const { text, language } = await transcribeSpeech(wavBuffer);
      const trimmed = text.trim();
      if (!trimmed) return; // likely a VAD false trigger (noise burst) with nothing recognizable
      this.emit("transcript", { text: trimmed, language });
      this.handleUserUtterance(trimmed, language);
    } catch (err) {
      console.error("STT failed:", err);
      this.emit("error", { stage: "stt", error: err });
    }
  }

  private speakGreeting(): void {
    const greeting = this.agent.introLine;
    this.history.push({ role: "assistant", content: greeting });
    this.emit("assistant-text", { text: greeting });
    const abortController = new AbortController();
    this.currentTurn = { abortController };
    this.isAgentSpeaking = true;
    this.emit("speaking-started");

    (async () => {
      try {
        const wavBuffer = await synthesizeSpeech(greeting, this.agent);
        if (abortController.signal.aborted) return;
        const pcm = convertWavToPcm16_8k(wavBuffer);
        await sendPaced(pcm, (frame) => this.transport.sendAudio(frame), abortController.signal);
      } catch (err) {
        if (!abortController.signal.aborted) console.error("Greeting TTS failed:", err);
      }
    })().finally(() => this.onTurnDone(abortController));
  }

  private handleBargeIn(): void {
    if (!this.isAgentSpeaking || !this.currentTurn) return;
    this.currentTurn.abortController.abort();
    this.currentTurn = null;
    this.isAgentSpeaking = false;
    this.emit("barge-in");
  }

  private handleUserUtterance(text: string, language: "en" | "hi"): void {
    if (this.isAgentSpeaking) this.handleBargeIn();
    // Tag the turn with the detected language so the model reliably replies in
    // kind; the system prompt tells it to treat this as metadata, not text.
    this.history.push({ role: "user", content: `[lang: ${language}] ${text}` });
    this.runAssistantTurn();
  }

  /**
   * Runs a full assistant turn as a three-stage pipeline so nothing waits
   * on anything it doesn't have to:
   *   LLM tokens -> sentence chunks -> [synthesis] -> audio -> [playback]
   * Synthesis of sentence N+1 starts as soon as sentence N is done
   * synthesizing, while N is still being played out - that overlap is what
   * keeps gaps between sentences to a minimum on CPU-only TTS. Alongside
   * text, the LLM stream can also emit record_field tool calls (configured
   * data collection) - those are relayed as "collected-data" events as soon
   * as they arrive, independent of the text/audio pipeline.
   */
  private runAssistantTurn(): void {
    const abortController = new AbortController();
    const splitter = new SentenceSplitter();
    const sentenceQueue = new AsyncQueue<string>();
    const audioQueue = new AsyncQueue<Buffer>();
    let assistantText = "";

    this.currentTurn = { abortController };
    this.isAgentSpeaking = true;
    this.emit("speaking-started");

    const pipeline = Promise.all([
      this.runSynthesisStage(sentenceQueue, audioQueue, abortController.signal),
      this.runPlaybackStage(audioQueue, abortController.signal),
    ]);
    pipeline.finally(() => this.onTurnDone(abortController));

    (async () => {
      try {
        for await (const event of streamReply(this.history, this.agent, abortController.signal)) {
          if (event.type === "text") {
            assistantText += event.text;
            this.emit("assistant-text-delta", { delta: event.text });
            for (const chunk of splitter.push(event.text)) sentenceQueue.push(chunk);
          } else if (event.type === "tool_call" && event.call.name === "record_field") {
            const { field, value } = event.call.input as { field?: string; value?: string };
            if (field && value) this.emit("collected-data", { [field]: value });
          }
        }
        const rest = splitter.flush();
        if (rest) sentenceQueue.push(rest);
      } catch (err) {
        if (!abortController.signal.aborted) {
          console.error("Assistant turn failed:", err);
          this.emit("error", { stage: "llm", error: err });
        }
      } finally {
        sentenceQueue.close();
        if (assistantText.trim()) {
          const finalText = assistantText.trim();
          this.history.push({ role: "assistant", content: finalText });
          this.emit("assistant-text", { text: finalText });
        }
      }
    })();
  }

  /** Synthesizes queued sentences in order, one at a time, feeding finished audio onward immediately. */
  private async runSynthesisStage(
    sentenceQueue: AsyncQueue<string>,
    audioQueue: AsyncQueue<Buffer>,
    signal: AbortSignal
  ): Promise<void> {
    try {
      for await (const sentence of sentenceQueue) {
        if (signal.aborted) return;
        try {
          const wavBuffer = await synthesizeSpeech(sentence, this.agent);
          if (signal.aborted) return;
          audioQueue.push(convertWavToPcm16_8k(wavBuffer));
        } catch (err) {
          if (!signal.aborted) {
            console.error("TTS synthesis failed:", err);
            this.emit("error", { stage: "tts", error: err });
          }
        }
      }
    } finally {
      audioQueue.close();
    }
  }

  /** Plays synthesized audio in order, one clip at a time, real-time paced. */
  private async runPlaybackStage(audioQueue: AsyncQueue<Buffer>, signal: AbortSignal): Promise<void> {
    for await (const pcm of audioQueue) {
      if (signal.aborted) return;
      await sendPaced(pcm, (frame) => this.transport.sendAudio(frame), signal);
    }
  }

  private onTurnDone(abortController: AbortController): void {
    if (this.currentTurn?.abortController === abortController) {
      this.currentTurn = null;
      this.isAgentSpeaking = false;
      this.emit("speaking-stopped");
    }
  }

  cleanup(): void {
    this.currentTurn?.abortController.abort();
    this.currentTurn = null;
  }
}
