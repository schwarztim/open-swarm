import {
  getSession,
  claimFiles,
  releaseFiles,
  checkFileClaims,
  getClaimsForWorkstream,
  getAllActiveClaims,
  postToBoard,
} from "../state.js";
import { ok, err, type ToolResult } from "./shared.js";
import { appendEvent, SwarmEventType } from "../event-store.js";

// ── swarm_claim ───────────────────────────────────────────────────────

export function handleSwarmClaim(args: {
  sessionId: string;
  action: "claim" | "release" | "check" | "list";
  paths?: string[];
  workstreamId?: string;
  groupId?: string;
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  switch (args.action) {
    case "claim": {
      if (!args.paths || args.paths.length === 0)
        return err("paths required for claim action");
      if (!args.workstreamId)
        return err("workstreamId required for claim action");
      if (!args.groupId) return err("groupId required for claim action");

      const result = claimFiles(
        session,
        args.paths,
        args.workstreamId,
        args.groupId,
      );

      if (result.conflicts.length > 0) {
        postToBoard(
          session,
          args.workstreamId,
          "finding",
          `⚠️ File claim conflicts: ${result.conflicts.map((c) => `${c.path} (owned by ${c.owner})`).join(", ")}`,
          "L3",
          args.groupId,
        );
      }

      try {
        appendEvent(args.sessionId, SwarmEventType.CLAIM_ACQUIRED, {
          paths: result.claimed,
          workstreamId: args.workstreamId,
          groupId: args.groupId,
          conflicts: result.conflicts.length,
        });
      } catch { /* event store is best-effort */ }

      return ok({
        claimed: result.claimed,
        conflicts: result.conflicts,
        totalActiveClaims: getAllActiveClaims(session).length,
        nextAction:
          result.conflicts.length > 0
            ? `⚠️ ${result.conflicts.length} file(s) already claimed by other workstreams. Coordinate with the owners or ask your L2 manager to resolve.`
            : `✅ ${result.claimed.length} file(s) claimed for ${args.workstreamId}.`,
      });
    }

    case "release": {
      if (!args.paths || args.paths.length === 0)
        return err("paths required for release action");
      if (!args.workstreamId)
        return err("workstreamId required for release action");

      const released = releaseFiles(session, args.paths, args.workstreamId);

      try {
        appendEvent(args.sessionId, SwarmEventType.CLAIM_RELEASED, {
          paths: released,
          workstreamId: args.workstreamId,
        });
      } catch { /* event store is best-effort */ }

      return ok({
        released,
        nextAction: `✅ ${released.length} file(s) released by ${args.workstreamId}.`,
      });
    }

    case "check": {
      if (!args.paths || args.paths.length === 0)
        return err("paths required for check action");

      const claims = checkFileClaims(session, args.paths);
      return ok({
        claims,
        unclaimed: args.paths.filter((p) => !claims.find((c) => c.path === p)),
        nextAction:
          claims.length > 0
            ? `${claims.length} file(s) are claimed: ${claims.map((c) => `${c.path} → ${c.claimedBy}`).join(", ")}`
            : `All ${args.paths.length} file(s) are unclaimed and available.`,
      });
    }

    case "list": {
      const claims = getAllActiveClaims(session);
      const byGroup = new Map<string, typeof claims>();
      for (const c of claims) {
        const arr = byGroup.get(c.groupId) ?? [];
        arr.push(c);
        byGroup.set(c.groupId, arr);
      }

      return ok({
        totalClaims: claims.length,
        byGroup: Object.fromEntries(byGroup),
        nextAction: `${claims.length} active file claim(s) across ${byGroup.size} group(s).`,
      });
    }

    default:
      return err(`Unknown claim action: ${args.action}`);
  }
}
