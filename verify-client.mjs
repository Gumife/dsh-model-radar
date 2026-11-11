/**
 * verify-client.mjs — loads client.js exactly as the browser loader would and
 * proves, WITHOUT a browser, the wiring contract:
 *
 *   1. the factory returns apply with inject ['slots','locale'];
 *   2. apply() registers on conversation.composer.dock AND on
 *      conversation.hero.options, each with OUR OWN id (kind:list → an extra
 *      cell, nothing shadowed), and does NOT register on
 *      conversation.input.model while REGISTER_SEAT is false. The hero entry
 *      exists because the host gates the whole dock row on variant==="composer",
 *      so a brand-new session would otherwise show nothing until the first
 *      message; hero.options is gated only on sessionId.
 *   3. the dock component renders a .mr-pill trigger — i.e. it does not
 *      self-collapse waiting for another component to mount — and the hero
 *      instance carries the .mr-hero geometry variant (28px row vs 22px row);
 *   4. forcing `open` + a catalog payload renders the radar body (search row,
 *      two columns, effort chips, footer);
 *   5. the CSS template literal survives: a stray backtick inside it is a
 *      SyntaxError at load time, so reaching this point proves it parses.
 *
 * React is replaced by a tiny hook-compatible stub. This is a CONTRACT test,
 * not a visual one: it cannot prove pixels, only that the tree is built.
 *
 * Usage: node verify-client.mjs
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

let loaded = null;
/* client.js receives `window` as a parameter, so anything the component touches
   off window must live on THIS object — assigning globalThis.window later would
   just be shadowed. */
const win = {
  __ModuleLoader__: { load: (def) => { loaded = def; } },
  innerWidth: 1200,
  innerHeight: 900,
  addEventListener: () => {},
  removeEventListener: () => {},
};
new Function('window', src)(win);
if (!loaded) throw new Error('client.js never called __ModuleLoader__.load');
console.log('module id =', loaded.id);

/* ── minimal React ─────────────────────────────────────────────────────── */
const frames = [];
/* Effects stay inert for the render-shape assertions (they would need a DOM),
   but the last section turns this on so the callbacks actually RUN. Rendering
   alone once let a reference to an undefined variable ship inside a callback
   that no assertion ever invoked. */
let runEffects = false;
const effectErrors = [];
/* Async callbacks reject instead of throwing, so a ReferenceError inside
   loadCredits() would escape a try/catch around fn(). Collect them explicitly. */
const rejections = [];
process.on('unhandledRejection', (reason) => {
  rejections.push(reason && reason.message ? reason.message : String(reason));
});
const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props || {}), children: children.length > 1 ? children : children[0] },
  }),
  Fragment: Symbol('Fragment'),
  useState: (init) => {
    const frame = frames[frames.length - 1];
    const i = frame.cursor++;
    if (!(i in frame.slots)) frame.slots[i] = typeof init === 'function' ? init() : init;
    return [frame.slots[i], (next) => {
      frame.slots[i] = typeof next === 'function' ? next(frame.slots[i]) : next;
    }];
  },
  useEffect: (fn) => {
    if (!runEffects) return;
    try { fn(); } catch (e) { effectErrors.push(e); }
  },
  useCallback: (fn) => fn,
  useRef: (init) => {
    const frame = frames[frames.length - 1];
    const i = frame.cursor++;
    if (!(i in frame.slots)) frame.slots[i] = { current: init === undefined ? null : init };
    return frame.slots[i];
  },
};
/* createPortal is the only reason react-dom is required. The stub records the
 * mount target so the suite can prove the menu leaves the composer's subtree —
 * backdrop-filter there makes it a containing block, so a fixed-position child
 * measures against it and the popup opens shifted instead of anchored. */
const documentStub = { body: { __isBody: true } };
if (typeof globalThis.document === 'undefined') globalThis.document = documentStub;
const portals = [];
const ReactDOM = {
  createPortal(node, target, key) {
    portals.push({ node, target, key });
    return { __portal: true, node, target, key };
  },
};
const requireStub = (name) => {
  if (name === 'react') return React;
  if (name === 'react-dom') return ReactDOM;
  throw new Error('unexpected require(' + name + ')');
};

/** One persistent state frame per component function, so hooks never collide. */
function withFrame(component, fn) {
  let frame = frames.find(f => f.key === component);
  if (!frame) { frame = { key: component, cursor: 0, slots: {} }; frames.push(frame); }
  frame.cursor = 0;
  frames.push(frame);
  try { return fn(); } finally { frames.pop(); }
}

const mod = loaded.factory(requireStub);
console.log('inject =', JSON.stringify(mod.inject));

/* ── ctx stub recording slot registrations ─────────────────────────────── */
const registrations = [];
const dicts = {};
const ctx = {
  effect: (fn) => { fn(); },
  slots: {
    inject: (key, cb) => { cb(); },
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    },
  },
  locale: {
    register: (ns, d) => { dicts[ns] = d; return () => {}; },
    /* Mirrors the shipped translate(): a single-brace {name} placeholder is
       replaced from params, an unknown placeholder is left verbatim. Matching
       the real implementation matters — a double-brace stub would pass copy
       that renders as literal braces on the host. */
    bind: (ns) => (key, params) => {
      const template = (dicts[ns] && dicts[ns].zh && dicts[ns].zh[key]) || key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
    },
  },
};

mod.apply(ctx);

const dock = registrations.filter(r => r.options.name === 'conversation.composer.dock');
const hero = registrations.filter(r => r.options.name === 'conversation.hero.options');
const seat = registrations.filter(r => r.options.name === 'conversation.input.model');
console.log('dock registrations =', dock.length, '| hero registrations =', hero.length, '| seat registrations =', seat.length);
if (dock.length !== 1) throw new Error('expected exactly one dock registration');
if (hero.length !== 1) {
  throw new Error('expected exactly one hero registration — without it a new session shows no entry until the first message');
}
if (seat.length !== 0) throw new Error('REGISTER_SEAT must ship OFF — the seat was registered');
if (!dock[0].options.id) throw new Error('dock registration needs our own id');
if (!hero[0].options.id) throw new Error('hero registration needs our own id');
if (dock[0].options.id !== hero[0].options.id) {
  throw new Error('dock and hero must share one id (same feature, two surfaces): ' +
    dock[0].options.id + ' vs ' + hero[0].options.id);
}
if (['activity', 'usage', 'dsh-connect-workbuddy-stats-credits'].includes(dock[0].options.id)) {
  throw new Error('dock must use a FRESH id, got a shipped one: ' + dock[0].options.id);
}
console.log('dock id =', dock[0].options.id, '| order =', dock[0].options.order);
console.log('hero id =', hero[0].options.id, '| order =', hero[0].options.order);

/* The two surfaces sit on different row baselines (dock 22px, hero 28px), so the
 * same component must be told which one it is in; a shared geometry would make
 * one of the two rows look off by 6px — the exact complaint this fixes. */
const dockHasSurface = /surface:\s*'dock'/.test(src);
const heroHasSurface = /surface:\s*'hero'/.test(src);
if (!dockHasSurface || !heroHasSurface) {
  throw new Error('each surface must pass its own `surface` prop (dock | hero)');
}
console.log('surface props = dock:' + dockHasSurface + ' hero:' + heroHasSurface);

/* ── render ────────────────────────────────────────────────────────────── */
const t = ctx.locale.bind('dsh-model-radar');
const injected = dock[0].options.inject('session-test');
if (injected.sessionId !== 'session-test') throw new Error('inject must forward sessionId verbatim');
const dockProps = { sessionId: 'session-test', t, surface: 'dock', ...injected };

const expand = (node, depth = 0) => {
  if (depth > 80) throw new Error('element tree too deep (render loop?)');
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(n => expand(n, depth + 1));
  /* A portal mounts elsewhere in the document, but the assertions below are
   * about CONTENT; where it mounts is asserted separately from the recorded
   * portal targets. */
  if (node.__portal) return expand(node.node, depth + 1);
  if (typeof node.type === 'function') {
    return withFrame(node.type, () => expand(node.type(node.props || {}), depth + 1));
  }
  if (node.props) {
    return { ...node, props: { ...node.props, children: expand(node.props.children, depth + 1) } };
  }
  return node;
};

/* First element whose props satisfy the predicate, searched depth-first like
   classesOf — used to pull a specific node out (e.g. the slider) so assertions
   can read its own props rather than the whole tree's class soup. */
const findNode = (node, pred, depth = 0) => {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, pred, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (node.props && typeof node.type === 'string' && pred(node)) return node;
  if (node.props) return findNode(node.props.children, pred, depth + 1);
  return null;
};

const classesOf = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => classesOf(n, out)); return out; }
  if (node.props && node.props.className) out.push(String(node.props.className));
  if (node.props) classesOf(node.props.children, out);
  return out;
};
const textOf = (node, out = []) => {
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => textOf(n, out)); return out; }
  if (node.props) textOf(node.props.children, out);
  return out;
};

/* First render: closed pill. */
const closedClasses = classesOf(expand(dock[0].component(dockProps)));
console.log('closed classes =', JSON.stringify(closedClasses));
if (!closedClasses.some(c => c.includes('mr-pill'))) {
  throw new Error('the dock entry did not render its .mr-pill trigger — it would be invisible');
}
if (closedClasses.some(c => c.includes('mr-pop'))) {
  throw new Error('the popover must stay closed on first render');
}

/* The hero surface must render the SAME trigger with the .mr-hero geometry
 * variant. Both registrations point at one component, so this also proves the
 * variant is driven by the prop and not baked in. */
const heroProps = { sessionId: 'session-test', t, surface: 'hero', ...hero[0].options.inject('session-test') };
const heroClasses = classesOf(expand(hero[0].component(heroProps)));
console.log('hero classes =', JSON.stringify(heroClasses));
if (!heroClasses.some(c => c.includes('mr-pill'))) {
  throw new Error('the hero entry did not render a .mr-pill trigger');
}
if (!heroClasses.some(c => c.includes('mr-hero'))) {
  throw new Error('the hero entry is missing .mr-hero — it would sit at the dock row\'s 22px on a 28px row');
}
if (closedClasses.some(c => c.includes('mr-hero'))) {
  throw new Error('the dock entry must NOT carry .mr-hero (22px row vs 28px row)');
}

/* The row baselines themselves, straight from the stylesheet. */
if (!/\.mr-pill\{[^}]*height:22px/.test(src.replace(/\n/g, ' '))) {
  throw new Error('.mr-pill must be 22px tall to match the context meter and credits readout beside it');
}
if (!/\.mr-pill\.mr-hero\{[^}]*height:28px/.test(src.replace(/\n/g, ' '))) {
  throw new Error('.mr-pill.mr-hero must be 28px tall to match the workspace chip beside it');
}
console.log('row baselines = dock 22px / hero 28px');

/*
 * Force the popover open by seeding RadarDock's own state frame. Hook order in
 * RadarDock is: open, busy, triggerRef, popRef, data, error, pos, efforts —
 * a custom hook shares the frame of the component that called it, so
 * useRadar's data/error and usePopoverPlacement's pos land at 4/5/6 and carry {left, bottom, maxHeight}.
 */
const dockFrame = frames.find(f => f.slots[0] === false && f.slots[1] === false);
if (!dockFrame) throw new Error('could not find the dock state frame');
dockFrame.slots[0] = true;
dockFrame.slots[6] = { left: 40, bottom: 60, maxHeight: 360 };
dockFrame.slots[7] = {
  list: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }],
  currentEffort: 'high',
};
dockFrame.slots[4] = {
  providers: [
    { provider: 'workbuddy', name: 'WorkBuddy', models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 128000, inputModalities: ['text', 'image'] },
      { id: 'deepseek-v4.1', name: 'DeepSeek V4.1', contextWindow: 128000 },
    ] },
    { provider: 'zhipu', name: 'Zhipu', models: [{ id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 200000 }] },
  ],
  current: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
  recent: [{ provider: 'workbuddy', model: 'deepseek-v4.1' }],
};

const openTree = expand(dock[0].component(dockProps));
const openClasses = classesOf(openTree);
console.log('open classes =', JSON.stringify(openClasses));
if (!openClasses.some(c => c.includes('mr-pill'))) throw new Error('trigger vanished while open');
for (const required of ['mr-pop', 'mr-search', 'mr-cols', 'mr-provs', 'mr-models', 'mr-foot']) {
  if (!openClasses.some(c => c.includes(required))) {
    throw new Error('open popover is missing .' + required);
  }
}
if (!openClasses.some(c => c.includes('mr-effort'))) {
  throw new Error('reasoning rail did not render — efforts frame was not fed');
}
/* The rail replaced a row of buttons, so assert the SHAPE of the new control,
   not just its container: a slider role, a knob, one notch per rung, and no
   surviving chip. These are the properties the redesign exists to provide, and
   each one can regress independently (e.g. the knob kept but the role lost, or
   the notches still keyed off the OLD class list). */
const railNode = findNode(openTree, n => n.props && n.props.role === 'slider');
if (!railNode) throw new Error('the reasoning rail lost role="slider" — screen readers would see a plain div');
if (railNode.props['aria-valuemin'] !== 0 || railNode.props['aria-valuemax'] !== 1) {
  throw new Error('rail aria range must span the seeded rungs (0..1), got ' +
    railNode.props['aria-valuemin'] + '..' + railNode.props['aria-valuemax']);
}
if (railNode.props['aria-valuenow'] !== 1) {
  throw new Error('rail must report the seeded currentEffort "high" as its value, got ' +
    railNode.props['aria-valuenow']);
}
if (railNode.props['aria-valuetext'] !== '高') {
  throw new Error('rail aria-valuetext must be the localised rung name, got ' + railNode.props['aria-valuetext']);
}
console.log('rail = role:' + railNode.props.role +
  ' range:' + railNode.props['aria-valuemin'] + '..' + railNode.props['aria-valuemax'] +
  ' now:' + railNode.props['aria-valuenow'] +
  ' text:' + railNode.props['aria-valuetext'] +
  ' notches:' + classesOf(railNode).filter(c => c.startsWith('dot')).length);

const railClasses = classesOf(railNode);
if (!railClasses.some(c => c === 'knob')) throw new Error('the rail is missing its knob');
/* Checked against the WHOLE popover, not just the rail's own children: the
   retired tick row used to be a sibling of the rail, so a rail-scoped check
   would pass while the row silently came back (a mutation test proved exactly
   that hole). */
if (openClasses.some(c => /\bmr-effort\b/.test(c) === false && /(^|\s)tick(s|\s|$)/.test(c))) {
  throw new Error('the retired tick-label row came back — that row is what made the control read as a form');
}
if (textOf(openTree).some(txt => txt === '最低' || txt === '极高') && railClasses.some(c => c === 'tick')) {
  throw new Error('rung names are being printed twice (tick row + current label)');
}
/* The ladder is a filled capsule with a particle field, not a row of notches.
   Assert the parts that carry the design: a gradient fill that spans the
   committed rung, at least one particle inside it, and a knob that is NOT
   tinted by the accent (it must stay white so it reads as a handle). */
const fillNode = findNode(railNode, nd => String(nd.props.className || '').indexOf('fill') >= 0);
if (!fillNode) throw new Error('the rail lost its .fill — the ladder would show no progress at all');
const fillPct = parseFloat(String(fillNode.props.style.width));
if (!(fillPct > 99 && fillPct <= 100)) {
  throw new Error('fill width must reach the last rung for currentEffort=high, got ' + fillNode.props.style.width);
}
/* A particle that cannot move is a dot. Assert the animation plumbing end to
   end: the keyframes exist in the stylesheet, the particle rule references them,
   and each rendered particle carries its own --dur/--delay so the field does not
   pulse in unison. */
for (const kf of ['@keyframes mr-drift', '@keyframes mr-sway']) {
  if (src.indexOf(kf) < 0) throw new Error('stylesheet lost ' + kf + ' — particles would be static dots');
}
if (!/\.mr-rail \.p\{[^}]*animation:[^}]*mr-drift/.test(src)) {
  throw new Error('.p does not reference mr-drift — the particle field would not animate');
}
/* Freezing is the plugin's own switch. The old guard was a
   (prefers-reduced-motion:reduce) media query, which Windows clears machine-wide
   under "adjust for best performance" — that froze the field for everyone on
   such a box and hid every rung difference. A media query must NOT come back:
   it cannot be overridden by the user, which was the whole defect. */
/* Match the AT-RULE, not the bare phrase: the comment above the switch explains
   why the media query was removed and names it, which is not a regression. */
if (/@media[^{]*prefers-reduced-motion/.test(src)) {
  throw new Error('the reduced-motion media query came back — the freeze must stay a plugin switch');
}
if (!/\.mr-rail\.still \.p\{animation:none/.test(src)) {
  throw new Error('no .mr-rail.still rule — the switch would have nothing to toggle');
}
const motionBtn = findNode(openTree, nd => String(nd.props.className || '').indexOf('mr-motion') >= 0);
if (!motionBtn) throw new Error('the rail lost its motion switch');
if (motionBtn.props['aria-pressed'] !== 'true') {
  throw new Error('motion must default ON (aria-pressed true), got ' + motionBtn.props['aria-pressed']);
}
if (!railClasses.some(c => c === 'still')) {
  /* Nothing else may add .still at rest: the default state has to be moving. */
} else {
  throw new Error('rail rendered with .still by default — particles would start frozen');
}
const particles = classesOf(fillNode).filter(cl => cl === 'p');
if (particles.length < 1) {
  throw new Error('the particle field did not render inside the fill');
}
const styles = classesOf(fillNode);
if (styles.length === 0) throw new Error('fill rendered with no children — particles are missing');
for (const nd of (Array.isArray(fillNode.props.children) ? fillNode.props.children : [fillNode.props.children])) {
  if (!nd || !nd.props || nd.props.className !== 'p') continue;
  const st = nd.props.style || {};
  if (!(st.width && st.height && st.left !== undefined && st.top !== undefined)) {
    throw new Error('a particle is missing its geometry: ' + JSON.stringify(st));
  }
  if (!(typeof st.opacity === 'number' && st.opacity > 0 && st.opacity <= 1)) {
    throw new Error('particle opacity out of range: ' + st.opacity);
  }
  if (!/^\d+(\.\d+)?s$/.test(String(st['--dur'] || ''))) {
    throw new Error('particle is missing a valid --dur: ' + st['--dur']);
  }
  if (!/^-\d+(\.\d+)?s$/.test(String(st['--delay'] || ''))) {
    throw new Error('particle delay must be negative so the field is mid-flight on mount: ' + st['--delay']);
  }
  if (!/^\d+(\.\d+)?px$/.test(String(st['--run'] || ''))) {
    throw new Error('particle is missing a per-grain --run: ' + st['--run']);
  }
  if (!/^\d+(\.\d+)?px$/.test(String(st['--bob'] || ''))) {
    throw new Error('particle is missing a per-grain --bob: ' + st['--bob']);
  }
}

/* The first cut of the field failed on measurable grounds, not taste: 1-2px
   grains travelling 16px over 2.9s is 5px/s, about 0.09px per frame at 60Hz,
   which the eye reads as noise rather than motion, and every grain shared one
   travel/bob so it looked like a single sheet sliding by. Guard both numbers
   here so a future "make it subtler" edit cannot silently reintroduce the
   defect. Thresholds: a grain must cross at least 3px/s AND the field must
   carry at least two distinct depth bands. */
const grainRuns = [];
const grainSpeeds = [];
for (const nd of (Array.isArray(fillNode.props.children) ? fillNode.props.children : [fillNode.props.children])) {
  if (!nd || !nd.props || nd.props.className !== 'p') continue;
  const st = nd.props.style || {};
  const run = parseFloat(String(st['--run'] || '0'));
  const dur = parseFloat(String(st['--dur'] || '0'));
  if (run > 0 && dur > 0) {
    grainRuns.push(run);
    grainSpeeds.push(run / dur);
  }
}
const distinctRuns = new Set(grainRuns).size;
if (distinctRuns < 2) {
  throw new Error('the particle field has no depth: only ' + distinctRuns +
    ' distinct --run value(s) — it will read as one sheet sliding by');
}
const slowest = Math.min.apply(null, grainSpeeds);
if (!(slowest >= 3)) {
  throw new Error('slowest grain runs at ' + slowest.toFixed(2) +
    'px/s — under 3px/s is below the threshold where drift reads as motion');
}

/* Direction. The field rides inside the effort fill, which grows LEFTWARD TO
   RIGHTWARD as the rung rises, so the sand must travel right too — motion
   perpendicular to the gauge it lives in reads as a sandstorm, not as flow.
   Assert the keyframe's endpoint is the origin shifted toward +x. */
if (!/@keyframes mr-drift\{[\s\S]*?100%\{transform:translate\(calc\(-50% \+ var\(--run/.test(src.replace(/\n\s*/g, ''))) {
  throw new Error('the particle endpoint is not shifted right by --run — the grains flow across the fill, not along it');
}
if (/@keyframes mr-drift\{[\s\S]*?100%\{transform:translate\(calc\(-50% - var\(--run/.test(src.replace(/\n\s*/g, ''))) {
  throw new Error('the particle endpoint subtracts --run — that is the old leftward/upward direction');
}
if (!/@keyframes mr-sway\{[^}]*translate:0 calc\(var\(--bob/.test(src.replace(/\n\s*/g, ''))) {
  throw new Error('the bob track must be vertical now that travel is horizontal');
}
/* Effort picks must be optimistic. Both surfaces had the same bug: setEfforts
   ran only after `await api('select')` resolved, so the knob sat on the OLD
   rung for the whole host round trip. A slider that lags its own thumb reads as
   broken even when the write lands. Assert the local update precedes the await
   in every pickEffort, and that it does not raise `busy` (which dims the rail). */
{
  const fnStarts = [];
  const re = /const pickEffort = async \(effort\) => \{/g;
  let m;
  while ((m = re.exec(src)) !== null) fnStarts.push(m.index);
  if (fnStarts.length !== 2) {
    throw new Error('expected one pickEffort per surface (dock + hero), found ' + fnStarts.length);
  }
  for (const at of fnStarts) {
    const body = src.slice(at, at + 1200);
    const optimistic = body.indexOf("setEfforts(e => ({ ...e, currentEffort: effort }))");
    const awaitAt = body.indexOf("await api('select'");
    if (optimistic < 0) {
      throw new Error('pickEffort does not set the rung locally — the knob would wait for the host');
    }
    if (awaitAt < 0) throw new Error('pickEffort no longer calls api(select)');
    if (optimistic > awaitAt) {
      throw new Error('pickEffort updates the rung AFTER awaiting the host — ' +
        'that is the 1-2s lag the slider must not have');
    }
    if (body.indexOf('setBusy(true)') >= 0) {
      throw new Error('pickEffort raises busy — the rail dims and goes inert on every pick');
    }
  }
}
if (openClasses.some(c => c.includes('mr-chip'))) {
  throw new Error('mr-chip survived the redesign — the old button row is still rendering somewhere');
}

const openText = textOf(openTree).join(' ');
for (const needle of ['WorkBuddy', 'Zhipu', 'deepseek-v4.1-flash', '最近使用', '提供方']) {
  if (!openText.includes(needle)) throw new Error('popover text is missing: ' + needle);
}
console.log('open text sample =', openText.slice(0, 160).replace(/\s+/g, ' '));

/*
 * Credits badge. useCredits appends slots 8..11 AFTER the shipped eight, so
 * seeding slot 8 with a snapshot is enough to drive the whole badge path — and
 * leaving it unset (the case above) must render no badge at all, which is what
 * the run above proved by still passing.
 */
const now = Date.now();
const DAY = 86400000;
dockFrame.slots[8] = {
  ok: true, missing: false, path: '/tmp/latest.json',
  snapshot: {
    /* Deliberately a 15-day snapshot even though the panel now speaks in 3
       days: the plugin must re-cut it from package detail instead of trusting
       the stored totals, and a fixture that already matched would prove
       nothing. package b (9 days out) is what the re-cut must drop. */
    schema: 'credits-expiry-snapshot/v1', generatedAtMs: now - 2 * 3600000, windowDays: 15,
    providers: {
      workbuddy: {
        /* Real package detail, deliberately split: only part of the 17.92
           window total expires at the nearest instant. With packages: [] the
           old tooltip pinned all 17.92 to that single moment and no assertion
           could see it was wrong. */
        accounts: [{ scope: 'cn/aa', nickname: 'Gumife', total: 7596.9, expiringSoon: 17.92,
          nearestExpiryMs: now + 3 * DAY,
          packages: [
            { name: 'a', remain: 12.92, expiresAtMs: now + 3 * DAY },
            { name: 'b', remain: 5, expiresAtMs: now + 9 * DAY },
          ] }],
        errors: [{ scope: 'cn/bb', nickname: 'x', error: 'boom' }],
        expiringSoon: 17.92, overdueRemain: 0, nearestExpiryMs: now + 3 * DAY,
      },
      qoder: {
        accounts: [{ scope: 'qoder-1', nickname: 'G3', total: 0, expiringSoon: 0, packages: [] }],
        errors: [], expiringSoon: 0, overdueRemain: 0,
      },
      /* The quiet case: nothing is expiring, but one account could not be read.
         It must show as a muted "?1", not an amber warning and not nothing. */
      zhipu: {
        accounts: [], errors: [{ scope: 'zhipu/x', nickname: 'y', error: '401' }],
        expiringSoon: 0, overdueRemain: 0,
      },
    },
  },
};
const badgeTree = expand(dock[0].component(dockProps));
const badgeText = textOf(badgeTree).join(' ');
console.log('badge text sample =', badgeText.slice(0, 120).replace(/\s+/g, ' '));
if (!classesOf(badgeTree).some(c => c === 'x' || c.startsWith('x '))) {
  throw new Error('no .x badge element rendered while a snapshot was seeded');
}
/* 12.92, not the stored 17.92: the badge must be the 3-day re-cut. */
if (!/12\.9·3d/.test(badgeText)) {
  throw new Error('the workbuddy badge did not show the 3-day amount·days — got: ' + badgeText.replace(/\s+/g, ' ').slice(0, 200));
}
/* A channel with nothing expiring and nothing failing gets NO badge, not a zero. */
if (/0·\d+d|\?0\b/.test(badgeText)) {
  throw new Error('a clean channel grew a zero badge — it must render nothing');
}

/*
 * The tooltip sentence. This fixture is the reason the bug survived: with an
 * empty packages[] there is no way to tell a window total apart from the
 * amount expiring at the first instant, so the false "1904 分将在 <instant>
 * 过期" read as correct. Seed real package detail so the claim is checked
 * against something, then assert the two figures stay separate.
 */
const titled = findNode(badgeTree, n => n.props && typeof n.props.title === 'string'
  && n.props.title.indexOf('过期') >= 0);
if (!titled) throw new Error('the expiring badge lost its tooltip sentence');
const tip = titled.props.title;
console.log('credits tooltip =', tip.replace(/\n/g, ' | ').slice(0, 220));
/* The wrong shape is an amount followed DIRECTLY by a timestamp; the right
   shape puts "3 天内陆续过期" between them and names the instant separately. */
if (/分将在 \d\d-\d\d \d\d:\d\d/.test(tip)) {
  throw new Error('the tooltip still pins the whole window total to one instant: ' + tip);
}
if (!/3 天内陆续过期/.test(tip)) {
  throw new Error('the tooltip does not name the 3-day window — got: ' + tip);
}
if (!/到期 12\.9 分/.test(tip)) {
  throw new Error('the tooltip does not name the amount expiring at the first instant — got: ' + tip);
}
/* The fixture's 17.92 total covers a package 9 days out, so a 3-day panel must
   show 12.92 — if the stored total leaks through, the window change did not
   take. */
if (/17\.9 分将在/.test(tip)) {
  throw new Error('the tooltip still shows the 15-day total under a 3-day window: ' + tip);
}
if (!/12\.9 分将在 3 天内/.test(tip)) {
  throw new Error('the tooltip does not show the re-cut 3-day total — got: ' + tip);
}
/* The quiet case (read failures only) renders as ?N, and must not be coloured
   like an imminent loss — that is what the .quiet class is for. */
if (!/\?1\b/.test(badgeText)) {
  throw new Error('a channel with only unreadable accounts showed nothing — expected "?1"');
}
const badgeClasses = classesOf(badgeTree).filter(c => c === 'x' || c === 'x dead' || c === 'x quiet');
if (!badgeClasses.includes('x quiet')) {
  throw new Error('the read-failure-only badge is not muted (.x quiet) — it would read as an expiry warning');
}
if (!badgeClasses.includes('x')) {
  throw new Error('the expiring-credits badge must be the amber .x, not .dead/.quiet');
}
if (!/快照 2h/.test(badgeText)) {
  throw new Error('the footer age label did not render — got: ' + badgeText.replace(/\s+/g, ' ').slice(0, 200));
}
if (!badgeText.includes('刷新')) throw new Error('the refresh button is missing from the footer');
console.log('credits badge = amount·days on the expiring channel, nothing elsewhere');

/*
 * Provider failures and model badges. The host's own selector prints one
 * warning row per failed group and renders the model badge as a Tag; the radar
 * used to swallow both, leaving an unexplained hole in the column and dropping
 * a status label the wire was already carrying. Re-render with a failure and a
 * badge seeded, then put the fixture back so the later route stub sees the
 * clean catalog it expects.
 */
const cleanCatalog = dockFrame.slots[4];
dockFrame.slots[4] = {
  ...cleanCatalog,
  providers: cleanCatalog.providers.map(p => p.provider !== 'workbuddy' ? p : {
    ...p,
    models: p.models.map((m, i) => i === 0 ? { ...m, badge: { text: 'BETA', tone: 'warning' } } : m),
  }),
  failures: [
    { id: 'trae', name: 'Trae', message: 'token expired' },
    { id: '*', name: '', message: 'registry unreachable' },
  ],
};
const failTree = expand(dock[0].component(dockProps));
const failText = textOf(failTree).join(' ');
const failClasses = classesOf(failTree);
console.log('failure rows =', failText.slice(0, 140).replace(/\s+/g, ' '));
if (!failClasses.some(c => c === 'mr-fails')) {
  throw new Error('a catalog with failures rendered no .mr-fails container — the warning rows are missing');
}
if (!/Trae 加载失败：token expired/.test(failText)) {
  throw new Error('the named-provider warning did not render — got: ' + failText.replace(/\s+/g, ' ').slice(0, 200));
}
if (!/提供方列表加载失败：registry unreachable/.test(failText)) {
  throw new Error('the failed-provider-LIST warning did not render — got: ' + failText.replace(/\s+/g, ' ').slice(0, 200));
}
if (!failClasses.some(c => c === 'bg warning')) {
  throw new Error('the seeded badge did not render as a toned chip');
}
if (!failText.includes('BETA')) {
  throw new Error('the badge text is missing from the rendered row');
}
console.log('failures and badges = warning row per failed group, toned chip on the model');

/* A healthy catalog must render NO failure container at all — not an empty one. */
dockFrame.slots[4] = cleanCatalog;
const healthyTree = expand(dock[0].component(dockProps));
if (classesOf(healthyTree).some(c => c === 'mr-fails')) {
  throw new Error('a healthy catalog still rendered the failure container');
}

/*
 * Lazy loading. The pill reads "模型雷达" and the route lives only in its title,
 * so a mount-time catalog read bought nothing and cost two round trips per
 * mounted session. The effect stubs above are no-ops, so assert on the source:
 * no effect may call load() without first testing `open`.
 */
const mountsThatLoad = src.match(/useEffect\(\(\)\s*=>\s*\{\s*load\(\);/g) || [];
if (mountsThatLoad.length > 0) {
  throw new Error('a mount-time load() survived — the dock must not fetch before the first open');
}
if (!/if\s*\(!open\)\s*return;/.test(src)) {
  throw new Error('the open-gated effect is missing its `if (!open) return` guard');
}
console.log('mount-time fetches = 0 (catalog is read on first open only)');

/* The popover follows the trigger, not just the window. */
if (!/anchorWatcher/.test(src)) {
  throw new Error('no ResizeObserver on the trigger — a growing composer would detach the popover');
}
console.log('trigger ResizeObserver = present');

/*
 * Placement must flip. The New Session row sits ~52px from the top of the
 * viewport, so "always open upward" would hang most of a 160px panel off the
 * top edge (the old Math.max(160, above) floor did exactly that).
 *
 * React is stubbed, so drive the branch on the source text rather than
 * simulating a render: both anchors must be produced, the flip condition must
 * exist, and the floor must be gone.
 */
const flat = src.replace(/\n/g, ' ');
/* Comments may legitimately quote the old bug; strip them (with newlines still
   present, or a // comment would swallow the rest of the flattened source). */
const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ').replace(/\n/g, ' ');
if (!/bottom:\s*window\.innerHeight - rect\.top \+ POPOVER_GAP/.test(code)) {
  throw new Error('upward placement lost its height-independent bottom anchor');
}
if (!/top:\s*rect\.bottom \+ POPOVER_GAP/.test(code)) {
  throw new Error('no downward placement — a trigger near the top would overflow the viewport');
}
if (!/openUp\s*=\s*above\s*>=\s*POPOVER_MIN\s*\|\|\s*above\s*>=\s*below/.test(code)) {
  throw new Error('the up/down choice must consider both the minimum panel and the room on each side');
}
if (/Math\.max\(\s*160\s*,\s*above\s*\)/.test(code)) {
  throw new Error('the old 160px floor is back — it pins a panel taller than the space above it');
}
if (!/style:\s*\{\s*left:\s*pos\.left,\s*top:\s*pos\.top,\s*bottom:\s*pos\.bottom/.test(code)) {
  throw new Error('the popover must be able to receive either anchor (top or bottom)');
}
console.log('placement = flips down when the row is near the top, otherwise anchors by bottom');

/*
 * ── the callbacks actually run ───────────────────────────────────────────
 *
 * Everything above asserts on the rendered tree. That is how a reference to an
 * undefined variable shipped inside loadCredits(): the render passed, the effect
 * stub never invoked it, and the panel would have thrown the first time anyone
 * opened it. So run the effects for real against a fetch stub and fail if any of
 * them throws.
 */
const fetched = [];
const snapshot = dockFrame.slots[8].snapshot;
const catalog = dockFrame.slots[4];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  fetched.push(body.command);
  const answer = body.command === 'catalog'
    ? { ok: true, ...catalog }
    : body.command === 'modelInfo'
      ? { ok: true, efforts: [], defaultEffort: null }
      : body.command === 'select'
        ? { ok: true, selection: catalog.current }
        : body.command === 'creditsRefresh'
          ? { ok: false, error: '报告脚本退出码 1', manual: 'node "x/report.mjs" --snapshot="y/latest.json"' }
          : { ok: true, missing: false, path: '/tmp/latest.json', snapshot };
  return { json: async () => answer };
};
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = { innerWidth: 1200, innerHeight: 900, addEventListener: () => {}, removeEventListener: () => {} };
runEffects = true;

expand(dock[0].component(dockProps));
await new Promise(r => setTimeout(r, 0));
await new Promise(r => setTimeout(r, 0));
if (effectErrors.length > 0) {
  throw new Error('an effect threw on first open: ' + effectErrors.map(e => e.message).join(' | '));
}
if (rejections.length > 0) {
  throw new Error('an async callback rejected on first open: ' + rejections.join(' | '));
}
for (const command of ['catalog', 'credits']) {
  if (!fetched.includes(command)) throw new Error('opening the panel did not fetch ' + command);
}
/* Opening the panel must never be the thing that reaches upstream. */
if (fetched.includes('creditsRefresh')) {
  throw new Error('creditsRefresh fired on open — only the button may trigger it');
}
console.log('effects run clean; open fetches =', JSON.stringify([...new Set(fetched)]));

/* Now press the refresh button for real and make sure its failure path shows
   the recovery command instead of swallowing it. */
const findClass = (node, cls, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => findClass(n, cls, out)); return out; }
  if (typeof node.props?.className === 'string' && node.props.className.includes(cls)) out.push(node);
  findClass(node.props?.children, cls, out);
  return out;
};
const refreshBtn = findClass(expand(dock[0].component(dockProps)), 'mr-refresh')[0];
if (!refreshBtn) throw new Error('no refresh button in the open panel to exercise');
refreshBtn.props.onClick();
await new Promise(r => setTimeout(r, 0));
await new Promise(r => setTimeout(r, 0));
if (effectErrors.length > 0) {
  throw new Error('the refresh click threw: ' + effectErrors.map(e => e.message).join(' | '));
}
if (rejections.length > 0) {
  throw new Error('the refresh click rejected: ' + rejections.join(' | '));
}
if (!fetched.includes('creditsRefresh')) throw new Error('the refresh button did not call creditsRefresh');
const afterFail = textOf(expand(dock[0].component(dockProps))).join(' ');
if (!/报告脚本退出码|node "/.test(afterFail)) {
  throw new Error('a failed refresh left no explanation in the footer — got: ' + afterFail.slice(0, 200));
}
console.log('refresh button = one creditsRefresh call, failure surfaces the manual command');

/* ── the popovers must leave the composer's DOM subtree ──────────────────
 * .mr-pop is position:fixed, but the composer dock carries backdrop-filter,
 * which makes it a containing block for fixed descendants (the same way
 * transform does). Rendering the menu inside it meant "fixed" resolved
 * against the dock, so the popup opened shifted away from its trigger. A
 * portal to document.body restores viewport coordinates. This is a MOUNT
 * assertion, not a CSS one: it fails the moment someone drops the portal. */
const { readFileSync: readSourceSync } = await import('node:fs');
const srcText = String(readSourceSync(new URL('./client.js', import.meta.url), 'utf8'));
const requiredNames = [...srcText.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map(m => m[1]);
if (!requiredNames.includes('react-dom')) throw new Error('client must require react-dom for createPortal');
if (!requiredNames.every(n => n === 'react' || n === 'react-dom')) {
  throw new Error('unexpected dependency: ' + JSON.stringify([...new Set(requiredNames)]));
}
const portalCount = (srcText.match(/ReactDOM\.createPortal\(/g) || []).length;
if (portalCount !== 2) throw new Error('both popovers must be portalled; found ' + portalCount);
if (!/ReactDOM\.createPortal\([\s\S]{0,6000}?document\.body/.test(srcText)) {
  throw new Error('createPortal does not target document.body');
}
console.log('portals = both popovers mount on document.body (not the backdrop-filtered dock)');

console.log('\nOK — client half parses, registers the bypass entry on both the composer dock and the new-session row, shadows nothing, matches each row\'s baseline, loads lazily, renders closed and open.');
