// ── Phase Definitions per Tier ─────────────────────────────────────────
// Defines the execution phases for each swarm tier.

import {
  getCoderModel,
  getCriticModel,
  getArchitectModel,
  getFastModel,
  getSynthesizerModel,
} from "./model-registry.js";
import type { Tier, PhaseDefinition, SwarmSession, PhaseState } from "./swarm-types.js";
import { appendEvent, SwarmEventType } from "./event-store.js";

function def(
  name: string,
  agentType: string,
  model: string,
  mode: "sync" | "background",
  parallel: boolean,
  requiresMerge: boolean,
  isGate: boolean,
): PhaseDefinition {
  return { name, agentType, model, mode, parallel, requiresMerge, isGate };
}

export const TIER_PHASES: Record<Tier, PhaseDefinition[]> = {
  duo: [
    def(
      "implement",
      "clean-code",
      getCoderModel(0),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "review",
      "code-review",
      getCriticModel(0),
      "sync",
      false,
      false,
      false,
    ),
    def("gate", "task", "", "sync", false, false, true),
  ],
  trio: [
    def(
      "design",
      "architect",
      getArchitectModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "architect",
      "worker-architect",
      getArchitectModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "implement",
      "clean-code",
      getCoderModel(0),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "review",
      "code-review",
      getCriticModel(0),
      "sync",
      false,
      false,
      false,
    ),
    def("gate", "task", "", "sync", false, false, true),
    def("validate-static", "task", getFastModel(), "sync", false, false, false),
    def(
      "validate-integration",
      "task",
      getCriticModel(0),
      "background",
      true,
      false,
      false,
    ),
    {
      ...def("validate-gate", "task", "", "sync", false, false, true),
      isValidationGate: true,
    },
  ],
  "full-swarm": [
    def("explore", "explore", getFastModel(), "background", true, true, false),
    def(
      "merge_explore",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "architect",
      "worker-architect",
      getArchitectModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "design",
      "architect",
      getArchitectModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "implement",
      "clean-code",
      getCoderModel(0),
      "background",
      true,
      true,
      false,
    ),
    def(
      "security",
      "worker-security",
      getCriticModel(0),
      "background",
      true,
      false,
      false,
    ),
    def(
      "merge_impl",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "integration",
      "worker-integration",
      getCoderModel(0),
      "background",
      true,
      true,
      false,
    ),
    def(
      "merge_integration",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "review",
      "code-review",
      getCriticModel(0),
      "background",
      true,
      false,
      false,
    ),
    def("gate", "task", "", "sync", false, false, true),
    def("validate-static", "task", getFastModel(), "sync", false, false, false),
    def(
      "validate-integration",
      "task",
      getCriticModel(0),
      "background",
      true,
      false,
      false,
    ),
    {
      ...def("validate-gate", "task", "", "sync", false, false, true),
      isValidationGate: true,
    },
    def(
      "document",
      "worker-documenter",
      getFastModel(),
      "background",
      true,
      false,
      false,
    ),
    def(
      "devops",
      "worker-devops",
      getCoderModel(0),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "synthesize",
      "architect",
      getSynthesizerModel(),
      "sync",
      false,
      false,
      false,
    ),
  ],
  blitz: [
    def("recon", "explore", getFastModel(), "background", true, true, false),
    def(
      "merge_recon",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "triage",
      "architect",
      getArchitectModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "architect",
      "worker-architect",
      getArchitectModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "build",
      "clean-code",
      getCoderModel(0),
      "background",
      true,
      true,
      false,
    ),
    def(
      "merge_build",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "review",
      "code-review",
      getCriticModel(0),
      "background",
      true,
      true,
      false,
    ),
    def(
      "merge_review",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def("gate", "task", "", "sync", false, false, true),
    def("validate-static", "task", getFastModel(), "sync", false, false, false),
    def(
      "validate-integration",
      "task",
      getCriticModel(0),
      "background",
      true,
      false,
      false,
    ),
    {
      ...def("validate-gate", "task", "", "sync", false, false, true),
      isValidationGate: true,
    },
    def(
      "synthesize",
      "architect",
      getSynthesizerModel(),
      "sync",
      false,
      false,
      false,
    ),
  ],
  debate: [
    def(
      "propose",
      "architect",
      getArchitectModel(),
      "background",
      true,
      false,
      false,
    ),
    def(
      "critique",
      "code-review",
      getCriticModel(0),
      "background",
      true,
      false,
      false,
    ),
    def(
      "rebuttal",
      "architect",
      getArchitectModel(),
      "background",
      true,
      false,
      false,
    ),
    def(
      "merge_debate",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "synthesize",
      "architect",
      getSynthesizerModel(),
      "sync",
      false,
      false,
      false,
    ),
  ],
  unleashed: [
    def("recon", "explore", getFastModel(), "background", true, true, false),
    def(
      "merge_recon",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "triage",
      "architect",
      getArchitectModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "architect",
      "worker-architect",
      getArchitectModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "build",
      "clean-code",
      getCoderModel(0),
      "background",
      true,
      true,
      false,
    ),
    def(
      "security",
      "worker-security",
      getCriticModel(0),
      "background",
      true,
      false,
      false,
    ),
    def(
      "merge_build",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "integration",
      "worker-integration",
      getCoderModel(0),
      "background",
      true,
      true,
      false,
    ),
    def(
      "merge_integration",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "review",
      "code-review",
      getCriticModel(0),
      "background",
      true,
      true,
      false,
    ),
    def(
      "merge_review",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def("gate", "task", "", "sync", false, false, true),
    def("validate-static", "task", getFastModel(), "sync", false, false, false),
    def(
      "validate-integration",
      "task",
      getCriticModel(0),
      "background",
      true,
      false,
      false,
    ),
    {
      ...def("validate-gate", "task", "", "sync", false, false, true),
      isValidationGate: true,
    },
    def(
      "document",
      "worker-documenter",
      getFastModel(),
      "background",
      true,
      false,
      false,
    ),
    def(
      "devops",
      "worker-devops",
      getCoderModel(0),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "synthesize",
      "architect",
      getSynthesizerModel(),
      "sync",
      false,
      false,
      false,
    ),
  ],
};

export function getPhaseDefinition(
  session: SwarmSession,
  phaseIndex?: number,
): PhaseDefinition {
  const idx = phaseIndex ?? session.currentPhaseIndex;
  return TIER_PHASES[session.tier][idx];
}

// ── Phase Transition Validation ────────────────────────────────────────

export function advancePhase(session: SwarmSession): PhaseState {
  const currentIndex = session.currentPhaseIndex;
  const currentPhase = session.phases[currentIndex];
  const currentDef = TIER_PHASES[session.tier][currentIndex];

  if (currentPhase.status !== "done") {
    throw new Error(
      `Cannot advance: phase "${currentPhase.name}" is "${currentPhase.status}", expected "done".`,
    );
  }

  if (currentDef.requiresMerge) {
    const nextIndex = currentIndex + 1;
    if (nextIndex < session.phases.length) {
      const nextPhase = session.phases[nextIndex];
      const nextDef = TIER_PHASES[session.tier][nextIndex];
      if (nextDef.name.startsWith("merge_") && nextPhase.status !== "done") {
        throw new Error(
          `Cannot advance past "${currentPhase.name}": merge phase "${nextDef.name}" has not completed.`,
        );
      }
    }
  }

  if (currentDef.isGate) {
    const failedWorkstreams = session.workstreams.filter(
      (ws) => ws.score !== undefined && ws.score < 7,
    );
    if (failedWorkstreams.length > 0) {
      const details = failedWorkstreams
        .map((ws) => `${ws.id} (score: ${ws.score})`)
        .join(", ");
      throw new Error(
        `Gate failed: workstreams below threshold (≥7 required): ${details}`,
      );
    }
    const unscoredWorkstreams = session.workstreams.filter(
      (ws) => ws.score === undefined,
    );
    if (session.workstreams.length > 0 && unscoredWorkstreams.length > 0) {
      throw new Error(
        `Gate incomplete: workstreams without scores: ${unscoredWorkstreams.map((ws) => ws.id).join(", ")}`,
      );
    }
  }

  const nextIndex = currentIndex + 1;
  if (nextIndex >= session.phases.length) {
    throw new Error(
      `Cannot advance: "${currentPhase.name}" is the final phase of tier "${session.tier}".`,
    );
  }

  session.currentPhaseIndex = nextIndex;
  try {
    appendEvent(session.id, SwarmEventType.PHASE_ADVANCED, {
      oldPhase: currentPhase.name,
      oldIndex: currentIndex,
      newPhase: session.phases[nextIndex].name,
      newIndex: nextIndex,
    });
  } catch { /* event store is best-effort */ }
  return session.phases[nextIndex];
}
