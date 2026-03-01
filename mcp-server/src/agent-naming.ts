// ── Agent Naming ──────────────────────────────────────────────────────
// Agent type/name resolution for managers and workers.

import type { WorkerRole } from "./swarm-types.js";
import { getModelProvider } from "./model-registry.js";

export function getManagerAgentName(modelId: string): string {
  const provider = getModelProvider(modelId);
  switch (provider) {
    case "anthropic":
      return "manager-anthropic";
    case "openai":
      return "manager-openai";
    case "google":
      return "manager-gemini";
    default:
      return "manager-anthropic";
  }
}

export function getWorkerAgentName(modelId: string): string {
  const provider = getModelProvider(modelId);
  switch (provider) {
    case "anthropic":
      return "worker-anthropic";
    case "openai":
      return "worker-openai";
    case "google":
      return "worker-gemini";
    default:
      return "worker";
  }
}

export function getRoleAgentName(role: WorkerRole, modelId: string): string {
  const roleAgents: Record<WorkerRole, string> = {
    coder: "worker-coder",
    tester: "worker-tester",
    reviewer: "worker",
    security: "worker-security",
    architect: "worker-architect",
    documenter: "worker-documenter",
    debugger: "worker-debugger",
    devops: "worker-devops",
    integration: "worker-integration",
    database: "worker-database",
    auth: "worker-auth",
    "meta-worker": "worker",
  };
  return roleAgents[role] ?? getWorkerAgentName(modelId);
}

export function inferWorkerRole(description: string): WorkerRole {
  const lower = description.toLowerCase();

  if (
    /\btest\b|\bspec\b|\bcoverage\b|\bunit test\b|\bintegration test\b/.test(
      lower,
    )
  )
    return "tester";
  if (/\breview\b|\baudit\b|\bcode review\b|\bquality\b/.test(lower))
    return "reviewer";
  if (
    /\bsecurity\b|\bvulnerab|\bencrypt\b|\bsanitiz|\binjection\b/.test(lower)
  )
    return "security";
  if (/\bauth\b|\bjwt\b|\brbac\b|\boauth\b|\blogin\b|\bsession\b|\bpassword\b|\brole\b/.test(lower))
    return "auth";
  if (
    /\barchitect|\bdesign\b|\bapi contract\b|\bschema\b|\bdata model\b/.test(
      lower,
    )
  )
    return "architect";
  if (/\bdoc\b|\breadme\b|\bchangelog\b|\bcomment\b|\bdiagram\b/.test(lower))
    return "documenter";
  if (
    /\bdebug\b|\broot cause\b|\bbisect\b|\breproducg?\b|\bstack trace\b|\bfix\b.*\bbug\b/.test(
      lower,
    )
  )
    return "debugger";
  if (
    /\bdeploy\b|\bci\/cd\b|\bdocker\b|\bpipeline\b|\binfra\b|\bterraform\b|\bkubernetes\b|\bk8s\b/.test(
      lower,
    )
  )
    return "devops";
  if (
    /\bdatabase\b|\bschema\b|\bmigration\b|\bprisma\b|\bdrizzle\b|\bpostgres\b|\bmongo\b|\bsql\b|\borm\b/.test(
      lower,
    )
  )
    return "database";
  if (
    /\bintegration\b|\bwire\b|\bapi client\b|\bfrontend.backend\b|\bfull.?stack\b/.test(
      lower,
    )
  )
    return "integration";

  return "coder";
}
