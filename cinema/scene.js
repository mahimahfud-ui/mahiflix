// MahiFlix cinema scene: a projector beam, dust lit inside it, and drifting film ribbons.
// Original work. No external assets; everything is generated in shaders.
import * as THREE from '/vendor/three.module.min.js';
import { clamp, smooth } from './state.js';

// ---- shared GLSL: one definition of the beam so background, dust and film all agree ----
const BEAM = /* glsl */`
uniform vec2 uSrc; uniform vec2 uAxis; uniform float uAspect;
// returns (along, across, halfWidth) in aspect-corrected screen space
vec3 beam(vec2 p){
  vec2 d = p - uSrc;
  float along = dot(d, uAxis);
  float across = dot(d, vec2(-uAxis.y, uAxis.x));
  return vec3(along, across, .035 + max(along, 0.) * .27);
}
float inBeam(vec3 b){
  return smoothstep(1.15, .15, abs(b.y) / b.z) * smoothstep(0., .2, b.x) * exp(-max(b.x, 0.) * .9);
}`;
const HASH = /* glsl */`
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }`;

const BG_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;
const BG_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform float uTime, uInt, uMood, uPulse, uDim;
${BEAM}${HASH}
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float a = .5, s = 0.; for(int i=0;i<3;i++){ s += a*vn(p); p = p*2.03 + 7.1; a *= .5; } return s; }
void main(){
  vec2 p = (vUv - .5) * vec2(uAspect, 1.);
  vec3 b = beam(p);
  float edge = abs(b.y) / b.z;
  float cone = smoothstep(1., .2, edge) * smoothstep(0., .18, b.x);
  float haze = fbm(vec2(b.y * 6., b.x * 1.6 - uTime * .04));      // streaks drift along the beam
  float L = cone * exp(-max(b.x, 0.) * 1.15) * (.45 + .9 * haze) * uInt;
  float halo = exp(-length(p - uSrc) * 3.2) * .55 * uInt;

  vec3 warm = vec3(1., .86, .8), cool = vec3(.62, .74, 1.);
  vec3 red = vec3(.93, .05, .1), steel = vec3(.25, .4, .9);
  vec3 core = mix(warm, cool, uMood * .55), rim = mix(red, steel, uMood * .7);
  vec3 beamCol = mix(rim, core, smoothstep(.9, .1, edge));

  vec3 col = vec3(.040, .040, .046);
  col += beamCol * L * .55 + rim * halo;
  col += rim * exp(-length(p + vec2(.5 * uAspect, .45)) * 2.2) * .05 * (.4 + uInt);
  col += beamCol * uPulse * .14 * cone;
  float v = 1. - dot(p * vec2(.9, 1.1), p * vec2(.9, 1.1)) * .75;
  col *= clamp(v, 0., 1.);
  col += (h21(gl_FragCoord.xy + fract(uTime) * 91.7) - .5) * .028;   // film grain
  col *= 1. - uDim * .55;
  gl_FragColor = vec4(col, 1.);
}`;

const DUST_VERT = /* glsl */`
attribute vec4 aSeed;
uniform float uTime, uInt, uScroll, uPx;
varying float vA; varying float vC;
${BEAM}
void main(){
  vec3 p = (aSeed.xyz - .5) * vec3(15., 10., 9.);
  float s = aSeed.w, t = uTime * (.35 + .65 * s);
  p.y = mod(p.y + 5. + t * .12 + uScroll * (2.5 + p.z * .25), 10.) - 5.;   // rises; nearer dust parallaxes more
  p.x += sin(t * .5 + aSeed.z * 40.) * .22;
  p.z += cos(t * .4 + aSeed.x * 30.) * .22;
  vec4 mv = modelViewMatrix * vec4(p, 1.);
  gl_Position = projectionMatrix * mv;
  vec2 q = (gl_Position.xy / gl_Position.w) * .5 * vec2(uAspect, 1.);
  float lit = inBeam(beam(q));
  float tw = .6 + .4 * sin(uTime * (.6 + s * 2.) + aSeed.x * 50.);
  vA = (.07 + 1.1 * lit * uInt) * tw * (.45 + .55 * s);
  vC = lit;
  gl_PointSize = uPx * (1.2 + s * 2.8) * (4. / max(-mv.z, .8));
}`;
const DUST_FRAG = /* glsl */`
precision highp float; varying float vA; varying float vC; uniform float uMood;
void main(){
  float d = length(gl_PointCoord - .5) * 2.;
  float a = smoothstep(1., 0., d); a *= a;
  vec3 c = mix(vec3(.7, .66, .7), mix(vec3(1., .85, .8), vec3(.7, .8, 1.), uMood * .55), vC);
  gl_FragColor = vec4(c, a * vA);
}`;

const FILM_VERT = /* glsl */`
uniform float uTime, uScroll, uPhase, uSlope, uZ, uWidth;
varying vec2 vUv; varying float vLit;
${BEAM}
void main(){
  vUv = uv;
  float s = uv.x, t = uv.y - .5;
  vec3 c = vec3((s - .5) * 34. - uScroll * 6., (s - .5) * uSlope + sin(s * 5. + uPhase + uTime * .05) * .6,
                uZ + sin(s * 3. + uPhase) * 2.2);
  float tw = s * 2.4 + uPhase + uTime * .03;                      // slow twist, like a loose strip
  c += vec3(0., cos(tw), sin(tw)) * t * uWidth;
  vec4 mv = modelViewMatrix * vec4(c, 1.);
  gl_Position = projectionMatrix * mv;
  vec2 q = (gl_Position.xy / gl_Position.w) * .5 * vec2(uAspect, 1.);
  vLit = .3 + .7 * inBeam(beam(q));
  vLit *= smoothstep(0., .1, s) * smoothstep(1., .9, s);
}`;
const FILM_FRAG = /* glsl */`
precision highp float; varying vec2 vUv; varying float vLit;
uniform float uTime, uMood, uAlpha, uNum;
${HASH}
float ln(float d, float w){ return 1. - smoothstep(0., w, abs(d)); }
void main(){
  vec2 g = vec2(vUv.x * uNum, vUv.y);
  float fx = fract(g.x), wy = fwidth(g.y) * 1.4, wx = fwidth(g.x) * 1.4;
  float win = step(.16, g.y) * step(g.y, .84);
  float lines = ln(g.y - .16, wy) + ln(g.y - .84, wy) + win * ln(min(fx, 1. - fx), wx);
  float r = h21(vec2(floor(g.x), 3.1));
  float lit = step(.8, r) * (.5 + .5 * sin(uTime * .4 + r * 30.));     // an occasional frame glows
  float holes = step(.3, fract(g.x * 4.)) * step(fract(g.x * 4.), .7) * (step(.05, g.y) * step(g.y, .11) + step(.89, g.y) * step(g.y, .95));
  float a = lines * .35 + win * (.04 + .12 * lit) + holes * .2;
  vec3 col = mix(vec3(.95, .78, .78), vec3(.7, .8, 1.), uMood * .6);
  gl_FragColor = vec4(col, a * uAlpha * vLit);
}`;

export function startScene({ canvas, state, onReady, onFail }) {
  let renderer;
  try {
    const probe = document.createElement('canvas');                       // silent support check (avoids a console error)
    if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) throw new Error('no webgl');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!renderer.getContext()) throw new Error('no context');
  } catch (e) { onFail(); return { invalidate() {}, dispose() {} }; }

  const mqPhone = matchMedia('(max-width:760px)'), mqTab = matchMedia('(max-width:1100px)');
  const lowEnd = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
  const tier = mqPhone.matches ? { n: 450, dpr: 1, ribbons: 1 }
             : (mqTab.matches || lowEnd) ? { n: 1100, dpr: 1.25, ribbons: 1 }
             : { n: 2200, dpr: 1.5, ribbons: 2 };
  // governor levels: [pixel-ratio scale, particle share, ribbons shown]
  const LEVELS = [[.6, .3, 1], [.75, .6, 1], [1, 1, tier.ribbons]];
  let level = 2;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, .1, 60);
  camera.position.set(0, 0, 6);

  const shared = {
    uTime: { value: 0 }, uAspect: { value: 1 }, uSrc: { value: new THREE.Vector2() }, uAxis: { value: new THREE.Vector2(0, -1) },
    uInt: { value: 1 }, uMood: { value: 0 }, uPulse: { value: 0 }, uDim: { value: 0 }, uScroll: { value: 0 }, uPx: { value: 1 },
  };
  const disposables = [];
  const add = (mesh, order) => { mesh.frustumCulled = false; mesh.renderOrder = order; scene.add(mesh); disposables.push(mesh.geometry, mesh.material); return mesh; };

  // 1. beam + haze + grain + vignette (fullscreen, drawn first)
  add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: shared, vertexShader: BG_VERT, fragmentShader: BG_FRAG, depthTest: false, depthWrite: false })), -10);

  // 2. film ribbons (all motion in the vertex shader)
  const ribbons = [[0, 3, -3.2, 1.25, .9], [2.4, -3.4, -5.5, 1.5, .6]].slice(0, tier.ribbons).map(([phase, slope, z, w, alpha]) => {
    const m = add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 200, 1), new THREE.ShaderMaterial({
      uniforms: { ...shared, uPhase: { value: phase }, uSlope: { value: slope }, uZ: { value: z }, uWidth: { value: w }, uAlpha: { value: alpha }, uNum: { value: 26 } },
      vertexShader: FILM_VERT, fragmentShader: FILM_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })), 1);
    return m;
  });

  // 3. dust
  const seeds = new Float32Array(tier.n * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tier.n * 3), 3)); // unused, required by Points
  dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  const dust = add(new THREE.Points(dustGeo, new THREE.ShaderMaterial({
    uniforms: shared, vertexShader: DUST_VERT, fragmentShader: DUST_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })), 2);

  // ---- sizing ----
  let W = 0, H = 0;
  function resize(force) {
    const w = innerWidth, h = innerHeight;
    // ignore mobile URL-bar jitter (small height-only changes)
    if (!force && w === W && Math.abs(h - H) < 110) return;
    W = w; H = h;
    const budget = Math.sqrt(2.6e6 / (w * h));                          // cap total pixels
    const dpr = Math.min(devicePixelRatio || 1, tier.dpr, budget) * LEVELS[level][0];
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    shared.uAspect.value = w / h;
    shared.uPx.value = dpr * .8;
    invalidate();
  }
  function applyLevel() {
    const [, share, rib] = LEVELS[level];
    dustGeo.setDrawRange(0, Math.floor(tier.n * share));
    ribbons.forEach((r, i) => { r.visible = i < rib; });
    resize(true);
  }

  // ---- per-frame update ----
  const cur = { int: 1, mood: 0, dim: 0, scroll: 0, px: 0, py: 0, hero: 0, finale: 0 };
  const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
  let simT = 0;
  function update(dt, now, snap) {
    const k = snap ? 1e3 : 1;
    cur.hero = damp(cur.hero, state.hero, 3 * k, dt);
    cur.finale = damp(cur.finale, state.finale, 2.2 * k, dt);
    cur.mood = damp(cur.mood, state.mood, 1.6 * k, dt);
    cur.dim = damp(cur.dim, state.dim, 4 * k, dt);
    cur.scroll = damp(cur.scroll, state.pageP, 3 * k, dt);
    const reduced = state.reduced;
    cur.px = damp(cur.px, reduced ? 0 : state.px, 2.2, dt);
    cur.py = damp(cur.py, reduced ? 0 : state.py, 2.2, dt);

    const h = smooth(cur.hero), f = smooth(cur.finale);
    const x = (now - state.pulseAt) / 1000;
    const pulse = x < 0 ? 0 : Math.min(1, x / .12) * Math.exp(-x * 2.6);
    const asp = shared.uAspect.value;
    const sx = (.40 * asp) * (1 - f) + cur.px * .015 * asp, sy = .64;
    const tx = -.08 * asp * (1 - f), ty = -.42 + .12 * f;
    const dx = tx - sx, dy = ty - sy, l = Math.hypot(dx, dy);
    shared.uSrc.value.set(sx, sy); shared.uAxis.value.set(dx / l, dy / l);
    shared.uInt.value = clamp((1 - .66 * h) + .7 * f + pulse * .45 - cur.dim * .12, 0, 1.5) * (asp < 1 ? .8 : 1);   // calmer on portrait
    shared.uMood.value = cur.mood; shared.uPulse.value = pulse; shared.uDim.value = cur.dim; shared.uScroll.value = cur.scroll;
    if (!reduced) simT += dt;
    shared.uTime.value = reduced ? 3 : simT;
    camera.position.set(cur.px * .35, cur.py * -.2 - cur.scroll * .6, 6 - cur.scroll * 1.2);
    camera.lookAt(0, -cur.scroll * .3, -2);
  }

  // ---- loop + quality governor ----
  let raf = 0, last = performance.now(), ready = false, warm = 2, acc = 0, cnt = 0, bad = 0, dead = false;
  let base = 1;                                                         // fastest frame seen ≈ the display's refresh interval
  function govern(dt) {
    if (dt > .004) base = Math.min(base, dt);
    acc += dt; if (++cnt < 60) return;
    const avg = acc / cnt; acc = 0; cnt = 0;
    if (warm > 0) { warm--; return; }                                   // ignore shader-compile + intro frames
    const cappedAt30 = base > .030 && base < .036 && avg < .042;       // e.g. Low Power Mode: slow display, not a slow GPU
    if (avg > .026 && !cappedAt30) {
      if (++bad < 2) return; bad = 0;
      if (level > 0) { level--; applyLevel(); }
      else if (avg > .045) { fail(); }                                  // even the lightest tier can't keep up
    } else bad = 0;
  }
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    update(dt, now, false);
    renderer.render(scene, camera);
    if (!ready) { ready = true; onReady(); }
    govern(dt);
  }
  function start() { if (dead || state.reduced || raf || document.hidden) return; last = performance.now(); raf = requestAnimationFrame(frame); }
  function stop() { cancelAnimationFrame(raf); raf = 0; }
  function invalidate() {                                               // one static frame (reduced motion / paused)
    if (dead || raf) return;
    requestAnimationFrame(now => { update(.016, now, true); renderer.render(scene, camera); if (!ready) { ready = true; onReady(); } });
  }
  function fail() { dispose(); onFail(); }

  const onVis = () => (document.hidden ? stop() : state.reduced ? invalidate() : start());
  let rt = 0; const onResize = () => { clearTimeout(rt); rt = setTimeout(() => resize(false), 120); };
  const onLost = e => { e.preventDefault(); stop(); canvas.classList.add('lost'); document.documentElement.classList.remove('gl-ready'); };
  const onRestored = () => { canvas.classList.remove('lost'); document.documentElement.classList.add('gl-ready'); start(); invalidate(); };
  document.addEventListener('visibilitychange', onVis);
  addEventListener('resize', onResize);
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => (state.reduced ? (stop(), invalidate()) : start()));

  function dispose() {
    dead = true; stop();
    document.removeEventListener('visibilitychange', onVis); removeEventListener('resize', onResize);
    canvas.removeEventListener('webglcontextlost', onLost); canvas.removeEventListener('webglcontextrestored', onRestored);
    disposables.forEach(d => d.dispose()); renderer.dispose();
    try { renderer.forceContextLoss(); } catch (e) {}
  }

  resize(true); applyLevel();
  state.reduced ? invalidate() : start();
  return { invalidate, dispose };
}