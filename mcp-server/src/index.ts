#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
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
} from './tools.js';

const server = new Server(
  { name: 'open-swarm-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: 'swarm_init',
    description: 'Initialize a swarm session. Auto-selects tier or accepts explicit tier. Returns session ID and first phase.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task: { type: 'string', description: 'Description of the task to swarm on' },
        tier: { type: 'string', enum: ['duo', 'trio', 'full-swarm', 'blitz', 'debate', 'unleashed'], description: 'Swarm tier (auto-selected if omitted)' },
        fileCount: { type: 'number', description: 'Approximate number of files involved (helps tier selection)' },
      },
      required: ['task'],
    },
  },
  {
    name: 'swarm_next',
    description: 'Get the next step to execute. Returns exact task() call parameters.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Swarm session ID' },
        workstreamIndex: { type: 'number', description: 'Index of specific workstream (for parallel phases)' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'swarm_submit',
    description: 'Submit completed step output. Validates phase state and advances when all outputs collected.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Swarm session ID' },
        phaseIndex: { type: 'number', description: 'Phase index (defaults to current)' },
        output: { type: 'string', description: 'The output from the completed task' },
        agentId: { type: 'string', description: 'Agent ID that produced the output' },
      },
      required: ['sessionId', 'output'],
    },
  },
  {
    name: 'swarm_merge',
    description: 'Merge parallel outputs into a single result. Returns task() call for merge agent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Swarm session ID' },
        outputs: { type: 'array', items: { type: 'string' }, description: 'Array of outputs from parallel workstreams to merge' },
      },
      required: ['sessionId', 'outputs'],
    },
  },
  {
    name: 'swarm_status',
    description: 'Get current swarm state including phases, scores, workstreams, and next action.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Swarm session ID' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'swarm_gate',
    description: 'Evaluate quality gate. Submit scores per workstream, returns proceed or retry with instructions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Swarm session ID' },
        scores: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              workstream: { type: 'string', description: 'Workstream ID' },
              score: { type: 'number', description: 'Quality score (0-10)' },
              criticalIssues: { type: 'number', description: 'Number of critical issues found' },
            },
            required: ['workstream', 'score', 'criticalIssues'],
          },
          description: 'Array of quality scores per workstream',
        },
      },
      required: ['sessionId', 'scores'],
    },
  },
  {
    name: 'swarm_collect',
    description: 'Collect outputs from subprocess workstreams. Only for subprocess execution mode. Batch-submits all outputs and advances phase.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Swarm session ID' },
        outputs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              workstream: { type: 'string', description: 'Workstream ID (e.g. ws-0)' },
              output: { type: 'string', description: 'The collected output text from the subprocess' },
            },
            required: ['workstream', 'output'],
          },
          description: 'Array of workstream outputs collected from subprocess files',
        },
      },
      required: ['sessionId', 'outputs'],
    },
  },
  {
    name: 'swarm_models',
    description: 'List or set available models for swarm orchestration. Models are auto-categorized into pools (premium, coder, critic, fast) by tier and provider.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'set'], description: 'Action to perform (default: list)' },
        models: { type: 'array', items: { type: 'string' }, description: 'Model IDs to set as available (only used with action=set)' },
      },
    },
  },
  {
    name: 'swarm_relay',
    description: 'Post findings from a completed workstream to the shared board. The orchestrator uses this to relay discoveries between managers. Board context is automatically injected into subsequent swarm_next prompts. Use type="blocker" to flag issues that require orchestrator decision before proceeding.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Swarm session ID' },
        workstream: { type: 'string', description: 'Workstream ID that produced the finding (e.g. ws-0)' },
        type: { type: 'string', enum: ['finding', 'blocker', 'decision', 'status'], description: 'Message type (default: finding). "blocker" halts dependent workstreams until resolved by a "decision".' },
        content: { type: 'string', description: 'The finding, blocker, or decision content' },
      },
      required: ['sessionId', 'workstream', 'content'],
    },
  },
  {
    name: 'swarm_board',
    description: 'Read the shared message board. Returns all findings, blockers, decisions posted by workstreams. Shows ready/blocked workstream status. The orchestrator reads this to make informed decisions about what to dispatch next.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Swarm session ID' },
        workstream: { type: 'string', description: 'Filter: exclude messages from this workstream (for anonymous reading)' },
        types: { type: 'array', items: { type: 'string', enum: ['finding', 'blocker', 'decision', 'status'] }, description: 'Filter by message types' },
      },
      required: ['sessionId'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  switch (request.params.name) {
    case 'swarm_init':
      return handleSwarmInit(args as Parameters<typeof handleSwarmInit>[0]);
    case 'swarm_next':
      return handleSwarmNext(args as Parameters<typeof handleSwarmNext>[0]);
    case 'swarm_submit':
      return handleSwarmSubmit(args as Parameters<typeof handleSwarmSubmit>[0]);
    case 'swarm_merge':
      return handleSwarmMerge(args as Parameters<typeof handleSwarmMerge>[0]);
    case 'swarm_status':
      return handleSwarmStatus(args as Parameters<typeof handleSwarmStatus>[0]);
    case 'swarm_gate':
      return handleSwarmGate(args as Parameters<typeof handleSwarmGate>[0]);
    case 'swarm_collect':
      return handleSwarmCollect(args as Parameters<typeof handleSwarmCollect>[0]);
    case 'swarm_models':
      return handleSwarmModels(args as Parameters<typeof handleSwarmModels>[0]);
    case 'swarm_relay':
      return handleSwarmRelay(args as Parameters<typeof handleSwarmRelay>[0]);
    case 'swarm_board':
      return handleSwarmBoard(args as Parameters<typeof handleSwarmBoard>[0]);
    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Open Swarm MCP server running on stdio');
