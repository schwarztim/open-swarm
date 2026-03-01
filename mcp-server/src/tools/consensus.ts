import {
  getSession,
  createConsensus,
  getConsensus,
  submitProposal,
  evaluateConsensus,
  postToBoard,
} from "../state.js";
import { ok, err, type ToolResult } from "./shared.js";

// ── swarm_consensus ───────────────────────────────────────────────────

export function handleSwarmConsensus(args: {
  sessionId: string;
  action: "start" | "propose" | "evaluate" | "status";
  groupId?: string;
  topic?: string;
  consensusId?: string;
  workstreamId?: string;
  slotId?: string;
  model?: string;
  content?: string;
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  switch (args.action) {
    case "start": {
      if (!args.groupId) return err("groupId required for start action");
      if (!args.topic) return err("topic required for start action");

      const consensus = createConsensus(session, args.groupId, args.topic);

      postToBoard(
        session,
        args.groupId,
        "status",
        `🗳️ Consensus session started: "${args.topic}" (${consensus.id})`,
        "L2",
        args.groupId,
      );

      return ok({
        consensusId: consensus.id,
        groupId: args.groupId,
        topic: args.topic,
        status: "collecting",
        nextAction: [
          `Consensus session "${consensus.id}" created.`,
          `Spawn 2-3 workers in proposal mode (mode="propose") with the topic.`,
          `Each worker submits via swarm_consensus(action="propose", consensusId="${consensus.id}", slotId="proposer-N", content=<proposal>)`,
          `After all proposals are in, call swarm_consensus(action="evaluate", consensusId="${consensus.id}")`,
        ].join("\n"),
      });
    }

    case "propose": {
      if (!args.consensusId)
        return err("consensusId required for propose action");
      if (!args.content) return err("content required for propose action");
      if (!args.slotId) return err("slotId required for propose action");

      const consensus = getConsensus(session, args.consensusId);
      if (!consensus) return err(`Consensus not found: ${args.consensusId}`);
      if (consensus.status !== "collecting")
        return err(`Consensus is ${consensus.status}, not accepting proposals`);

      submitProposal(
        consensus,
        args.workstreamId ?? "unknown",
        args.slotId,
        args.model ?? "unknown",
        args.content,
      );

      return ok({
        consensusId: consensus.id,
        proposalCount: consensus.proposals.length,
        slotId: args.slotId,
        nextAction: `Proposal from ${args.slotId} recorded (${consensus.proposals.length} total). Submit more or call evaluate.`,
      });
    }

    case "evaluate": {
      if (!args.consensusId)
        return err("consensusId required for evaluate action");

      const consensus = getConsensus(session, args.consensusId);
      if (!consensus) return err(`Consensus not found: ${args.consensusId}`);

      const result = evaluateConsensus(consensus);

      postToBoard(
        session,
        consensus.groupId,
        "decision",
        `🗳️ Consensus "${consensus.id}": convergence=${(result.convergenceScore * 100).toFixed(0)}% → ${result.recommendation}`,
        "L2",
        consensus.groupId,
      );

      let nextAction: string;
      if (result.recommendation === "implement-best") {
        const best = consensus.proposals.reduce((a, b) =>
          a.content.length > b.content.length ? a : b,
        );
        consensus.selectedProposal = best.slotId;
        nextAction = [
          `✅ Proposals converged (${(result.convergenceScore * 100).toFixed(0)}%).`,
          `Best proposal: ${best.slotId}. Dispatch that worker in implement mode.`,
        ].join("\n");
      } else if (result.recommendation === "debate") {
        consensus.status = "escalated";
        nextAction = [
          `⚠️ Proposals diverged (${(result.convergenceScore * 100).toFixed(0)}%).`,
          `Escalate to L2 debate protocol: swarm_debate(action="start", topic="${consensus.topic}", trigger="disagreement", groupId="${consensus.groupId}")`,
        ].join("\n");
      } else {
        nextAction = `Need more proposals before evaluation (currently ${consensus.proposals.length}).`;
      }

      return ok({
        consensusId: consensus.id,
        convergenceScore: result.convergenceScore,
        recommendation: result.recommendation,
        proposalCount: consensus.proposals.length,
        selectedProposal: consensus.selectedProposal,
        nextAction,
      });
    }

    case "status": {
      if (!args.consensusId)
        return err("consensusId required for status action");

      const consensus = getConsensus(session, args.consensusId);
      if (!consensus) return err(`Consensus not found: ${args.consensusId}`);

      return ok({
        consensusId: consensus.id,
        groupId: consensus.groupId,
        topic: consensus.topic,
        status: consensus.status,
        proposalCount: consensus.proposals.length,
        convergenceScore: consensus.convergenceScore,
        selectedProposal: consensus.selectedProposal,
        proposals: consensus.proposals.map((p) => ({
          slotId: p.slotId,
          contentPreview:
            p.content.substring(0, 200) + (p.content.length > 200 ? "..." : ""),
        })),
      });
    }

    default:
      return err(`Unknown consensus action: ${args.action}`);
  }
}
