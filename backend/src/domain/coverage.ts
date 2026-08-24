import type { CoverageReport, Person, Surface, SurfaceKey, SurfaceState } from './types.js';

/**
 * Weights per surface state.
 *
 * `outOfScope` returns null and is excluded from the denominator entirely —
 * a surface that does not apply to a role is not a failure to connect it.
 */
const WEIGHT: Record<SurfaceState, number | null> = {
  connected: 1,
  partial: 0.5,
  stale: 0.5,
  absent: 0,
  outOfScope: null,
};

const LABEL: Record<SurfaceState, string> = {
  connected: 'connected',
  partial: 'partial scope',
  stale: 'stale',
  absent: 'not connected',
  outOfScope: 'out of scope for role',
};

export function stateLabel(state: SurfaceState): string {
  return LABEL[state];
}

/** Cycle order for a person's own surface control: connected → partial → absent → connected.
 *  `outOfScope` never appears here — a role either has a surface in scope or doesn't;
 *  the employee can't opt a surface into scope, only connect or disconnect one that is. */
export function nextSurfaceState(current: SurfaceState): SurfaceState {
  if (current === 'outOfScope') return current;
  return ({ connected: 'partial', partial: 'absent', stale: 'absent', absent: 'connected' } as const)[
    current
  ];
}

export function computeCoverage(person: Person, surfaces: Surface[]): CoverageReport {
  if (!person.agentDeployed) {
    return {
      personId: person.id,
      percent: null,
      inScopeCount: 0,
      connectedCount: 0,
      gaps: [],
      agentDeployed: false,
    };
  }

  let sum = 0;
  let denominator = 0;
  let connected = 0;
  const gaps: string[] = [];

  for (const surface of surfaces) {
    const state = person.surfaces[surface.key];
    const weight = WEIGHT[state];
    if (weight === null) continue;

    denominator += 1;
    sum += weight;
    if (state === 'connected') connected += 1;
    else gaps.push(`${surface.name} — ${LABEL[state]}`);
  }

  return {
    personId: person.id,
    percent: denominator === 0 ? null : Math.round((sum / denominator) * 100),
    inScopeCount: denominator,
    connectedCount: connected,
    gaps,
    agentDeployed: true,
  };
}

/** Org-wide coverage, weighted the same way. Drives the Overview headline. */
export function computeOrgCoverage(people: Person[], surfaces: Surface[]) {
  let sum = 0;
  let denominator = 0;
  const bands = { connected: 0, partial: 0, stale: 0, absent: 0 };

  for (const person of people) {
    if (!person.agentDeployed) continue;
    for (const surface of surfaces) {
      const state = person.surfaces[surface.key];
      const weight = WEIGHT[state];
      if (weight === null) continue;
      denominator += 1;
      sum += weight;
      bands[state as keyof typeof bands] += 1;
    }
  }

  const deployed = people.filter((p) => p.agentDeployed).length;

  return {
    percent: denominator === 0 ? 0 : Math.round((sum / denominator) * 100),
    bands,
    agentsLive: deployed,
    totalPeople: people.length,
  };
}

/** Surfaces a claim may rely on for this person. Absent surfaces cannot back a claim. */
export function usableSurfaces(person: Person, surfaces: Surface[]): SurfaceKey[] {
  return surfaces
    .filter((s) => {
      const state = person.surfaces[s.key];
      return state === 'connected' || state === 'partial' || state === 'stale';
    })
    .map((s) => s.key);
}

export interface ConnectorStats {
  key: SurfaceKey;
  name: string;
  feedsTier: Surface['feedsTier'];
  reads: string;
  doesNotRead: string;
  /** Worst state wins: any absent/stale drags the connector's own status down. */
  status: 'live' | 'degraded' | 'stale';
  inScopeCount: number;
  connectedCount: number;
  counts: Record<SurfaceState, number>;
}

const STATUS_RANK: Record<SurfaceState, number> = {
  connected: 0,
  outOfScope: 0,
  partial: 1,
  stale: 2,
  absent: 3,
};

/**
 * Org-wide connector view for the Connections screen. Every figure is a count over
 * `people`, computed fresh — nothing here is an authored literal.
 */
export function computeConnectorStats(surfaces: Surface[], people: Person[]): ConnectorStats[] {
  return surfaces.map((surface) => {
    const counts: Record<SurfaceState, number> = {
      connected: 0,
      partial: 0,
      stale: 0,
      absent: 0,
      outOfScope: 0,
    };
    let worst: SurfaceState = 'connected';
    let inScopeCount = 0;

    for (const person of people) {
      if (!person.agentDeployed) continue;
      const state = person.surfaces[surface.key];
      counts[state] += 1;
      if (state === 'outOfScope') continue;
      inScopeCount += 1;
      if (STATUS_RANK[state] > STATUS_RANK[worst]) worst = state;
    }

    const status: ConnectorStats['status'] =
      worst === 'absent' || worst === 'partial' ? 'degraded' : worst === 'stale' ? 'stale' : 'live';

    return {
      key: surface.key,
      name: surface.name,
      feedsTier: surface.feedsTier,
      reads: surface.reads,
      doesNotRead: surface.doesNotRead,
      status,
      inScopeCount,
      connectedCount: counts.connected,
      counts,
    };
  });
}
