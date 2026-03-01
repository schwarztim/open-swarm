import {
  type RatePreset,
  RATE_PRESETS,
  getSession,
  resolveRateLimit,
  getRateLimitStatus,
  getAvailableModels,
  setAvailableModels,
  getFallbackLog,
  premiumPool,
  coderPool,
  criticPool,
  fastPool,
} from "../state.js";
import { ok, err, type ToolResult } from "./shared.js";

// ── swarm_throttle ────────────────────────────────────────────────────

export function handleSwarmThrottle(args: {
  sessionId: string;
  concurrency?: string;
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  const previousConcurrency = session.concurrency;

  // If concurrency provided, update it
  if (args.concurrency !== undefined && args.concurrency !== null) {
    if (
      typeof args.concurrency === "string" &&
      args.concurrency in RATE_PRESETS
    ) {
      session.concurrency = resolveRateLimit(args.concurrency as RatePreset);
    } else {
      const num = Number(args.concurrency);
      if (!isNaN(num) && num >= 0) {
        session.concurrency = num;
      } else {
        return err(
          `Invalid concurrency: "${args.concurrency}". Use a preset name (${Object.keys(RATE_PRESETS).join(", ")}) or a number >= 0.`,
        );
      }
    }
  }

  // Find matching preset
  const matchedPreset = Object.entries(RATE_PRESETS).find(
    ([_, v]) => v.concurrency === session.concurrency,
  );

  // Count in-flight groups
  const inFlight = session.agentGroups.filter(
    (g) => g.status === "dispatched",
  ).length;
  const completed = session.agentGroups.filter(
    (g) => g.status === "done",
  ).length;
  const pending = session.agentGroups.filter(
    (g) => g.status === "pending",
  ).length;

  return ok({
    previous: previousConcurrency! > 0 ? previousConcurrency : "unlimited",
    current: session.concurrency! > 0 ? session.concurrency : "unlimited",
    changed: args.concurrency !== undefined,
    preset: matchedPreset ? matchedPreset[0] : "custom",
    description: matchedPreset
      ? matchedPreset[1].description
      : `Custom: ${session.concurrency} concurrent L2 managers`,
    groupStatus: {
      total: session.agentGroups.length,
      inFlight,
      completed,
      pending,
    },
    availablePresets: Object.fromEntries(
      Object.entries(RATE_PRESETS).map(([k, v]) => [
        k,
        {
          concurrency: v.concurrency || "unlimited",
          estimatedAgents: v.maxAgents === Infinity ? "unlimited" : v.maxAgents,
          plan: v.plan,
          description: v.description,
        },
      ]),
    ),
    apiRateLimits: getRateLimitStatus(session.id),
  });
}

// ── swarm_models ──────────────────────────────────────────────────────

export function handleSwarmModels(args: {
  action?: "list" | "set";
  models?: string[];
}): ToolResult {
  const action = args.action ?? "list";

  if (action === "set" && args.models && args.models.length > 0) {
    setAvailableModels(args.models);
    const fallbacks = getFallbackLog();
    return ok({
      action: "set",
      accepted: getAvailableModels().map((m) => m.id),
      ignored: args.models.filter(
        (id) => !getAvailableModels().some((m) => m.id === id),
      ),
      pools: {
        premium: [...premiumPool],
        coder: [...coderPool],
        critic: [...criticPool],
        fast: [...fastPool],
      },
      fallbackSystem:
        "active — models not in accepted list will auto-resolve to nearest available alternative",
      message: `Model pools updated. ${getAvailableModels().length} models active.`,
    });
  }

  return ok({
    action: "list",
    available: getAvailableModels().map((m) => ({
      id: m.id,
      tier: m.tier,
      provider: m.provider,
    })),
    pools: {
      premium: [...premiumPool],
      coder: [...coderPool],
      critic: [...criticPool],
      fast: [...fastPool],
    },
    recentFallbacks: getFallbackLog()
      .slice(-10)
      .map((f) => `${f.from} → ${f.to}`),
    total: getAvailableModels().length,
  });
}
