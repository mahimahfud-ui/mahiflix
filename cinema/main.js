// Entry point. Loads the WebGL scene lazily so the intro and first paint are never blocked.
import { state } from './state.js';
import { initChoreography } from './choreography.js';
import { initInteractions } from './interactions.js';

const root = document.documentElement;
window.__cinema = true;                         // tells the head failsafe that we booted
const releaseCinema = () => root.classList.remove('cin');
let scene = null;
const invalidate = () => scene && scene.invalidate();

const { refresh } = initChoreography({ invalidate });
initInteractions({ invalidate, refresh });

function boot() {
  import('./scene.js').then(m => {
    scene = m.startScene({
      canvas: document.getElementById('cinema'), state,
      onReady: () => root.classList.add('gl-ready'),
      onFail: () => { root.classList.remove('gl-ready'); root.classList.add('no-webgl'); releaseCinema(); },
    });
  }).catch(() => { root.classList.add('no-webgl'); releaseCinema(); });
}
'requestIdleCallback' in window ? requestIdleCallback(boot, { timeout: 400 }) : setTimeout(boot, 80);