/**
 * Background worker registry and dispatch.
 * Workers are NOT child processes — they return task() call parameters
 * that the orchestrator dispatches as regular subagents.
 */

import { memoryStore } from "./memory.js";
import { getCoderModel, getFastModel } from "./model-registry.js";
import type {
  WorkerRecord,
  BackgroundWorkerType,
  WorkerTriggerEvent,
} from "./types.js";

let workerIdCounter = 0;

// ── Worker Registry ───────────────────────────────────────────────────

export const workerRegistry = {
  /** Subscribe a worker type to a trigger event. */
  subscribe(
    sessionId: string,
    workerType: BackgroundWorkerType,
    triggerEvent: WorkerTriggerEvent,
    config?: Record<string, unknown>,
  ): WorkerRecord {
    return memoryStore.storeWorker({
      sessionId,
      workerType,
      triggerEvent,
      status: "pending",
      config: config ?? null,
      findings: [],
      createdAt: Date.now(),
      completedAt: null,
    });
  },

  /** Get all subscriptions for a session. */
  getSubscriptions(sessionId: string): WorkerRecord[] {
    return memoryStore.getWorkersForSession(sessionId);
  },

  /** Check which workers should fire for a given event. */
  checkTriggers(sessionId: string, event: WorkerTriggerEvent): WorkerRecord[] {
    const all = memoryStore.getWorkersForSession(sessionId);
    return all.filter(
      (w) => w.triggerEvent === event && w.status === "pending",
    );
  },

  /** Build task() call parameters for a worker. */
  buildDispatch(
    worker: WorkerRecord,
    context?: { files?: string[]; sessionTask?: string },
  ): {
    agent: string;
    prompt: string;
    model: string;
    workerId: string;
  } {
    const config = WORKER_CONFIGS[worker.workerType];
    const files = context?.files ?? [];
    const fileList =
      files.length > 0
        ? `\n\nFiles to analyze:\n${files.map((f) => `- ${f}`).join("\n")}`
        : "";
    const taskContext = context?.sessionTask
      ? `\n\nOriginal task: ${context.sessionTask}`
      : "";

    // Mark as dispatched
    memoryStore.updateWorker(worker.id, { status: "dispatched" });

    return {
      agent: config.agentType,
      prompt: `${config.systemPrompt}${taskContext}${fileList}\n\n${config.instructions}`,
      model: config.model,
      workerId: worker.id,
    };
  },

  /** Record worker completion with findings. */
  complete(workerId: string, findings: string[]): void {
    memoryStore.updateWorker(workerId, {
      status: "completed",
      findings,
      completedAt: Date.now(),
    });
  },

  /** Mark worker as failed. */
  fail(workerId: string, reason: string): void {
    memoryStore.updateWorker(workerId, {
      status: "failed",
      findings: [reason],
      completedAt: Date.now(),
    });
  },

  /** Get findings for a completed worker. */
  getFindings(workerId: string): string[] {
    const w = memoryStore.getWorker(workerId);
    return w?.findings ?? [];
  },
};

// ── Worker Type Configurations ────────────────────────────────────────

interface WorkerConfig {
  agentType: string;
  model: string;
  systemPrompt: string;
  instructions: string;
}

const WORKER_CONFIGS: Record<BackgroundWorkerType, WorkerConfig> = {
  audit: {
    agentType: "general-purpose",
    model: getCoderModel(0),
    systemPrompt:
      "You are a security auditor. Scan the provided files for security vulnerabilities including injection, XSS, CSRF, auth bypass, secrets exposure, and OWASP Top 10 issues.",
    instructions: `For each file:
1. Check for injection vulnerabilities (SQL, command, path traversal)
2. Check for authentication/authorization issues
3. Check for exposed secrets or hardcoded credentials
4. Check for insecure data handling
5. Rate severity: CRITICAL / HIGH / MEDIUM / LOW

Output format:
FINDINGS:
- [SEVERITY] file:line — description
- ...
SUMMARY: <one-line overall assessment>`,
  },

  optimize: {
    agentType: "general-purpose",
    model: getCoderModel(1),
    systemPrompt:
      "You are a performance engineer. Analyze the provided files for performance bottlenecks, memory leaks, unnecessary allocations, and optimization opportunities.",
    instructions: `For each file:
1. Identify hot paths and bottlenecks
2. Check for unnecessary allocations or copies
3. Look for N+1 query patterns
4. Identify cacheable operations
5. Rate impact: HIGH / MEDIUM / LOW

Output format:
FINDINGS:
- [IMPACT] file:line — description and recommendation
- ...
SUMMARY: <one-line overall assessment>`,
  },

  testgaps: {
    agentType: "general-purpose",
    model: getCoderModel(2),
    systemPrompt:
      "You are a test coverage analyst. Identify missing test coverage for the provided files, focusing on edge cases, error paths, and critical business logic.",
    instructions: `For each file:
1. Identify untested functions and branches
2. Flag missing edge case coverage
3. Check error path testing
4. Identify integration test gaps
5. Rate priority: HIGH / MEDIUM / LOW

Output format:
FINDINGS:
- [PRIORITY] file:function — missing test description
- ...
SUMMARY: <one-line overall assessment>`,
  },

  document: {
    agentType: "general-purpose",
    model: getFastModel(0),
    systemPrompt:
      "You are a technical writer. Generate API documentation for the provided files, focusing on public interfaces, function signatures, and usage examples.",
    instructions: `For each file:
1. Document all exported functions/classes
2. Include parameter types and return types
3. Add usage examples where helpful
4. Note any caveats or gotchas

Output format:
DOCS:
## file.ts
### functionName(params) → ReturnType
Description...
**Example:**
\`\`\`ts
// usage
\`\`\`
...
SUMMARY: <one-line assessment of documentation completeness>`,
  },
};

// ── Trigger Descriptions ──────────────────────────────────────────────

export const TRIGGER_DESCRIPTIONS: Record<WorkerTriggerEvent, string> = {
  gate_pass: "Fires when quality gate passes (all scores >= 7)",
  gate_fail: "Fires when quality gate fails (any score < 7)",
  session_end: "Fires when session completes all phases",
  manual: "Fires only when explicitly dispatched",
};

export const WORKER_TYPE_DESCRIPTIONS: Record<BackgroundWorkerType, string> = {
  audit: "Security vulnerability scan on changed files",
  optimize: "Performance bottleneck analysis",
  testgaps: "Missing test coverage identification",
  document: "API documentation generation for changed files",
};
