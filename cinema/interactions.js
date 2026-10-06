// UI interactions layered on top of the original page logic (which is untouched):
// card light/tilt, pointer parallax, mode-switch pulse, cinematic search.
import { state } from './state.js';

export function initInteractions({ invalidate, refresh }) {
  const root = document.documentElement;
  const fine = matchMedia('(hover:hover) and (pointer:fine)');

  // ---- pointer → scene parallax + card lighting/tilt (one rAF-batched handler) ----
  let pe = null, raf = 0, hovered = null;
  function apply() {
    raf = 0; if (!pe) return;
    state.px = (pe.clientX / innerWidth) * 2 - 1;
    state.py = (pe.clientY / innerHeight) * 2 - 1;
    const card = pe.target.closest && pe.target.closest('.card.live');
    if (hovered && hovered !== card) release(hovered);
    hovered = card;
    if (!card || state.reduced) return;
    const r = card.getBoundingClientRect();
    const nx = (pe.clientX - r.left) / r.width, ny = (pe.clientY - r.top) / r.height;
    card.style.setProperty('--mx', (nx * 100).toFixed(1) + '%');
    card.style.setProperty('--my', (ny * 100).toFixed(1) + '%');
    // tiny tilt as a single axis-angle `rotate` so it can transition independently of lift/parallax
    const ax = -(ny - .5) * 2, ay = (nx - .5) * 2, ang = Math.hypot(ax, ay) * 3;
    card.style.rotate = ang > .05 ? `${ax.toFixed(3)} ${ay.toFixed(3)} 0 ${ang.toFixed(2)}deg` : '';
  }
  function release(c) { c.style.rotate = ''; }
  if (fine.matches) {
    addEventListener('pointermove', e => { if (e.pointerType !== 'mouse') return; pe = e; if (!raf) raf = requestAnimationFrame(apply); }, { passive: true });
    document.addEventListener('pointerleave', () => { if (hovered) release(hovered); hovered = null; state.px = state.py = 0; });
  }

  // ---- mode switch: shift the scene's mood and fire a light pulse ----
  document.querySelectorAll('.mode').forEach(btn => btn.addEventListener('click', () => {
    state.mood = btn.dataset.mode === 'apps' ? 1 : 0;
    state.pulseAt = performance.now();
    invalidate(); refresh();
  }));

  // ---- search: sync with the original toggle (observed, not replaced) ----
  const sb = document.getElementById('search'), q = document.getElementById('q'), main = document.querySelector('main');
  const sync = () => {
    const open = sb.classList.contains('open');
    document.body.classList.toggle('searching', open);
    state.dim = open ? 1 : 0; invalidate();
    if (open && main.getBoundingClientRect().top > innerHeight * .5) {        // bring results into view
      scrollTo({ top: scrollY + main.getBoundingClientRect().top - 130, behavior: state.reduced ? 'auto' : 'smooth' });
    }
  };
  new MutationObserver(sync).observe(sb, { attributes: true, attributeFilter: ['class'] });
  addEventListener('keydown', e => {
    if (e.key === 'Escape' && sb.classList.contains('open')) {
      q.value = ''; q.dispatchEvent(new Event('input')); sb.classList.remove('open'); q.blur();
    }
  });
  // results arrive progressively: restart the card entrance, staggered, for whatever survived the filter
  q.addEventListener('input', () => {
    if (state.reduced) return;
    const cards = [...document.querySelectorAll('.view.active .card')].filter(c => c.style.display !== 'none');
    cards.forEach((c, i) => { c.style.animation = 'none'; c.style.animationDelay = Math.min(i, 8) * 45 + 'ms'; });
    void document.body.offsetWidth;                                           // single reflow for the batch
    cards.forEach(c => { c.style.animation = ''; });
  });
}