// ── Tier Selection ─────────────────────────────────────────────────────
// Task complexity analysis and tier selection.

import type { Tier, TaskComplexity } from "./swarm-types.js";
import {
  getCoderModel,
  getCriticModel,
  getFastModel,
  premiumPool,
} from "./model-registry.js";

export function analyzeTaskComplexity(task: string): {
  tier: Tier;
  requiresArchitect: boolean;
  requiresIntegration: boolean;
  requiresDatabase: boolean;
  requiresDevops: boolean;
  requiresAuth: boolean;
  estimatedWorkstreams: number;
} {
  const signals = {
    architect: /architect|design|system|microservice|monolith|scale/i.test(task),
    database: /database|schema|migration|prisma|drizzle|postgres|mongo|sql/i.test(task),
    auth: /auth|jwt|rbac|oauth|login|session|password|role/i.test(task),
    integration: /frontend|backend|api|react|next|express|full.?stack/i.test(task),
    devops: /deploy|docker|kubernetes|k8s|ci.?cd|pipeline|terraform/i.test(task),
    testing: /test|coverage|e2e|integration.?test/i.test(task),
  };

  const componentCount = Object.values(signals).filter(Boolean).length;

  return {
    tier: componentCount >= 4 ? "full-swarm" : componentCount >= 2 ? "trio" : "duo",
    requiresArchitect: signals.architect || componentCount >= 3,
    requiresIntegration: signals.integration || componentCount >= 2,
    requiresDatabase: signals.database,
    requiresDevops: signals.devops,
    requiresAuth: signals.auth,
    estimatedWorkstreams: Math.max(2, componentCount * 2),
  };
}

export function selectTier(taskDescription: string, fileCount?: number): Tier {
  const lower = taskDescription.toLowerCase();

  if (fileCount !== undefined && fileCount > 50) return "blitz";
  if (/massive|full app|entire codebase/.test(lower)) return "blitz";

  if (/debate|decide|which approach|tradeoff/.test(lower)) return "debate";

  if (
    /unleashed|max|pedal to the metal|no restraints|hurt|pain|destroy/.test(
      lower,
    )
  )
    return "unleashed";

  if (/refactor|security|architecture|complex/.test(lower)) return "full-swarm";

  if (/design|multi-file|feature/.test(lower)) return "trio";

  // Enterprise task detection: use complexity analysis for multi-component tasks
  const complexity = analyzeTaskComplexity(taskDescription);
  if (complexity.tier !== "duo") return complexity.tier;

  return "duo";
}

export function classifyTaskComplexity(
  description: string,
  files: string[],
): TaskComplexity {
  const lower = description.toLowerCase();

  if (/\breview\b|\baudit\b|\bcheck\b|\binspect\b|\bvalidate\b/.test(lower)) {
    return "review";
  }

  if (
    /\bsecurity\b|\bvulnerab|\barchitect|\bdesign\b|\bscalabil|\bperformance\b|\bmigrat|\brefactor\b/.test(
      lower,
    )
  ) {
    return "complex";
  }

  if (files.length > 5) {
    return "complex";
  }

  if (
    /\bdoc\b|\breadme\b|\bcomment\b|\brename\b|\bconfig\b|\bformat\b|\btypo\b|\bfix\s+typo\b/.test(
      lower,
    )
  ) {
    return "trivial";
  }

  return "standard";
}

export function getModelForComplexity(
  complexity: TaskComplexity,
  index: number,
): string {
  switch (complexity) {
    case "trivial":
      return getFastModel(index);
    case "standard":
      return getCoderModel(index);
    case "complex":
      return premiumPool.length > 0
        ? premiumPool[index % premiumPool.length]
        : getCoderModel(index);
    case "review":
      return getCriticModel(index);
  }
}
