import {
  getSession,
  getPhaseDefinition,
  getPrompt,
  resolveModelTracked,
  checkRateLimit,
  getWorkerAgentName,
  TIER_PHASES,
  postToBoard,
  stripIdentity,
  getModelProvider,
  getCoderModel,
  buildBoardContext,
  buildAnonymousHistory,
} from "../state.js";
import { workerRegistry, WORKER_TYPE_DESCRIPTIONS } from "../workers.js";
import { ok, err, workstreamCount, type ToolResult } from "./shared.js";
import { handleSwarmSubmit } from "./lifecycle.js";

// ── swarm_dispatch ─────────────────────────────────────────────────────

export function handleSwarmDispatch(args: {
  sessionId: string;
  promptRef: string;
  subagent_type: string;
  description: string;
  model?: string;
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  const prompt = getPrompt(session, args.promptRef);
  if (!prompt)
    return err(
      `Prompt ref not found: ${args.promptRef}. Call swarm_next first.`,
    );

  // Resolve model through fallback if provided
  let modelInfo: { model?: string; fallback?: boolean; original?: string } = {};
  let resolvedModelId = args.model ?? "";
  if (args.model) {
    const { model: resolved, wasFallback } = resolveModelTracked(args.model);
    resolvedModelId = resolved;
    modelInfo = { model: resolved, fallback: wasFallback };
    if (wasFallback) modelInfo.original = args.model;
  }

  // Token-bucket rate limiting per model tier
  if (resolvedModelId) {
    const rl = checkRateLimit(session.id, resolvedModelId);
    if (!rl.ok) {
      const waitSec = Math.ceil(rl.retryAfterMs / 1000);
      return ok({
        rateLimited: true,
        tier: rl.tier,
        model: resolvedModelId,
        retryAfterSeconds: waitSec,
        retryAfterMs: rl.retryAfterMs,
        nextAction: [
          `⏳ Rate limited: ${rl.tier}-tier models are at capacity (GitHub Copilot RPM limit).`,
          `Wait ${waitSec}s then retry this exact swarm_dispatch call.`,
          `bash("sleep ${waitSec}")`,
        ].join("\n"),
      });
    }
  }

  return ok({
    subagent_type: args.subagent_type,
    description: args.description,
    prompt,
    ...modelInfo,
  });
}

// ── swarm_collect ─────────────────────────────────────────────────────

export function handleSwarmCollect(args: {
  sessionId: string;
  outputs: Array<{ workstream: string; output: string }>;
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  if (session.executionMode !== "subprocess") {
    return err(
      "swarm_collect is only for subprocess execution mode. Use swarm_submit for task mode.",
    );
  }

  if (!args.outputs || args.outputs.length === 0) {
    return err(
      "No outputs provided. Pass an array of {workstream, output} objects.",
    );
  }

  const results = [];
  for (const item of args.outputs) {
    // Feed each output through the existing submit logic
    const submitResult = handleSwarmSubmit({
      sessionId: args.sessionId,
      output: item.output,
      agentId: `subprocess-${item.workstream}`,
    });
    results.push({
      workstream: item.workstream,
      submitResult: JSON.parse(submitResult.content[0].text),
    });
  }

  // Check if all outputs triggered phase completion
  const phase = session.phases[session.currentPhaseIndex];
  const phaseDef = getPhaseDefinition(session);

  let nextAction: string;
  if (phase.status === "done") {
    const nextIdx = session.currentPhaseIndex + 1;
    if (nextIdx < session.phases.length) {
      const nextDef = TIER_PHASES[session.tier][nextIdx];
      if (nextDef.name.startsWith("merge_")) {
        nextAction = `All subprocess outputs collected. Phase complete. Call swarm_merge with sessionId "${session.id}" and the outputs.`;
      } else {
        nextAction = `All subprocess outputs collected. Phase complete. Call swarm_next with sessionId "${session.id}" to advance.`;
      }
    } else {
      nextAction = "All phases complete. Swarm finished.";
    }
  } else {
    const phaseDefCheck = getPhaseDefinition(session);
    const expected = phaseDefCheck.parallel ? workstreamCount(session) : 1;
    const remaining = expected - phase.outputs.length;
    nextAction = `${remaining} more output(s) still expected. Collect remaining subprocess outputs and call swarm_collect again.`;
  }

  return ok({
    sessionId: session.id,
    phase: phase.name,
    phaseStatus: phase.status,
    collected: args.outputs.length,
    results,
    nextAction,
  });
}

// ── swarm_worker ──────────────────────────────────────────────────────

export function handleSwarmWorker(args: {
  sessionId: string;
  action: "dispatch" | "status" | "results" | "complete";
  workerType?: string;
  workerId?: string;
  files?: string[];
  context?: string;
  findings?: string[];
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  switch (args.action) {
    case "dispatch": {
      if (!args.workerType) return err("workerType required for dispatch");

      const record = workerRegistry.subscribe(
        session.id,
        args.workerType as any,
        "manual",
      );
      const dispatch = workerRegistry.buildDispatch(record, {
        files: args.files,
        sessionTask: args.context ?? session.task,
      });

      return ok({
        workerId: dispatch.workerId,
        taskCall: {
          subagent_type: dispatch.agent,
          description: `${WORKER_TYPE_DESCRIPTIONS[args.workerType as keyof typeof WORKER_TYPE_DESCRIPTIONS] ?? args.workerType} worker`,
          prompt: dispatch.prompt,
          model: dispatch.model,
        },
        nextAction: `Dispatch worker with task() using the taskCall params above. After completion, call swarm_worker with action="complete" and the findings.`,
      });
    }

    case "status": {
      const subs = workerRegistry.getSubscriptions(session.id);
      return ok({
        workers: subs.map((w) => ({
          id: w.id,
          workerType: w.workerType,
          status: w.status,
          completedAt: w.completedAt,
          findingsCount: w.findings.length,
        })),
      });
    }

    case "results": {
      if (!args.workerId) return err("workerId required for results");
      const findings = workerRegistry.getFindings(args.workerId);
      return ok({
        workerId: args.workerId,
        findings,
        nextAction:
          findings.length > 0
            ? `Worker produced ${findings.length} finding(s). Review and act on them.`
            : "No findings recorded for this worker.",
      });
    }

    case "complete": {
      if (!args.workerId) return err("workerId required for complete");
      if (!args.findings) return err("findings required for complete");

      workerRegistry.complete(args.workerId, args.findings);

      // Post findings to board
      for (const finding of args.findings) {
        postToBoard(session, "background-worker", "background", finding, "L1");
      }

      return ok({
        workerId: args.workerId,
        status: "completed",
        findingsPosted: args.findings.length,
        nextAction: `Worker completed. ${args.findings.length} finding(s) posted to board.`,
      });
    }

    default:
      return err(`Unknown worker action: ${args.action}`);
  }
}
