import type { Server as HttpServer } from "http";
import { WebSocketServer, type WebSocket } from "ws";
import { CallSession, type CallTransport } from "./callSession";
import { getAgent, getDefaultAgent } from "../db/agents";
import { startCall, appendTranscriptTurn, mergeCollectedData, endCall } from "../db/calls";
import { CallRecorder } from "./callRecorder";
import { isAuthorizedUpgradeRequest } from "./adminAuth";

/**
 * The browser testing dashboard talks the simplest possible protocol over
 * one WebSocket connection: binary messages are raw 20ms PCM16 8kHz mono
 * audio frames (same format AudioSocket uses for real calls - nothing is
 * upsampled or cleaned up, so what you hear is exactly the bandwidth a real
 * caller's audio would have). Text messages are JSON telemetry events
 * relayed straight from CallSession, for the live transcript/status view.
 *
 * This WebSocket can run a real, billed conversation (OpenAI + the local
 * speech services), so it's gated by the same admin session as the rest
 * of the admin surface - see adminAuth.ts. The browser WebSocket API
 * can't set custom headers, but it does send cookies on same-origin
 * connections, so the signed-in session cookie covers this automatically.
 */
export function attachDashboardServer(httpServer: HttpServer, path = "/dashboard"): WebSocketServer {
  const wss = new WebSocketServer({
    server: httpServer,
    path,
    verifyClient: ({ req }, done) => {
      done(isAuthorizedUpgradeRequest(req));
    },
  });

  wss.on("connection", (ws: WebSocket, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const agentId = url.searchParams.get("agentId");
    const agent = (agentId && getAgent(agentId)) || getDefaultAgent();
    const callId = startCall(agent.id, "dashboard");
    const recorder = new CallRecorder();

    const transport: CallTransport = {
      sendAudio: (frame) => {
        recorder.addAgentFrame(frame);
        if (ws.readyState === ws.OPEN) ws.send(frame);
      },
      hangup: () => ws.close(),
    };

    const session = new CallSession(transport, agent);

    const forward = (type: string) => (payload?: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...(payload as object) }));
    };
    session.on("transcript", (payload: { text: string; language: "en" | "hi" }) => {
      appendTranscriptTurn(callId, { role: "user", text: payload.text, language: payload.language });
      forward("transcript")(payload);
    });
    session.on("assistant-text", (payload: { text: string }) => {
      appendTranscriptTurn(callId, { role: "assistant", text: payload.text });
      forward("assistant-text")(payload);
    });
    session.on("collected-data", (payload: Record<string, string>) => {
      mergeCollectedData(callId, payload);
      forward("collected-data")(payload);
    });
    session.on("assistant-text-delta", forward("assistant-text-delta"));
    session.on("speaking-started", forward("speaking-started"));
    session.on("speaking-stopped", forward("speaking-stopped"));
    session.on("barge-in", forward("barge-in"));
    session.on("error", (payload) =>
      forward("error")({ stage: (payload as { stage: string }).stage, message: String((payload as { error: unknown }).error) })
    );

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        recorder.addCallerFrame(data as Buffer);
        session.onAudioFrame(data as Buffer);
      }
      // Ignore any non-audio text messages from the client for this MVP.
    });

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      session.cleanup();
      endCall(callId, recorder.save(callId));
    };
    ws.on("close", finish);
    ws.on("error", (err) => {
      console.error("Dashboard WebSocket error:", err);
      finish();
    });
  });

  return wss;
}
