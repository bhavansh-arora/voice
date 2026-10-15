import { randomUUID } from "crypto";
import { db } from "./index";
import { DEFAULT_INTRO_LINE, type AgentConfig } from "../services/agentConfig";

interface AgentRow {
  id: string;
  data: string;
  created_at: string;
  updated_at: string;
}

type AgentPatch = Partial<Omit<AgentConfig, "id" | "createdAt" | "updatedAt">>;

function defaults(): Omit<AgentConfig, "id" | "createdAt" | "updatedAt"> {
  return {
    name: "New Agent",
    introLine: DEFAULT_INTRO_LINE,
    introDescription: "",
    dataFields: [],
    voiceHi: "onyx",
    voiceEn: "alloy",
    vendor: null,
    status: "draft",
    setupChatHistory: [],
  };
}

function rowToAgent(row: AgentRow): AgentConfig {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...JSON.parse(row.data),
  };
}

export function createAgent(patch: AgentPatch = {}): AgentConfig {
  const now = new Date().toISOString();
  const id = randomUUID();
  const body = { ...defaults(), ...patch };
  db.prepare("INSERT INTO agents (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
    id,
    JSON.stringify(body),
    now,
    now
  );
  return { id, createdAt: now, updatedAt: now, ...body };
}

export function getAgent(id: string): AgentConfig | null {
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

export function listAgents(): AgentConfig[] {
  const rows = db.prepare("SELECT * FROM agents ORDER BY created_at DESC").all() as AgentRow[];
  return rows.map(rowToAgent);
}

export function updateAgent(id: string, patch: AgentPatch): AgentConfig | null {
  const existing = getAgent(id);
  if (!existing) return null;
  const { id: _id, createdAt, updatedAt: _updatedAt, ...rest } = existing;
  const body = { ...rest, ...patch };
  const updatedAt = new Date().toISOString();
  db.prepare("UPDATE agents SET data = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(body),
    updatedAt,
    id
  );
  return { id, createdAt, updatedAt, ...body };
}

/**
 * The agent used when nothing more specific picks one (AudioSocket calls
 * today have no way to say which agent they're for - that's the multi-agent
 * routing hook to build out later, once a call actually needs to name its
 * agent, e.g. by which Asterisk trunk/DID it came in on).
 */
export function getDefaultAgent(): AgentConfig {
  const [first] = listAgents();
  return first ?? createAgent({ name: "Default Agent" });
}
