// Scroll choreography: scroll → shared state, section reveals, hero exit, per-column card depth.
import { state, clamp } from './state.js';

export function initChoreography({ invalidate }) {
  const root = document.documentElement;
  const hero = document.getElementById('top');
  const finale = document.getElementById('finale');
  let vh = innerHeight, queued = false;

  // ---- reveals: add `.in` once when something first enters the viewport ----
  const reveal = els => {
    if (!('IntersectionObserver' in window)) { els.forEach(e => e.classList.add('in')); return; }
    const io = new IntersectionObserver(entries => entries.forEach(en => {
      if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    }), { rootMargin: '0px 0px -6% 0px', threshold: 0.05 });
    els.forEach(e => io.observe(e));
  };
  reveal([...document.querySelectorAll('.row-head, .card, .finale-in > *')]);

  // ---- per-column depth: cards drift slightly at different rates (desktop only) ----
  const onScreen = new Set();
  const depthIO = 'IntersectionObserver' in window ? new IntersectionObserver(es => es.forEach(en => {
    en.isIntersecting ? onScreen.add(en.target) : (onScreen.delete(en.target), en.target.style.translate = '');
    queue();                                  // recompute depth when the visible set changes
  }), { rootMargin: '10% 0px' }) : null;
  document.querySelectorAll('.card').forEach(c => depthIO && depthIO.observe(c));
  const lastShift = new WeakMap();
  const FACTOR = [0, -.55, -1.1];
  function depth() {
    if (state.reduced || innerWidth <= 760 || !onScreen.size) return;
    const reads = [];
    onScreen.forEach(c => {
      if (!c.offsetParent) return;
      const r = c.getBoundingClientRect(), prev = lastShift.get(c) || 0;
      const idx = [...c.parentNode.children].indexOf(c) % 3;
      const norm = clamp(((r.top + r.height / 2 - prev) - vh / 2) / vh, -1, 1);
      reads.push([c, norm * FACTOR[idx] * 34]);
    });
    reads.forEach(([c, y]) => { lastShift.set(c, y); c.style.translate = `0 ${y.toFixed(1)}px`; });
  }

  // ---- main scroll step (rAF-throttled, passive) ----
  function step() {
    queued = false;
    const y = scrollY, docH = root.scrollHeight;
    state.scroll = y;
    state.hero = clamp(y / (vh * .9));
    state.finale = clamp((vh - finale.getBoundingClientRect().top) / (vh * .85));
    state.pageP = clamp(y / Math.max(1, docH - vh));
    hero.style.setProperty('--hp', state.hero.toFixed(3));
    root.classList.toggle('at-finale', state.finale > .2);
    depth();
    if (state.reduced) invalidate();
  }
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(step); } };
  addEventListener('scroll', queue, { passive: true });
  addEventListener('resize', () => { vh = innerHeight; queue(); });
  step();
  return { refresh: queue };
}