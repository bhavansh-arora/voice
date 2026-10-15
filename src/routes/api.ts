import { Router } from "express";
import fs from "fs";
import { createAgent, getAgent, listAgents, updateAgent } from "../db/agents";
import { getCall, listCalls } from "../db/calls";
import { runSetupChat } from "../services/setupChat";
import { VOICE_CATALOG, getVoice, sampleTextFor } from "../services/voices";
import { synthesizeWithVoice } from "../services/openaiTts";
import { generateAsteriskConfig } from "../services/telephony";
import { config } from "../config";
import type { AgentConfig, TelephonyVendorConfig } from "../services/agentConfig";

export const apiRouter = Router();

// --- Agents ---------------------------------------------------------------

apiRouter.get("/agents", (_req, res) => {
  res.json(listAgents());
});

apiRouter.post("/agents", (req, res) => {
  const agent = createAgent(req.body as Partial<AgentConfig>);
  res.status(201).json(agent);
});

apiRouter.get("/agents/:id", (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.json(agent);
});

apiRouter.put("/agents/:id", (req, res) => {
  const agent = updateAgent(req.params.id, req.body as Partial<AgentConfig>);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.json(agent);
});

// --- Setup chatbot ----------------------------------------------------------

apiRouter.post("/agents/:id/setup-chat", async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const message = (req.body as { message?: string })?.message?.trim();
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  try {
    const result = await runSetupChat(agent, message);
    res.json(result);
  } catch (err) {
    console.error("Setup chat failed:", err);
    res.status(502).json({ error: "Setup chat failed", detail: String(err) });
  }
});

// --- Voices ------------------------------------------------------------

apiRouter.get("/voices", (_req, res) => {
  res.json(VOICE_CATALOG);
});

apiRouter.post("/voices/preview", async (req, res) => {
  const voiceId = (req.body as { voiceId?: string })?.voiceId;
  const voice = voiceId ? getVoice(voiceId) : undefined;
  if (!voice) {
    res.status(400).json({ error: "Unknown voiceId" });
    return;
  }
  try {
    const wav = await synthesizeWithVoice(sampleTextFor(voice.language), voice.language, voice.id);
    res.set("Content-Type", "audio/wav");
    res.send(wav);
  } catch (err) {
    console.error("Voice preview failed:", err);
    res.status(502).json({ error: "Voice preview failed", detail: String(err) });
  }
});

// --- Telephony -----------------------------------------------------------

apiRouter.get("/agents/:id/telephony", (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  if (!agent.vendor) {
    res.json({ vendor: null });
    return;
  }
  try {
    const asterisk = generateAsteriskConfig(agent.vendor, config.audioSocketHost, config.audioSocketPort);
    res.json({ vendor: agent.vendor, asterisk });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

apiRouter.put("/agents/:id/telephony", (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const vendor = req.body as TelephonyVendorConfig;
  if (
    vendor?.vendor !== "plivo" ||
    !vendor.authId ||
    !vendor.authToken ||
    !vendor.phoneNumber ||
    !vendor.sipTrunkName ||
    !vendor.sipDomain
  ) {
    res.status(400).json({ error: "authId, authToken, phoneNumber, sipTrunkName, and sipDomain are all required" });
    return;
  }
  const updated = updateAgent(agent.id, { vendor });
  const asterisk = generateAsteriskConfig(vendor, config.audioSocketHost, config.audioSocketPort);
  res.json({ agent: updated, asterisk });
});

// --- Calls ------------------------------------------------------------

apiRouter.get("/calls", (req, res) => {
  const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
  res.json(listCalls(agentId));
});

apiRouter.get("/calls/:id", (req, res) => {
  const call = getCall(req.params.id);
  if (!call) {
    res.status(404).json({ error: "Call not found" });
    return;
  }
  res.json(call);
});

apiRouter.get("/calls/:id/recording", (req, res) => {
  const call = getCall(req.params.id);
  if (!call?.recordingPath || !fs.existsSync(call.recordingPath)) {
    res.status(404).json({ error: "No recording for this call" });
    return;
  }
  res.set("Content-Type", "audio/wav");
  fs.createReadStream(call.recordingPath).pipe(res);
});
