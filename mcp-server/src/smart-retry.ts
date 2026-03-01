// ── Smart Retry ───────────────────────────────────────────────────────
// Analyzes gate failures and generates targeted per-workstream retry plans.
// Pure module — no side effects, no DB access, no external calls.

import type { SwarmSession } from "./swarm-types.js";
import type { GateResult } from "./scoring.js";

export interface FailureAnalysis {
  workstreamId: string;
  groupId: string;
  score: number;
  failureCategory:
    | "build_error"
    | "test_failure"
    | "quality_low"
    | "security_issue"
    | "incomplete"
    | "drift"
    | "unknown";
  rootCause: string;
  suggestedFix: string;
  affectedFiles: string[];
  retryPriority: "critical" | "high" | "medium" | "low";
}

export interface RetryPlan {
  sessionId: string;
  totalWorkstreams: number;
  failedWorkstreams: number;
  skippedWorkstreams: number;
  analyses: FailureAnalysis[];
  retryPrompts: Map<string, string>;
  estimatedSavings: string;
}

export interface BuildError {
  file: string;
  line?: number;
  error: string;
  category: string;
}

export interface TestFailure {
  testName: string;
  error: string;
  file?: string;
}

/**
 * Parse build/compiler output to extract specific errors.
 * Handles TypeScript, ESLint, and generic compiler output defensively.
 */
export function parseBuildErrors(output: string): BuildError[] {
  if (!output || typeof output !== "string") return [];

  const errors: BuildError[] = [];
  const seen = new Set<string>();

  const addError = (file: string, line: number | undefined, error: string, category: string) => {
    const key = `${file}:${line ?? ""}:${error.slice(0, 40)}`;
    if (seen.has(key)) return;
    seen.add(key);
    errors.push({ file, line, error: error.trim(), category });
  };

  // TypeScript: src/foo.ts(10,5): error TS2345: ...
  for (const m of output.matchAll(/^([^\s(]+\.ts[x]?)\((\d+),\d+\):\s+error\s+(TS\d+:\s*.+)$/gm)) {
    addError(m[1], parseInt(m[2], 10), m[3], "typescript");
  }

  // ESLint: path/file.ts\n  X:Y  error  message
  for (const m of output.matchAll(/^(.+\.ts[x]?)\s*\n?\s+(\d+):\d+\s+(?:error|warning)\s+(.+?)(?:\s{2,}.+)?$/gm)) {
    addError(m[1].trim(), parseInt(m[2], 10), m[3].trim(), "eslint");
  }

  // Generic: file:line: error message
  for (const m of output.matchAll(/^([\w./\\-]+\.\w+):(\d+):\s*(?:error|fatal error):\s*(.+)$/gm)) {
    addError(m[1], parseInt(m[2], 10), m[3].trim(), "compiler");
  }

  // npm/node runtime errors with stack traces
  for (const m of output.matchAll(/(?:Error|TypeError|ReferenceError|SyntaxError):\s*(.+)\n\s+at\s+.+\((.+):(\d+):\d+\)/gm)) {
    addError(m[2], parseInt(m[3], 10), m[1].trim(), "runtime");
  }

  // Fallback: cap at 5 generic error lines
  if (errors.length === 0) {
    let count = 0;
    for (const m of output.matchAll(/(?:error|ERROR|Error)\s*[:\-]\s*(.{10,120})/gm)) {
      addError("unknown", undefined, m[1].trim(), "unknown");
      if (++count >= 5) break;
    }
  }

  return errors;
}

/**
 * Parse test runner output to extract individual test failures.
 * Handles Vitest, Jest, and generic assertion formats defensively.
 */
export function parseTestFailures(output: string): TestFailure[] {
  if (!output || typeof output !== "string") return [];

  const failures: TestFailure[] = [];
  const seen = new Set<string>();

  const add = (testName: string, error: string, file?: string) => {
    const key = `${testName}:${error.slice(0, 40)}`;
    if (seen.has(key)) return;
    seen.add(key);
    failures.push({ testName: testName.trim(), error: error.trim(), file });
  };

  // Vitest: FAIL test/foo.test.ts > describe > it name
  for (const m of output.matchAll(/^(?:FAIL|✗|×)\s+([\w./\\-]+\.test\.\w+)\s*(?:>\s*(.+))?$/gm)) {
    const file = m[1];
    const name = m[2] ? m[2].trim() : file;
    const lineStart = output.indexOf(m[0]);
    const snippet = output.slice(lineStart, lineStart + 600);
    const errMatch = snippet.match(/(?:AssertionError|Error|Expected|Received)[^\n]*(?:\n[^\n]+){0,2}/);
    add(name, errMatch ? errMatch[0].trim() : "Test failed", file);
  }

  // Jest: ● Test Suite › test name
  for (const m of output.matchAll(/●\s+(.+)\n\n([\s\S]+?)(?=\n\n●|\n\nTest Suites|$)/g)) {
    const name = m[1].trim();
    const body = m[2].slice(0, 300).trim();
    const fileMatch = body.match(/at .+\(([\w./\\-]+\.test\.\w+):\d+/);
    add(name, body, fileMatch?.[1]);
  }

  // Generic Expected/Received pairs
  if (failures.length === 0) {
    let i = 0;
    for (const m of output.matchAll(/Expected[:\s]+(.{1,120})\n\s*Received[:\s]+(.{1,120})/g)) {
      add(`Assertion failure ${++i}`, `Expected: ${m[1].trim()} — Received: ${m[2].trim()}`);
      if (i >= 10) break;
    }
  }

  // Timeout errors
  for (const m of output.matchAll(/(?:Timeout|timed out|exceeded timeout)[^\n]*/gi)) {
    const key = m[0].slice(0, 60);
    if (!seen.has(key)) {
      seen.add(key);
      failures.push({ testName: "Timeout", error: m[0].trim() });
    }
  }

  return failures;
}

/**
 * Classify the category of failure from output text and score.
 * Uses heuristic signal matching; never throws.
 */
export function classifyFailure(output: string, score: number): FailureAnalysis["failureCategory"] {
  if (!output || typeof output !== "string") return score < 3 ? "build_error" : "unknown";

  const lower = output.toLowerCase();
  if (score < 3) return "build_error";

  const hasTest = /\b(test|spec|assert|expect|describe|it\(|jest|vitest|mocha|fail|error ts\d+)\b/.test(lower);
  const hasSec = /\b(xss|injection|sql injection|csrf|auth|authorization|authentication|insecure|vulnerability|cve|owasp|secret|token|leak)\b/.test(lower);
  const hasDrift = /\b(drift|off.?topic|scope creep|not aligned|deviated)\b/.test(lower);
  const hasIncomplete = /\b(incomplete|todo|fixme|not implemented|stub|missing|placeholder)\b/.test(lower);

  if (score >= 3 && score <= 5) {
    if (hasSec) return "security_issue";
    if (hasTest) return "test_failure";
  }
  if (score > 5 && score < 7) return "quality_low";
  if (hasDrift) return "drift";
  if (hasIncomplete) return "incomplete";
  return "unknown";
}

function categoryToPriority(
  category: FailureAnalysis["failureCategory"],
  criticalIssues: number,
): FailureAnalysis["retryPriority"] {
  if (criticalIssues > 0 || category === "build_error" || category === "security_issue") return "critical";
  if (category === "test_failure") return "high";
  if (category === "quality_low" || category === "drift") return "medium";
  return "low";
}

function extractRootCause(
  output: string,
  buildErrors: BuildError[],
  testFailures: TestFailure[],
  category: FailureAnalysis["failureCategory"],
): string {
  if (!output) return "No output provided for analysis.";
  if (buildErrors.length > 0) {
    return buildErrors.slice(0, 3).map((e) => `${e.file}${e.line ? `:${e.line}` : ""} — ${e.error}`).join("; ");
  }
  if (testFailures.length > 0) {
    return testFailures.slice(0, 3).map((f) => `${f.testName}: ${f.error.slice(0, 120)}`).join("; ");
  }
  const meaningful = output.split("\n").map((l) => l.trim()).find((l) => l.length > 20 && !/^[>#\-*]/.test(l));
  return meaningful?.slice(0, 200) ?? `Failure category: ${category}`;
}

function buildSuggestedFix(
  category: FailureAnalysis["failureCategory"],
  buildErrors: BuildError[],
  testFailures: TestFailure[],
  score: number,
): string {
  switch (category) {
    case "build_error": {
      if (buildErrors.length > 0) {
        const files = [...new Set(buildErrors.map((e) => e.file))].slice(0, 5).join(", ");
        return `Fix compilation errors in: ${files}. Ensure all types are correct and imports resolve.`;
      }
      return "Resolve build errors — ensure all imports are valid and the project compiles with zero errors.";
    }
    case "test_failure": {
      if (testFailures.length > 0) {
        const names = testFailures.slice(0, 3).map((f) => `"${f.testName}"`).join(", ");
        return `Fix failing tests: ${names}. Verify expected vs received values match the intended behavior.`;
      }
      return "Fix failing unit/integration tests. Run the test suite locally to identify assertion mismatches.";
    }
    case "security_issue":
      return "Address security vulnerabilities identified. Sanitize inputs, validate authentication, and follow OWASP guidelines.";
    case "quality_low":
      return `Score is ${score}/10. Improve correctness and completeness — ensure all requirements are fully addressed.`;
    case "incomplete":
      return "Complete all TODO/FIXME items and stub implementations. The workstream output must be production-ready.";
    case "drift":
      return "Realign output to the original task description. Remove out-of-scope work and ensure all required aspects are covered.";
    default:
      return `Score is ${score}/10. Review the workstream output against task requirements and improve quality across all dimensions.`;
  }
}

/**
 * Generate a targeted retry prompt referencing specific errors and files.
 * Does NOT reproduce the full original prompt — only the relevant context.
 */
export function generateTargetedRetryPrompt(analysis: FailureAnalysis, originalPrompt: string): string {
  const errorSection = analysis.rootCause && analysis.rootCause !== `Failure category: ${analysis.failureCategory}`
    ? `\n## ROOT CAUSE\n${analysis.rootCause}\n`
    : "";

  const filesSection = analysis.affectedFiles.length > 0
    ? `\n## AFFECTED FILES\n${analysis.affectedFiles.map((f) => `- ${f}`).join("\n")}\n`
    : "";

  const taskContext = originalPrompt.slice(0, 500).trim();
  const truncated = originalPrompt.length > 500 ? "\n[...task truncated for brevity]" : "";

  return `## TARGETED RETRY — Workstream ${analysis.workstreamId}

**Score:** ${analysis.score}/10 | **Category:** ${analysis.failureCategory} | **Priority:** ${analysis.retryPriority}

## ORIGINAL TASK (summary)
${taskContext}${truncated}

## WHAT WENT WRONG
${analysis.rootCause}
${errorSection}${filesSection}
## REQUIRED FIX
${analysis.suggestedFix}

Address only the issues listed above. Do not re-implement unrelated parts of the task.
Your output will be scored again — target ≥ 7/10.
`;
}

/**
 * Analyze gate results and generate a targeted retry plan.
 * Pure function — no side effects.
 */
export function analyzeFailures(
  session: SwarmSession,
  gateResult: GateResult,
  scores: Array<{ workstream: string; score: number; feedback?: string }>,
): RetryPlan {
  const failedIds = new Set(gateResult.failedWorkstreams);
  const totalWorkstreams = session.workstreams.length;
  const analyses: FailureAnalysis[] = [];
  const retryPrompts = new Map<string, string>();

  for (const scoreEntry of scores) {
    const wsId = scoreEntry.workstream;
    if (!failedIds.has(wsId)) continue;

    const ws = session.workstreams.find((w) => w.id === wsId);
    const groupId =
      session.agentGroups.find((g) => g.workerSlots.some((slot) => slot.workstreamId === wsId))?.id ?? "unknown";

    const boardOutput = session.board
      .filter((msg) => msg.workstream === wsId)
      .map((msg) => msg.content)
      .join("\n");

    const combined = [scoreEntry.feedback ?? "", boardOutput].join("\n").trim();
    const buildErrors = parseBuildErrors(combined);
    const testFailures = parseTestFailures(combined);
    const category = classifyFailure(combined, scoreEntry.score);
    const criticalIssues = ws?.criticalIssues ?? 0;
    const priority = categoryToPriority(category, criticalIssues);
    const rootCause = extractRootCause(combined, buildErrors, testFailures, category);

    const errorFiles = buildErrors.map((e) => e.file).filter((f) => f !== "unknown");
    const testFiles = testFailures.flatMap((f) => (f.file ? [f.file] : []));
    const affectedFiles = [...new Set([...errorFiles, ...testFiles, ...(ws?.files ?? [])])].slice(0, 10);
    const suggestedFix = buildSuggestedFix(category, buildErrors, testFailures, scoreEntry.score);

    const analysis: FailureAnalysis = {
      workstreamId: wsId,
      groupId,
      score: scoreEntry.score,
      failureCategory: category,
      rootCause,
      suggestedFix,
      affectedFiles,
      retryPriority: priority,
    };

    analyses.push(analysis);
    retryPrompts.set(wsId, generateTargetedRetryPrompt(analysis, ws?.description ?? session.task));
  }

  // Sort: critical first
  const order: Record<FailureAnalysis["retryPriority"], number> = { critical: 0, high: 1, medium: 2, low: 3 };
  analyses.sort((a, b) => order[a.retryPriority] - order[b.retryPriority]);

  const failedCount = analyses.length;
  const skippedCount = totalWorkstreams - failedCount;
  const savingsPct = totalWorkstreams > 0 ? Math.round((skippedCount / totalWorkstreams) * 100) : 0;

  return {
    sessionId: session.id,
    totalWorkstreams,
    failedWorkstreams: failedCount,
    skippedWorkstreams: skippedCount,
    analyses,
    retryPrompts,
    estimatedSavings: `Retrying ${failedCount}/${totalWorkstreams} workstreams (${savingsPct}% savings)`,
  };
}
