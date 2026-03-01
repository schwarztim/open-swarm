import {
  getEvents,
  SwarmEventType,
  type SwarmEvent,
} from "../event-store.js";
import { ok, err, type ToolResult } from "./shared.js";

// ── swarm_events ──────────────────────────────────────────────────────

export function handleSwarmEvents(args: {
  sessionId: string;
  eventType?: string;
  after?: number;
  limit?: number;
}): ToolResult {
  if (!args.sessionId) return err("Missing required field: sessionId");

  const validTypes = Object.values(SwarmEventType) as string[];
  if (args.eventType !== undefined && !validTypes.includes(args.eventType)) {
    return err(
      `Unknown eventType: "${args.eventType}". Valid types: ${validTypes.join(", ")}`,
    );
  }

  const events: SwarmEvent[] = getEvents(args.sessionId, {
    eventType: args.eventType as SwarmEventType | undefined,
    after: args.after,
    limit: args.limit ?? 50,
  });

  return ok({
    sessionId: args.sessionId,
    count: events.length,
    events: events.map((e) => ({
      id: e.id,
      sequence: e.sequence,
      timestamp: e.timestamp,
      eventType: e.eventType,
      payload: e.payload,
    })),
  });
}
