#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  handleSwarmInit,
  handleSwarmNext,
  handleSwarmSubmit,
  handleSwarmMerge,
  handleSwarmStatus,
  handleSwarmGate,
  handleSwarmModels,
  handleSwarmCollect,
  handleSwarmRelay,
  handleSwarmBoard,
  handleSwarmDispatch,
  handleSwarmThrottle,
  handleSwarmDebate,
  handleSwarmClaim,
  handleSwarmMemory,
  handleSwarmConsensus,
  handleSwarmLearn,
  handleSwarmWatch,
  handleSwarmWorker,
  handleSwarmValidate,
  handleSwarmEvents,
} from "./tools.js";
import { memoryStore } from "./memory.js";
import { cleanupStaleSessions } from "./state.js";
import { initEventStore } from "./event-store.js";

const server = new Server(
  { name: "open-swarm-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: "swarm_init",
    description:
      "Initialize a swarm session. Auto-selects tier or accepts explicit tier. Returns session ID and first phase.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task: {
          type: "string",
          description: "Description of the task to swarm on",
        },
        tier: {
          type: "string",
          enum: ["duo", "trio", "full-swarm", "blitz", "debate", "unleashed"],
          description: "Swarm tier (auto-selected if omitted)",
        },
        fileCount: {
          type: "number",
          description:
            "Approximate number of files involved (helps tier selection)",
        },
        concurrency: {
          type: "string",
          description:
            'Rate limit preset name ("conservative", "standard", "aggressive", "max", "unlimited") OR a number for custom concurrency. Default: "standard" (3 concurrent L2 managers). Controls how many L2 managers run simultaneously.',
        },
      },
      required: ["task"],
    },
  },
  {
    name: "swarm_next",
    description:
      "Get the next step to execute. Returns exact task() call parameters.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
        workstreamIndex: {
          type: "number",
          description: "Index of specific workstream (for parallel phases)",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "swarm_submit",
    description:
      "Submit completed step output. Validates phase state and advances when all outputs collected.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
        phaseIndex: {
          type: "number",
          description: "Phase index (defaults to current)",
        },
        output: {
          type: "string",
          description: "The output from the completed task",
        },
        agentId: {
          type: "string",
          description: "Agent ID that produced the output",
        },
      },
      required: ["sessionId", "output"],
    },
  },
  {
    name: "swarm_merge",
    description:
      "Merge parallel outputs into a single result. Returns task() call for merge agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
        outputs: {
          type: "array",
          items: { type: "string" },
          description: "Array of outputs from parallel workstreams to merge",
        },
      },
      required: ["sessionId", "outputs"],
    },
  },
  {
    name: "swarm_status",
    description:
      "Get current swarm state including phases, scores, workstreams, and next action.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "swarm_gate",
    description:
      "Evaluate quality gate. Submit scores per workstream, returns proceed or retry with instructions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
        scores: {
          type: "array",
          items: {
            type: "object",
            properties: {
              workstream: { type: "string", description: "Workstream ID" },
              score: { type: "number", description: "Quality score (0-10)" },
              criticalIssues: {
                type: "number",
                description: "Number of critical issues found",
              },
            },
            required: ["workstream", "score", "criticalIssues"],
          },
          description: "Array of quality scores per workstream",
        },
      },
      required: ["sessionId", "scores"],
    },
  },
  {
    name: "swarm_collect",
    description:
      "Collect outputs from subprocess workstreams. Only for subprocess execution mode. Batch-submits all outputs and advances phase.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
        outputs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              workstream: {
                type: "string",
                description: "Workstream ID (e.g. ws-0)",
              },
              output: {
                type: "string",
                description: "The collected output text from the subprocess",
              },
            },
            required: ["workstream", "output"],
          },
          description:
            "Array of workstream outputs collected from subprocess files",
        },
      },
      required: ["sessionId", "outputs"],
    },
  },
  {
    name: "swarm_models",
    description:
      "List or set available models for swarm orchestration. Models are auto-categorized into pools (premium, coder, critic, fast) by tier and provider.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["list", "set"],
          description: "Action to perform (default: list)",
        },
        models: {
          type: "array",
          items: { type: "string" },
          description:
            "Model IDs to set as available (only used with action=set)",
        },
      },
    },
  },
  {
    name: "swarm_relay",
    description:
      'Post findings from a completed workstream or manager group to the shared board. The orchestrator uses this to relay discoveries between L2 managers. Board context is automatically injected into subsequent swarm_next prompts. Use type="blocker" to flag issues, type="plan" for L2 plans, type="report" for L2 manager reports.',
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
        workstream: {
          type: "string",
          description:
            "Workstream or group ID that produced the finding (e.g. ws-0 or group-0)",
        },
        type: {
          type: "string",
          enum: ["finding", "blocker", "decision", "status", "plan", "report"],
          description:
            'Message type. "blocker" halts work. "plan" for L2 manager plans. "report" for L2 final reports.',
        },
        level: {
          type: "string",
          enum: ["L1", "L2", "L3"],
          description: "Hierarchy level of the sender (default: L1)",
        },
        group: {
          type: "string",
          description:
            "Agent group ID if message is from/about a specific L2 group",
        },
        content: {
          type: "string",
          description:
            "The finding, blocker, plan, report, or decision content",
        },
      },
      required: ["sessionId", "workstream", "content"],
    },
  },
  {
    name: "swarm_board",
    description:
      "Read the shared message board. Shows findings, blockers, decisions, plans, and L2 manager reports. Shows hierarchy status (L1/L2/L3 messages). The orchestrator reads this to make informed decisions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
        workstream: {
          type: "string",
          description:
            "Filter: exclude messages from this workstream (for anonymous reading)",
        },
        types: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "finding",
              "blocker",
              "decision",
              "status",
              "plan",
              "report",
            ],
          },
          description: "Filter by message types",
        },
        level: {
          type: "string",
          enum: ["L1", "L2", "L3"],
          description: "Filter by hierarchy level",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "swarm_dispatch",
    description:
      "Resolve a promptRef into full task() call parameters with model fallback. If the assigned model is unavailable, auto-resolves to the nearest alternative. Returns { subagent_type, description, prompt, model } ready to pass to task().",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
        promptRef: {
          type: "string",
          description: "The promptRef from a taskCall returned by swarm_next",
        },
        subagent_type: {
          type: "string",
          description: "The subagent_type from the taskCall",
        },
        description: {
          type: "string",
          description: "The description from the taskCall",
        },
        model: {
          type: "string",
          description:
            "Model ID from the managerCall. Will be resolved through fallback if unavailable.",
        },
      },
      required: ["sessionId", "promptRef", "subagent_type", "description"],
    },
  },
  {
    name: "swarm_throttle",
    description:
      "Adjust rate limiting on a live session. Use preset names or a custom number. Returns current rate config and available presets.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
        concurrency: {
          type: "string",
          description:
            'Preset name ("conservative", "standard", "aggressive", "max", "unlimited") or a number. Omit to just view current config.',
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "swarm_debate",
    description:
      "Start, advance, submit to, evaluate, validate, and resolve structured debates. Works at L1 (top-level) or L2 (manager-level worker debates). Implements multi-round position→critique→rebuttal cycles with convergence tracking, sycophancy detection, partial consensus, fast-track, devil's advocate, and post-implementation validation. Based on Agent-Skills multi-agent-patterns.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
        action: {
          type: "string",
          enum: [
            "start",
            "next",
            "submit",
            "evaluate",
            "synthesize",
            "status",
            "escalate",
            "validate",
          ],
          description:
            "Action: start=create debate, next=get phase prompts, submit=add contribution, evaluate=score+convergence+fast-track+contrarian, synthesize=produce final decision, status=check state, escalate=send to parent level, validate=post-implementation validation checkpoint",
        },
        topic: {
          type: "string",
          description: 'What to debate (for action="start")',
        },
        trigger: {
          type: "string",
          enum: ["explicit", "disagreement", "quality-split", "l1-directive"],
          description: 'Why the debate is being initiated (for action="start")',
        },
        groupId: {
          type: "string",
          description:
            "L2 agent group running the debate (omit for L1-level debates)",
        },
        participantCount: {
          type: "number",
          description: "Number of debaters (default: 2, max: 5)",
        },
        maxRounds: {
          type: "number",
          description:
            "Max debate rounds before forced escalation (default: 3)",
        },
        debateId: {
          type: "string",
          description: 'Debate ID (returned by action="start")',
        },
        slotId: {
          type: "string",
          description:
            'Participant slot ID "debater-0", etc. (for action="submit")',
        },
        content: {
          type: "string",
          description:
            'Position, critique, or rebuttal content (for action="submit")',
        },
        synthesis: {
          type: "string",
          description: 'Final synthesized position (for action="synthesize")',
        },
        validationOutcome: {
          type: "string",
          enum: ["confirmed", "failed", "partial"],
          description:
            'Post-implementation validation result (for action="validate"). "failed" or "partial" reopens the debate with findings.',
        },
        validationFindings: {
          type: "array",
          items: { type: "string" },
          description:
            'What was discovered during post-implementation validation (for action="validate")',
        },
      },
      required: ["sessionId", "action"],
    },
  },
  {
    name: "swarm_claim",
    description:
      "Manage file ownership claims. Workers claim files before editing, preventing conflicts. Actions: claim (reserve files), release (free files), check (see who owns files), list (all active claims).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
        action: {
          type: "string",
          enum: ["claim", "release", "check", "list"],
          description:
            "Action: claim=reserve files, release=free files, check=who owns files, list=all active claims",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "File paths to claim/release/check",
        },
        workstreamId: {
          type: "string",
          description: "Workstream ID claiming the files",
        },
        groupId: { type: "string", description: "Agent group ID" },
      },
      required: ["sessionId", "action"],
    },
  },
  {
    name: "swarm_memory",
    description:
      "Store and retrieve successful patterns from prior tasks. Workers search before starting and store after succeeding. Actions: search (find relevant patterns), store (save a new pattern), list (view all patterns).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
        action: {
          type: "string",
          enum: ["search", "store", "list"],
          description:
            "Action: search=find patterns, store=save a new pattern, list=view all",
        },
        query: {
          type: "string",
          description:
            'Search query for finding relevant patterns (for action="search")',
        },
        taskType: {
          type: "string",
          description:
            'Task type label, e.g. "auth-implementation" (for action="store")',
        },
        approach: {
          type: "string",
          description: 'Description of the approach used (for action="store")',
        },
        filesInvolved: {
          type: "array",
          items: { type: "string" },
          description: 'Files touched (for action="store")',
        },
        qualityScore: {
          type: "number",
          description:
            'Quality score from gate (must be ≥8 to store) (for action="store")',
        },
        keyDecisions: {
          type: "array",
          items: { type: "string" },
          description: 'Key decisions made (for action="store")',
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: 'Searchable tags (for action="store")',
        },
        limit: {
          type: "number",
          description:
            'Max results to return (for action="search", default: 5)',
        },
      },
      required: ["sessionId", "action"],
    },
  },
  {
    name: "swarm_consensus",
    description:
      "Lightweight worker consensus for complex tasks. L2 managers spawn multiple workers in proposal mode, collect proposals, then evaluate convergence. If proposals converge, best-scored implements. If diverged, escalate to L2 debate. Actions: start (create consensus session), propose (submit a proposal), evaluate (check convergence and decide), status (view state).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
        action: {
          type: "string",
          enum: ["start", "propose", "evaluate", "status"],
          description:
            "Action: start=create session, propose=submit proposal, evaluate=check convergence, status=view state",
        },
        groupId: {
          type: "string",
          description: 'Agent group running the consensus (for action="start")',
        },
        topic: {
          type: "string",
          description: 'What to reach consensus on (for action="start")',
        },
        consensusId: {
          type: "string",
          description: 'Consensus session ID (returned by action="start")',
        },
        workstreamId: {
          type: "string",
          description: 'Workstream submitting proposal (for action="propose")',
        },
        slotId: {
          type: "string",
          description:
            'Proposer slot ID "proposer-0" etc. (for action="propose")',
        },
        model: {
          type: "string",
          description:
            'Model that generated the proposal (for action="propose")',
        },
        content: {
          type: "string",
          description: 'Proposal content (for action="propose")',
        },
      },
      required: ["sessionId", "action"],
    },
  },
  {
    name: "swarm_learn",
    description:
      "Self-learning loop. Retrieve relevant patterns, judge outcomes, distill new patterns from successful sessions, consolidate pattern store, route model recommendations, or get learning stats.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
        action: {
          type: "string",
          enum: [
            "retrieve",
            "judge",
            "distill",
            "consolidate",
            "route",
            "stats",
          ],
          description:
            "Action: retrieve=semantic pattern search, judge=record outcome, distill=extract pattern, consolidate=merge/prune, route=model recommendation, stats=learning metrics",
        },
        taskDescription: {
          type: "string",
          description:
            "Task description for retrieve/route (defaults to session task)",
        },
        scores: {
          type: "array",
          items: {
            type: "object",
            properties: {
              workstream: { type: "string" },
              score: { type: "number" },
              criticalIssues: { type: "number" },
            },
            required: ["workstream", "score", "criticalIssues"],
          },
          description: "Quality scores for judge action",
        },
        metadata: {
          type: "object",
          properties: {
            modelUsed: { type: "string" },
            durationMs: { type: "number" },
            whatWorked: { type: "array", items: { type: "string" } },
            whatFailed: { type: "array", items: { type: "string" } },
          },
          description: "Optional metadata for judge action",
        },
      },
      required: ["sessionId", "action"],
    },
  },
  {
    name: "swarm_watch",
    description:
      "Subscribe background workers to trigger events. Workers auto-fire on gate pass/fail or session end. Actions: subscribe (register worker), list (view subscriptions), check (see which workers would fire).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
        action: {
          type: "string",
          enum: ["subscribe", "list", "check"],
          description:
            "Action: subscribe=register worker, list=view subscriptions, check=see ready workers",
        },
        workerType: {
          type: "string",
          enum: ["audit", "optimize", "testgaps", "document"],
          description: "Worker type to subscribe",
        },
        triggerEvent: {
          type: "string",
          enum: ["gate_pass", "gate_fail", "session_end", "manual"],
          description: "Event that triggers the worker",
        },
      },
      required: ["sessionId", "action"],
    },
  },
  {
    name: "swarm_worker",
    description:
      "Manually dispatch background workers and retrieve results. Workers analyze code for security, performance, test gaps, or documentation. Actions: dispatch (start worker), status (check all workers), results (get findings), complete (record worker output).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
        action: {
          type: "string",
          enum: ["dispatch", "status", "results", "complete"],
          description:
            "Action: dispatch=start worker, status=check workers, results=get findings, complete=record output",
        },
        workerType: {
          type: "string",
          enum: ["audit", "optimize", "testgaps", "document"],
          description: "Worker type to dispatch",
        },
        workerId: {
          type: "string",
          description: "Worker ID (for results/complete)",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Files for the worker to analyze",
        },
        context: {
          type: "string",
          description: "Additional context for the worker",
        },
        findings: {
          type: "array",
          items: { type: "string" },
          description: "Worker findings (for complete action)",
        },
      },
      required: ["sessionId", "action"],
    },
  },
  {
    name: "swarm_validate",
    description:
      "Submit structured validation/test results for a workstream. Used by verifier agents to report acceptance test outcomes. Results are stored on the session and evaluated by the validate-gate phase.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
        workstream: {
          type: "string",
          description: "Workstream ID being validated",
        },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Test name" },
              category: {
                type: "string",
                enum: ["static", "unit", "integration"],
                description: "Test category",
              },
              status: {
                type: "string",
                enum: ["pass", "fail", "skip", "error"],
                description: "Test result status",
              },
              actual: {
                type: "string",
                description: "Actual result observed",
              },
              expected: { type: "string", description: "Expected result" },
              error: {
                type: "string",
                description: "Error message if status is error",
              },
            },
            required: ["name", "category", "status"],
          },
          description: "Array of test results",
        },
      },
      required: ["sessionId", "workstream", "results"],
    },
  },
  {
    name: "swarm_events",
    description:
      "Query the immutable event log for a swarm session. Returns all state mutation events in order, optionally filtered by event type or sequence number. Useful for debugging, auditing, and replaying session history.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Swarm session ID" },
        eventType: {
          type: "string",
          description: "Filter by event type (e.g. 'gate.passed', 'phase.advanced')",
        },
        after: {
          type: "number",
          description: "Return only events with sequence number greater than this value",
        },
        limit: {
          type: "number",
          description: "Maximum number of events to return (default: 50)",
        },
      },
      required: ["sessionId"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  try {
    switch (request.params.name) {
    case "swarm_init":
      return handleSwarmInit(args as Parameters<typeof handleSwarmInit>[0]);
    case "swarm_next":
      return handleSwarmNext(args as Parameters<typeof handleSwarmNext>[0]);
    case "swarm_submit":
      return handleSwarmSubmit(args as Parameters<typeof handleSwarmSubmit>[0]);
    case "swarm_merge":
      return handleSwarmMerge(args as Parameters<typeof handleSwarmMerge>[0]);
    case "swarm_status":
      return handleSwarmStatus(args as Parameters<typeof handleSwarmStatus>[0]);
    case "swarm_gate":
      return handleSwarmGate(args as Parameters<typeof handleSwarmGate>[0]);
    case "swarm_collect":
      return handleSwarmCollect(
        args as Parameters<typeof handleSwarmCollect>[0],
      );
    case "swarm_models":
      return handleSwarmModels(args as Parameters<typeof handleSwarmModels>[0]);
    case "swarm_relay":
      return handleSwarmRelay(args as Parameters<typeof handleSwarmRelay>[0]);
    case "swarm_board":
      return handleSwarmBoard(args as Parameters<typeof handleSwarmBoard>[0]);
    case "swarm_dispatch":
      return handleSwarmDispatch(
        args as Parameters<typeof handleSwarmDispatch>[0],
      );
    case "swarm_throttle":
      return handleSwarmThrottle(
        args as Parameters<typeof handleSwarmThrottle>[0],
      );
    case "swarm_debate":
      return handleSwarmDebate(args as Parameters<typeof handleSwarmDebate>[0]);
    case "swarm_claim":
      return handleSwarmClaim(args as Parameters<typeof handleSwarmClaim>[0]);
    case "swarm_memory":
      return handleSwarmMemory(args as Parameters<typeof handleSwarmMemory>[0]);
    case "swarm_consensus":
      return handleSwarmConsensus(
        args as Parameters<typeof handleSwarmConsensus>[0],
      );
    case "swarm_learn":
      return handleSwarmLearn(args as Parameters<typeof handleSwarmLearn>[0]);
    case "swarm_watch":
      return handleSwarmWatch(args as Parameters<typeof handleSwarmWatch>[0]);
    case "swarm_worker":
      return handleSwarmWorker(args as Parameters<typeof handleSwarmWorker>[0]);
    case "swarm_validate":
      return handleSwarmValidate(
        args as Parameters<typeof handleSwarmValidate>[0],
      );
    case "swarm_events":
      return handleSwarmEvents(args as Parameters<typeof handleSwarmEvents>[0]);
    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tool-error] ${request.params.name}: ${message}`);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    };
  }
});

const transport = new StdioServerTransport();
await memoryStore.init();
initEventStore();
setInterval(() => cleanupStaleSessions(), 3_600_000);
await server.connect(transport);
console.error("Open Swarm MCP server running on stdio");
