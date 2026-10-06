// Shared, plain-object state bus. choreography/interactions WRITE, scene READS.
export const state = {
  scroll: 0,      // px
  hero: 0,        // 0..1 how far the hero has scrolled away
  finale: 0,      // 0..1 how far the finale has entered
  pageP: 0,       // 0..1 whole-page progress
  mood: 0,        // 0 = websites (crimson), 1 = apps (steel)
  dim: 0,         // 0..1 search open
  pulseAt: -1e9,  // performance.now() of last mode switch
  px: 0, py: 0,   // pointer, -1..1
  reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
};
matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', e => { state.reduced = e.matches; });
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const smooth = x => x * x * (3 - 2 * x);