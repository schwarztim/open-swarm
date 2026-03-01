// ── Verification ──────────────────────────────────────────────────────
// Acceptance test parsing, verifier model selection, and prompt building.

import type { SwarmSession, Workstream, AcceptanceTest } from "./swarm-types.js";
import { getModelProvider, criticPool } from "./model-registry.js";

export function parseAcceptanceTests(
  task: string,
): Map<string, AcceptanceTest[]> {
  const result = new Map<string, AcceptanceTest[]>();
  const blockMatch = task.match(
    /ACCEPTANCE_TESTS:\s*\n([\s\S]*?)(?:\n(?=[A-Z_]+:)|\n---|\n$|$)/,
  );
  if (!blockMatch) return result;

  const block = blockMatch[1];
  const wsRegex = /^(\S+):\s*$/gm;
  let match: RegExpExecArray | null;
  const wsPositions: Array<{ id: string; start: number }> = [];
  while ((match = wsRegex.exec(block)) !== null) {
    wsPositions.push({ id: match[1], start: match.index + match[0].length });
  }

  for (let i = 0; i < wsPositions.length; i++) {
    const end =
      i + 1 < wsPositions.length ? wsPositions[i + 1].start : block.length;
    const wsBlock = block.substring(wsPositions[i].start, end);
    const tests: AcceptanceTest[] = [];

    const testRegex =
      /- name:\s*"([^"]+)"\s+command:\s*"([^"]+)"\s+expect:\s*"([^"]+)"(?:\s+category:\s*"([^"]+)")?/g;
    let testMatch: RegExpExecArray | null;
    while ((testMatch = testRegex.exec(wsBlock)) !== null) {
      tests.push({
        name: testMatch[1],
        command: testMatch[2],
        expect: testMatch[3],
        category: (testMatch[4] as AcceptanceTest["category"]) ?? "integration",
      });
    }

    if (tests.length > 0) {
      result.set(wsPositions[i].id, tests);
    }
  }

  return result;
}

export function getVerifierModel(builderModel: string, index: number): string {
  const builderProvider = getModelProvider(builderModel);
  const candidates = criticPool.filter(
    (m) => getModelProvider(m) !== builderProvider,
  );
  if (candidates.length > 0) return candidates[index % candidates.length];
  return criticPool[index % criticPool.length];
}

export function buildVerifierPrompt(
  session: SwarmSession,
  workstream: Workstream,
  tests: AcceptanceTest[],
): string {
  const testList = tests
    .map(
      (t, i) =>
        `  ${i + 1}. ${t.name}\n     Command: ${t.command}\n     Expect: ${t.expect}\n     Category: ${t.category}`,
    )
    .join("\n");

  return [
    `=== VALIDATION TASK ===`,
    `You are an independent verifier. Your job is to run acceptance tests against the project.`,
    `You did NOT build this code — you are testing it from the outside.`,
    ``,
    `Project task: ${session.task}`,
    `Workstream: ${workstream.id} — ${workstream.description}`,
    `Files: ${workstream.files.join(", ") || "See project root"}`,
    ``,
    `=== STARTUP ===`,
    `1. Detect the project type from files (package.json → npm, setup.py → pip, go.mod → go, docker-compose.yml → docker)`,
    `2. Install dependencies if needed`,
    `3. Start the application (npm run dev / docker compose up -d / uvicorn / etc.)`,
    `4. Wait for the app to be ready (retry health check for up to 30s)`,
    ``,
    `=== ACCEPTANCE TESTS ===`,
    testList,
    ``,
    `=== EXECUTION ===`,
    `For each test:`,
    `- Run the command`,
    `- Compare output against the expect condition:`,
    `  - "status_code:NNN" → check HTTP status code`,
    `  - "exit_code:N" → check command exit code`,
    `  - "json:.field == value" → check JSON field in response`,
    `  - "contains:text" → check output contains text`,
    `- Record pass/fail with actual vs expected`,
    ``,
    `=== REPORTING ===`,
    `After running all tests, output a structured block:`,
    ``,
    `VALIDATION_RESULT:`,
    `{`,
    `  "workstream": "${workstream.id}",`,
    `  "results": [`,
    `    { "name": "test name", "category": "integration", "status": "pass|fail|skip|error", "actual": "...", "expected": "...", "error": "..." }`,
    `  ]`,
    `}`,
    ``,
    `Then shut down any processes you started.`,
  ].join("\n");
}
