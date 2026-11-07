// Mirrors the shared design-system timing; springs extend its selection feedback.
export const motionTokens = {
  fast: 120,
  base: 180,
  slow: 240,
  easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
  ease: [0.16, 1, 0.3, 1] as const,
  spring: {
    lead: { stiffness: 600, damping: 38, mass: 0.8 },
    trail: { stiffness: 380, damping: 34, mass: 1 },
  },
};
