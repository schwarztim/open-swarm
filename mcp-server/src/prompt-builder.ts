// ── Prompt Builder ────────────────────────────────────────────────────
// Builds prompts for L2 managers, anonymous history, and prompt storage.

import { randomUUID } from "crypto";
import type { SwarmSession, AgentGroup } from "./swarm-types.js";
import { buildBoardContext } from "./board.js";

// ── Prompt Store ──────────────────────────────────────────────────────

export function storePrompt(session: SwarmSession, prompt: string): string {
  const ref = `prompt-${randomUUID()}`;
  session.promptStore.set(ref, prompt);
  return ref;
}

export function getPrompt(
  session: SwarmSession,
  ref: string,
): string | undefined {
  return session.promptStore.get(ref);
}

// ── Anonymous History Builder ──────────────────────────────────────────

export function buildAnonymousHistory(
  session: SwarmSession,
  forWorkstream?: string,
): string {
  const lines: string[] = [];
  const currentRound =
    session.rounds.length > 0
      ? Math.max(...session.rounds.map((r) => r.round))
      : 0;

  lines.push(
    `=== SWARM CONTEXT (Tier: ${session.tier}, Round: ${currentRound}) ===`,
  );
  lines.push(`TASK: ${session.task}`);
  lines.push("");

  const relevantHistory = session.history.filter((entry) => {
    if (!forWorkstream) return true;
    return (
      entry.content.includes(forWorkstream) ||
      !entry.content.includes("workstream:")
    );
  });

  for (const entry of relevantHistory) {
    lines.push(`--- ${entry.phase.toUpperCase()} (Round ${entry.round}) ---`);
    lines.push(entry.content);
    lines.push("");
  }

  const relevantRounds = forWorkstream
    ? session.rounds.filter((r) => r.workstream === forWorkstream)
    : session.rounds;

  if (relevantRounds.length > 0) {
    lines.push("--- SCORES ---");
    for (const r of relevantRounds) {
      lines.push(
        `Round ${r.round} | Workstream: ${r.workstream} | Score: ${r.score}/10 | Critical Issues: ${r.criticalIssues}`,
      );
    }
    lines.push("");
  }

  lines.push("--- YOUR OUTPUT ---");
  lines.push(
    "A contributor completed the prior phases above. Build on their work. " +
      "Do not reference specific contributors or models. " +
      "Focus on improving quality and addressing any identified issues.",
  );

  return lines.join("\n");
}

// ── L2 Manager Prompt Builder ─────────────────────────────────────────

export function buildManagerPrompt(
  session: SwarmSession,
  group: AgentGroup,
  phaseName: string,
  history: string,
): string {
  const assignedWorkstreamIds = group.workerSlots.map((ws) => ws.workstreamId);

  const taskSpec =
    session.task.length > 2000
      ? session.task.substring(0, 2000) +
        "\n[Task truncated — full spec available via board messages]"
      : session.task;

  const boardCtxRaw = buildBoardContext(
    session,
    group.id,
    assignedWorkstreamIds,
  );
  const crossGroupCtx = boardCtxRaw.trim() || "No cross-group messages yet.";

  const workerSpecs = group.workerSlots
    .map((ws, i) => {
      const filesStr =
        ws.files.length > 0 ? `Files: ${ws.files.join(", ")}` : "Files: TBD";
      return `  Worker ${i}: subagent_type="${ws.agentType}" | Workstream: ${ws.workstreamId} | ${ws.description} | ${filesStr}`;
    })
    .join("\n");

  const scratchDir = `${session.outputDir}/${group.id}`;

  return [
    history,
    "",
    "═══════════════════════════════════════════════════════════════",
    `YOUR ROLE: L2 AGENT MANAGER — ${group.id}`,
    `PHASE: ${phaseName}`,
    "═══════════════════════════════════════════════════════════════",
    "",
    "## TASK",
    taskSpec,
    "",
    "## HIERARCHY",
    "```",
    "L1 Orchestrator (the boss — makes strategic decisions, resolves debates)",
    `  └── YOU: L2 Manager [${group.id}] (plan, delegate, coordinate, report)`,
    group.workerSlots
      .map(
        (ws, i) =>
          `        └── L3 Worker ${i} [${ws.workstreamId}] (${ws.agentType})`,
      )
      .join("\n"),
    "```",
    "",
    "## YOUR TEAM",
    workerSpecs,
    "",
    "## COMMUNICATION CHANNELS",
    "",
    "### COMMUNICATION RULES",
    "```",
    "L1 ↔ L2: You talk to the orchestrator (boss) via the board     ✅",
    "L2 ↔ L2: You talk to OTHER managers via the board              ✅",
    "L2 → L3: You direct workers via task() prompts                 ✅",
    "L3 → L2: Workers report TO YOU via the board                   ✅",
    "L3 ✗ L3: Workers NEVER talk directly to other workers          🚫",
    "```",
    "",
    "### 🔴 THE BOARD — Your primary communication channel",
    `Session ID: ${session.id}`,
    `Your Group: ${group.id}`,
    "",
    "**All communication flows through the board.** Not status files, not scratch dirs.",
    "",
    "#### Posting to the board (you → everyone)",
    "```",
    `swarm_relay(sessionId="${session.id}", workstream="${group.id}", level="L2", group="${group.id}",`,
    '  type="<plan|finding|status|blocker|report>", content="<message>")',
    "```",
    "",
    "Post types:",
    "  - **plan**: Post your plan BEFORE dispatching workers (so other managers see it)",
    "  - **finding**: Discovery that other managers should know about",
    "  - **status**: Progress update for the boss",
    "  - **blocker**: Something blocking your work — boss needs to decide",
    "  - **report**: Your final synthesized report",
    "",
    "#### Reading the board (everyone → you)",
    "```",
    `swarm_board(sessionId="${session.id}")                     // Everything`,
    `swarm_board(sessionId="${session.id}", level="L2")         // Other managers' posts`,
    `swarm_board(sessionId="${session.id}", level="L3", group="${group.id}")  // YOUR workers' posts`,
    `swarm_board(sessionId="${session.id}", level="L1")         // Boss directives/decisions`,
    "```",
    "",
    "#### 🔵 Cross-team context (from other L2 managers so far)",
    crossGroupCtx,
    "",
    "### 📡 WORKER COMMUNICATION PROTOCOL",
    "When you dispatch workers, COPY-PASTE this EXACT block into EVERY worker prompt:",
    "```",
    "╔══════════════════════════════════════════════════════════╗",
    `║ SESSION_ID = "${session.id}"`,
    `║ GROUP_ID = "${group.id}"`,
    '║ WORKSTREAM_ID = "<FILL IN THE WORKER\'S WS ID>"',
    "╚══════════════════════════════════════════════════════════╝",
    "",
    "BOARD COMMANDS — use these EXACTLY as written:",
    "",
    "Read board:",
    `  swarm_board(sessionId="${session.id}", level="L2", group="${group.id}")`,
    "",
    "Post finding:",
    `  swarm_relay(sessionId="${session.id}", workstream="<WORKSTREAM_ID>", level="L3", group="${group.id}", type="finding", content="<message>")`,
    "",
    "Post blocker:",
    `  swarm_relay(sessionId="${session.id}", workstream="<WORKSTREAM_ID>", level="L3", group="${group.id}", type="blocker", content="<message>")`,
    "```",
    "",
    '⚠️ CRITICAL: The sessionId is "' +
      session.id +
      '". Workers MUST use this EXACT string.',
    'DO NOT let workers invent session IDs like "workstream2-session" or "SESSION_ID_PLACEHOLDER".',
    "",
    "Tell each worker:",
    "1. **At start**: Read the board for manager directives",
    "2. **During work**: Post findings/status to the board",
    "3. **If blocked**: Post a blocker, then continue with best judgment",
    "4. **On completion**: Post final status to the board",
    "5. **NEVER** communicate directly with other workers. ALL goes through you.",
    "",
    "### 🔁 MANAGER POLLING — READ THE BOARD BETWEEN BATCHES",
    "After dispatching each batch of workers, CHECK THE BOARD before dispatching the next:",
    "```",
    `// Check for worker questions/blockers`,
    `swarm_board(sessionId="${session.id}", level="L3", group="${group.id}")`,
    `// Check for cross-team findings from other managers`,
    `swarm_board(sessionId="${session.id}", level="L2")`,
    `// Check for boss directives`,
    `swarm_board(sessionId="${session.id}", level="L1")`,
    "```",
    "If a worker posted a question/blocker, answer it by posting a decision:",
    `swarm_relay(sessionId="${session.id}", workstream="${group.id}", level="L2", group="${group.id}",`,
    '  type="decision", content="RE: <worker question> — <your answer>")',
    "",
    "### ⚠️ Escalation (debates → L1 boss)",
    "If your workers disagree and you CANNOT resolve it:",
    "  - Do NOT guess. Post a blocker to the board.",
    `  - swarm_relay(sessionId="${session.id}", workstream="${group.id}", level="L2",`,
    '    type="blocker", content="ESCALATION: <describe the disagreement>")',
    "  - The L1 orchestrator will read the board and make the call.",
    "",
    "### 🔥 Structured Debate Protocol (for worker disagreements)",
    "If your workers produce CONFLICTING outputs that you cannot easily resolve:",
    "",
    "1. DO NOT guess or pick one arbitrarily",
    `2. Call swarm_debate(action="start", sessionId="${session.id}", groupId="${group.id}",`,
    '   topic="<what they disagree on>", trigger="disagreement")',
    "3. The server will set up a structured debate between workers",
    '4. Call swarm_debate(action="next", debateId=<returned id>) to get debate phase prompts',
    "5. Dispatch workers with the debate prompts (parallel)",
    '6. Submit their outputs via swarm_debate(action="submit", debateId=<id>, slotId=<slot>, content=<output>)',
    '7. Call swarm_debate(action="evaluate", debateId=<id>) for convergence check',
    '8. If converged → call swarm_debate(action="synthesize"); if stalled → escalate to L1',
    "",
    "When to trigger debate:",
    "  - Workers propose incompatible approaches to the same problem",
    "  - Quality scores diverge significantly (>3 point gap)",
    "  - Workers flag contradictory findings about the codebase",
    "  - Your workstream assignment is tagged as debate-type",
    "",
    "The debate protocol ensures adversarial critique yields higher accuracy than",
    "collaborative consensus (Agent-Skills: multi-agent-patterns §Debate Protocols).",
    "",
    "## EXECUTION PROTOCOL",
    "",
    `1. SETUP: mkdir -p ${scratchDir}`,
    `   Post your plan to the board:`,
    `   swarm_relay(sessionId="${session.id}", workstream="${group.id}", level="L2", group="${group.id}",`,
    `     type="plan", content="<how you're splitting work across workers>")`,
    "",
    "2. CHECK THE BOARD for cross-team context and boss directives:",
    `   swarm_board(sessionId="${session.id}", level="L2")  // other managers`,
    `   swarm_board(sessionId="${session.id}", level="L1")  // boss directives`,
    "",
    "3. PLAN: Analyze the task. Decide how to split work across your workers.",
    "",
    "4. DISPATCH WORKERS IN STAGGERED BATCHES (GitHub Copilot rate limits):",
    "   ⚠️ Do NOT launch all workers at once — this will trigger API rate limiting.",
    "   Launch in batches of 2, with a sleep between batches:",
    "   ```",
    "   # Batch 1 — launch 2 workers in same message",
    '   task(subagent_type="<agent>", description="<task>", prompt="<instructions>")',
    '   task(subagent_type="<agent>", description="<task>", prompt="<instructions>")',
    "   # Wait for rate limit cooldown",
    '   bash("sleep 8")',
    "   ```",
    "   In each worker prompt, ALWAYS include:",
    `   - SESSION_ID: ${session.id}`,
    `   - GROUP_ID: ${group.id}`,
    "   - WORKSTREAM_ID: <their workstream id>",
    "   - Their specific assignment and files",
    "   - The communication protocol (swarm_relay/swarm_board instructions above)",
    "",
    "5. BETWEEN BATCHES — POLL THE BOARD:",
    `   swarm_board(sessionId="${session.id}", level="L3", group="${group.id}")  // worker posts`,
    `   swarm_board(sessionId="${session.id}", level="L2")  // other managers`,
    "   Answer any worker questions. Incorporate cross-team findings.",
    "   Adjust remaining worker dispatches based on new context.",
    "",
    "6. REVIEW & COORDINATE:",
    "   - Check each worker's output for quality",
    "   - If workers conflict: resolve it yourself OR re-dispatch with clarification",
    "   - If a debate is unresolvable: post BLOCKER to board for L1",
    "",
    "7. SYNTHESIZE & REPORT:",
    "   Post final report to the board:",
    `   swarm_relay(sessionId="${session.id}", workstream="${group.id}", level="L2", group="${group.id}",`,
    '     type="report", content="<your full report below>")',
    "",
    "   Then return the report in this EXACT format:",
    "",
    "## Plan",
    "<how you divided work across your team>",
    "",
    "## Results",
    "<synthesized deliverable from all workers>",
    "",
    "## Team Coordination",
    "<how workers communicated, conflicts resolved>",
    "",
    "## Issues",
    "<problems found, blockers hit>",
    "",
    "## Escalations",
    "<NONE or unresolved debates that need L1 boss decision>",
    "",
    "## Cross-Team Notes",
    "<things other L2 managers should know about your work>",
    "",
    "─── CRITICAL: DO NOT DO THE WORK YOURSELF ───",
    "You are a manager. Spawn workers. Only touch code to resolve worker conflicts.",
    "",
    "─── WS3b: TEST SUITE REQUIREMENT ───",
    "BEFORE reporting completion, run the project's test suite if one exists:",
    "  - Python: pytest --tb=short -q",
    "  - Node:   npm test",
    "  - Go:     go test ./...",
    "Report test results in your completion report. If tests fail, fix them before submitting.",
  ].join("\n");
}
