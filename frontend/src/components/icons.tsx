import type { SVGProps } from 'react';

/** Small, single-weight line icons for navigation and empty states. All 16×16 on a
 *  1.6px stroke so they sit at the same visual weight next to 12–14px text. Decorative:
 *  every use pairs them with a visible label, so they're aria-hidden. */
type P = SVGProps<SVGSVGElement>;
const base = (props: P) => ({
  width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  'aria-hidden': true, ...props,
});

export const IconAgent = (p: P) => (
  <svg {...base(p)}><rect x="4" y="6" width="16" height="12" rx="3" /><path d="M12 3v3M9 12h.01M15 12h.01M9 16h6" /></svg>
);
export const IconSpark = (p: P) => (
  <svg {...base(p)}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" /></svg>
);
export const IconWrench = (p: P) => (
  <svg {...base(p)}><path d="M14.5 6.5a4 4 0 0 0 4.9 4.9L21 9a5 5 0 1 1-6-6zM14 10L4 20l2 2 10-10" /></svg>
);
export const IconEye = (p: P) => (
  <svg {...base(p)}><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
);
export const IconMask = (p: P) => (
  <svg {...base(p)}><path d="M4 7h16v6a8 8 0 0 1-16 0zM8 12h.01M16 12h.01" /></svg>
);
export const IconChat = (p: P) => (
  <svg {...base(p)}><path d="M4 5h16v11H9l-5 4z" /></svg>
);
export const IconBell = (p: P) => (
  <svg {...base(p)}><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0" /></svg>
);
export const IconTree = (p: P) => (
  <svg {...base(p)}><rect x="9" y="3" width="6" height="4" rx="1" /><rect x="3" y="15" width="6" height="4" rx="1" /><rect x="15" y="15" width="6" height="4" rx="1" /><path d="M12 7v4M6 15v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" /></svg>
);
export const IconSliders = (p: P) => (
  <svg {...base(p)}><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
);
export const IconGauge = (p: P) => (
  <svg {...base(p)}><path d="M4 16a8 8 0 1 1 16 0" /><path d="M12 16l4-5" /><circle cx="12" cy="16" r="1.5" /></svg>
);
export const IconBuilding = (p: P) => (
  <svg {...base(p)}><rect x="4" y="3" width="16" height="18" rx="1.5" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3" /></svg>
);
export const IconGrid = (p: P) => (
  <svg {...base(p)}><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></svg>
);
export const IconPlug = (p: P) => (
  <svg {...base(p)}><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" /></svg>
);
export const IconShield = (p: P) => (
  <svg {...base(p)}><path d="M12 3l8 3v6c0 4.5-3.5 8-8 9-4.5-1-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></svg>
);
export const IconLedger = (p: P) => (
  <svg {...base(p)}><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M9 8h6M9 12h6M9 16h4" /></svg>
);
export const IconFlag = (p: P) => (
  <svg {...base(p)}><path d="M5 21V4h11l-1.5 4L16 12H5" /></svg>
);
export const IconInbox = (p: P) => (
  <svg {...base(p)}><path d="M4 13l2-8h12l2 8v6H4z" /><path d="M4 13h5l1.5 2h3L15 13h5" /></svg>
);
export const IconSend = (p: P) => (
  <svg {...base(p)}><path d="M21 3L10 14M21 3l-7 18-4-7-7-4z" /></svg>
);
export const IconChevron = (p: P) => (
  <svg {...base(p)}><path d="M9 6l6 6-6 6" /></svg>
);
export const IconCheck = (p: P) => (
  <svg {...base(p)}><path d="M5 12l5 5L20 7" /></svg>
);
export const IconNest = (p: P) => (
  <svg {...base(p)}><path d="M3 13c0 4 4 7 9 7s9-3 9-7" /><path d="M5 13c2-2 4-3 7-3s5 1 7 3M8 10c1-2 2.5-3 4-3s3 1 4 3" /></svg>
);
