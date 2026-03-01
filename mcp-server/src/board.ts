// ── Board Operations ──────────────────────────────────────────────────
// Message board for inter-agent communication within a swarm session.

import type { SwarmSession, BoardMessage } from "./swarm-types.js";

// ── Identity Stripping ────────────────────────────────────────────────

export function stripIdentity(text: string): string {
  if (!text) return "";
  // Remove ANSI codes
  const noAnsi = text.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    "",
  );
  // Remove model names
  return noAnsi
    .replace(/claude[-\s]?\w+/gi, "a contributor")
    .replace(/gpt[-\s]?\w+/gi, "a contributor")
    .replace(/opus|sonnet|haiku|codex/gi, "contributor")
    .replace(/gemini[-\s]?\w+/gi, "a contributor")
    .replace(/agent[_-]?\d+/gi, "a contributor")
    .replace(/workstream[_-]?\d+/gi, "workstream")
    .replace(/ws-\d+/gi, "workstream");
}

export function postToBoard(
  session: SwarmSession,
  workstream: string,
  type: BoardMessage["type"],
  content: string,
  level: BoardMessage["level"] = "L3",
  group?: string,
  debateId?: string,
): BoardMessage {
  const msg: BoardMessage = {
    workstream,
    type,
    level,
    group,
    debateId,
    content: stripIdentity(content),
    timestamp: Date.now(),
  };
  session.board.push(msg);
  return msg;
}

export function readBoard(
  session: SwarmSession,
  forWorkstream?: string,
  types?: BoardMessage["type"][],
): BoardMessage[] {
  let messages = session.board;
  if (forWorkstream) {
    messages = messages.filter((m) => m.workstream !== forWorkstream);
  }
  if (types && types.length > 0) {
    messages = messages.filter((m) => types.includes(m.type));
  }
  return messages;
}

export function buildBoardContext(
  session: SwarmSession,
  forWorkstream: string,
  relevantWorkstreams?: string[],
): string {
  const messages = readBoard(session, forWorkstream);
  if (messages.length === 0) return "";

  const lines: string[] = ["", "--- FINDINGS FROM OTHER WORKSTREAMS ---"];
  for (const msg of messages) {
    if (relevantWorkstreams && relevantWorkstreams.length > 0) {
      const isRelevant = relevantWorkstreams.includes(msg.workstream);
      if (!isRelevant) {
        if (msg.type === "finding") continue;
        const preview = msg.content.substring(0, 80);
        const suffix = msg.content.length > 80 ? "..." : "";
        lines.push(`[${msg.workstream}] ${msg.type}: ${preview}${suffix}`);
        continue;
      }
    }
    lines.push(`[${msg.type.toUpperCase()}] ${msg.content}`);
  }
  lines.push("--- END FINDINGS ---");
  lines.push("");
  return lines.join("\n");
}
