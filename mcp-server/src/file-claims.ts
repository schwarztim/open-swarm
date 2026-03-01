// ── File Claims System ────────────────────────────────────────────────
// Prevents file conflicts between workers by tracking ownership.

import type { SwarmSession, FileClaim } from "./swarm-types.js";

export function claimFiles(
  session: SwarmSession,
  paths: string[],
  claimedBy: string,
  groupId: string,
): { claimed: string[]; conflicts: Array<{ path: string; owner: string }> } {
  const claimed: string[] = [];
  const conflicts: Array<{ path: string; owner: string }> = [];

  for (const path of paths) {
    const existing = session.claims.find((c) => c.path === path && !c.released);
    if (existing && existing.claimedBy !== claimedBy) {
      conflicts.push({ path, owner: existing.claimedBy });
    } else {
      const existingOwn = session.claims.find(
        (c) => c.path === path && c.claimedBy === claimedBy,
      );
      if (!existingOwn || existingOwn.released) {
        session.claims.push({
          path,
          claimedBy,
          groupId,
          claimedAt: Date.now(),
          released: false,
        });
      }
      claimed.push(path);
    }
  }

  return { claimed, conflicts };
}

export function releaseFiles(
  session: SwarmSession,
  paths: string[],
  claimedBy: string,
): string[] {
  const released: string[] = [];
  for (const path of paths) {
    const claim = session.claims.find(
      (c) => c.path === path && c.claimedBy === claimedBy && !c.released,
    );
    if (claim) {
      claim.released = true;
      released.push(path);
    }
  }
  return released;
}

export function checkFileClaims(
  session: SwarmSession,
  paths: string[],
): Array<{ path: string; claimedBy: string; groupId: string }> {
  return paths
    .map((path) => {
      const claim = session.claims.find((c) => c.path === path && !c.released);
      return claim
        ? { path, claimedBy: claim.claimedBy, groupId: claim.groupId }
        : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
}

export function getClaimsForWorkstream(
  session: SwarmSession,
  workstreamId: string,
): FileClaim[] {
  return session.claims.filter(
    (c) => c.claimedBy === workstreamId && !c.released,
  );
}

export function getAllActiveClaims(session: SwarmSession): FileClaim[] {
  return session.claims.filter((c) => !c.released);
}
