import type { Person } from './api';

/**
 * Client-side mirror of backend/src/domain/policy.ts's deriveAllowedRoles — used only to
 * gray out untruthful role buttons before a request is even sent. The server enforces
 * this for real (persisted asks get a 403 if the claimed role doesn't hold); this copy
 * is UI convenience, not the security boundary. Keep it in sync if that one changes.
 */
export function deriveAllowedRoles(requesterId: number, targetId: number, people: Person[]): string[] {
  if (requesterId === targetId) return ['Self'];

  const byId = new Map(people.map((p) => [p.id, p]));
  const requester = byId.get(requesterId);
  const target = byId.get(targetId);
  if (!requester || !target) return [];

  const roles = new Set<string>();
  if (target.managerId === requesterId) roles.add('Direct manager');

  const targetManager = target.managerId != null ? byId.get(target.managerId) : undefined;
  if (targetManager?.managerId === requesterId) roles.add('Skip-level');

  if (target.managerId != null && requester.managerId === target.managerId) roles.add('Peer');

  if (requester.team === 'IT') roles.add('IT admin');
  if (requester.managerId == null || requester.team === 'Executive') roles.add('Executive');

  return [...roles];
}
