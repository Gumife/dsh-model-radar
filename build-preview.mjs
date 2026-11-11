/**
 * build-preview.mjs — renders the REAL components from client.js into HTML and
 * screenshots that, so the picture proves the shipped CSS and the shipped
 * element tree, not a hand-copied mock.
 *
 * What is real: every className, every DOM nesting decision, the CSS template
 * literal (extracted, never retyped), the dictionary text.
 * What is synthetic: the catalog payload and React itself (a hook-compatible
 * stub), because there is no browser-authenticated session available to this
 * process.
 *
 * Usage: node build-preview.mjs   ->  preview.html
 */
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

/* ── real CSS, extracted byte-for-byte ─────────────────────────────────── */
const cssStart = src.indexOf('const CSS = `');
const cssFrom = src.indexOf('`', cssStart) + 1;
const cssTo = src.indexOf('`;', cssFrom);
if (cssStart < 0 || cssTo < 0) throw new Error('cannot locate the CSS template literal');
const CSS = src.slice(cssFrom, cssTo);

/* ── load the module through the same loader contract the browser uses ─── */
let loaded = null;
new Function('window', src)({ __ModuleLoader__: { load: (d) => { loaded = d; } } });

const frames = [];
const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props || {}), children: children.length > 1 ? children : children[0] },
  }),
  Fragment: Symbol('Fragment'),
  useState: (init) => {
    const f = frames[frames.length - 1];
    const i = f.cursor++;
    if (!(i in f.slots)) f.slots[i] = typeof init === 'function' ? init() : init;
    return [f.slots[i], (next) => { f.slots[i] = typeof next === 'function' ? next(f.slots[i]) : next; }];
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (init) => {
    const f = frames[frames.length - 1];
    const i = f.cursor++;
    if (!(i in f.slots)) f.slots[i] = { current: init === undefined ? null : init };
    return f.slots[i];
  },
};
function withFrame(key, fn) {
  let f = frames.find(x => x.key === key);
  if (!f) { f = { key, cursor: 0, slots: {} }; frames.push(f); }
  f.cursor = 0;
  frames.push(f);
  try { return fn(); } finally { frames.pop(); }
}

const mod = loaded.factory((n) => { if (n === 'react') return React; throw new Error('unexpected require ' + n); });

const dicts = {};
const registrations = [];
const ctx = {
  effect: (fn) => fn(),
  slots: { inject: (k, cb) => cb(), register: (o, c) => { registrations.push({ o, c }); return () => {}; } },
  locale: { register: (ns, d) => { dicts[ns] = d; return () => {}; }, bind: (ns) => (k) => dicts[ns].zh[k] || k },
};
mod.apply(ctx);
const t = ctx.locale.bind('dsh-model-radar');

/* ── realistic catalog: 18 providers, one with zero models (the v1 bug) ── */
const mk = (id, ctxWin, vision, isCur) => ({ id, name: id, contextWindow: ctxWin, inputModalities: vision ? ['text', 'image'] : ['text'], __cur: isCur });
const providers = [
  { provider: 'deepseek', name: 'DeepSeek', models: [] },
  { provider: 'deepseek-account', name: 'DeepSeek Account', models: [mk('deepseek-v4.1-flash', 128000, true, true), mk('deepseek-v4.1', 128000, true)] },
  { provider: 'agnes', name: 'agnes', models: [mk('agnes-v2', 64000, false)] },
  { provider: 'ofm', name: 'ofm', models: [mk('kilo-auto', 200000, true), mk('qfmodel', 32000, false), mk('glm-5.3-free', 128000, false)] },
  { provider: 'workbuddy', name: 'WorkBuddy', models: [mk('deepseek-v4.1-flash', 128000, true), mk('deepseek-v4.1', 128000, true)] },
  { provider: 'workbuddy-global', name: 'WorkBuddy Global', models: [mk('deepseek-v4.1', 128000, true)] },
  { provider: 'kilo', name: 'Kilo Auto', models: [mk('kilo-auto', 200000, true)] },
  { provider: 'kiro', name: 'Kiro', models: [mk('kiro-sonnet', 200000, true)] },
  { provider: 'moonshot', name: 'Moonshot', models: [mk('kimi-k2', 256000, false)] },
  { provider: 'openai', name: 'OpenAI', models: [mk('gpt-5.1', 400000, true)] },
  { provider: 'openrouter', name: 'OpenRouter', models: [mk('qwen3-max', 131072, false)] },
  { provider: 'qoder', name: 'Qoder', models: [mk('qfmodel', 32000, false)] },
  { provider: 'siliconflow', name: 'Siliconflow', models: [mk('glm-5.3', 128000, false)] },
  { provider: 'volcengine', name: 'Volcengine', models: [mk('doubao-pro', 256000, true)] },
  { provider: 'xai', name: 'xAI', models: [mk('grok-4', 256000, true)] },
  { provider: 'zhipu', name: 'Zhipu', models: [mk('glm-5.3', 128000, false)] },
  { provider: 'bailian', name: 'Bailian', models: [mk('qwen3-max', 131072, false)] },
  { provider: 'minimax', name: 'MiniMax', models: [mk('minimax-m2', 200000, false)] },
];
const catalog = {
  providers,
  current: { provider: 'deepseek-account', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
  recent: [
    { provider: 'ofm', model: 'kilo-auto' },
    { provider: 'qoder', model: 'qfmodel' },
  ],
};
const efforts = { list: [{ id: 'low', name: '低' }, { id: 'medium', name: '中' }, { id: 'high', name: '高' }], currentEffort: 'high' };

/* A credits snapshot in the exact shape the host returns, so the preview shows
   real badge widths inside the real 196px column. Figures are the ones this
   machine actually reported on 2026-10-24. */
const NOW = Date.now();
const DAY = 86400000;
const creditsMeta = {
  ok: true, missing: false, path: '~/.dsh/credits-expiry/latest.json',
  snapshot: {
    schema: 'credits-expiry-snapshot/v1', generatedAtMs: NOW - 2 * 3600000, windowDays: 15,
    providers: {
      workbuddy: {
        accounts: [{ scope: 'cn/ff1b', nickname: '1', total: 7596.9, expiringSoon: 1257.92,
          nearestExpiryMs: NOW + 3 * DAY, packages: [] }],
        errors: [], expiringSoon: 1257.92, overdueRemain: 0, nearestExpiryMs: NOW + 3 * DAY,
      },
      'workbuddy-global': {
        accounts: [{ scope: 'global/1698', nickname: 'giligulu9527', total: 350, expiringSoon: 999.8,
          nearestExpiryMs: NOW + DAY, packages: [] }],
        errors: [], expiringSoon: 999.8, overdueRemain: 0, nearestExpiryMs: NOW + DAY,
      },
      trae: {
        accounts: [{ scope: 'cn/3682', nickname: '用户2572537802', total: 5899.97, expiringSoon: 754.46,
          nearestExpiryMs: NOW + 7 * DAY, packages: [] }],
        errors: [{ scope: 'cn/2701', nickname: '豆包大模型', error: 'token expired' }],
        expiringSoon: 754.4568, overdueRemain: 0, nearestExpiryMs: NOW + 7 * DAY,
      },
      'trae-global': { accounts: [], errors: [], expiringSoon: 0, overdueRemain: 0 },
      qoder: {
        accounts: [{ scope: 'qoder-a', nickname: 'Gumife', total: 0, expiringSoon: 0, packages: [] }],
        errors: [{ scope: 'qoder-b', nickname: 'Gumife2', error: '401 TOKEN_EXPIRE' }],
        expiringSoon: 0, overdueRemain: 0,
      },
    },
  },
};

const expand = (node, depth = 0) => {
  if (depth > 80) throw new Error('too deep');
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(n => expand(n, depth + 1));
  if (typeof node.type === 'function') return withFrame(node.type, () => expand(node.type(node.props || {}), depth + 1));
  if (node.props) return { ...node, props: { ...node.props, children: expand(node.props.children, depth + 1) } };
  return node;
};

/* ── render the dock OPEN with the catalog fed in ──────────────────────── */
const dock = registrations.find(r => r.o.name === 'conversation.composer.dock');
const hero = registrations.find(r => r.o.name === 'conversation.hero.options');
if (!dock) throw new Error('no conversation.composer.dock registration');
if (!hero) throw new Error('no conversation.hero.options registration');
const dockProps = { ...dock.o.inject('session-preview'), surface: 'dock', t };
const heroProps = { ...hero.o.inject('session-preview'), surface: 'hero', t };

/* RadarDock state frame is created on first render; seed it and re-render. */
expand(dock.c(dockProps));
const dockFrame = frames.find(f => f.key !== undefined && f.slots[0] === false && f.slots[1] === false);
if (!dockFrame) throw new Error('dock state frame not found');
dockFrame.slots[0] = true;              /* open */
dockFrame.slots[4] = catalog;           /* data (useRadar) */
dockFrame.slots[6] = { left: 0, bottom: 0, maxHeight: 470 };  /* pos */
dockFrame.slots[7] = efforts;           /* efforts ladder */
dockFrame.slots[8] = creditsMeta;       /* credits snapshot (useCredits) */

const tree = expand(dock.c(dockProps));

/* Hero surface: same component, closed (a brand-new session has nothing open).
 * Both registrations share the component function, so the frame is reused —
 * reset it to the closed shape or the hero row would render an open popover. */
dockFrame.slots[0] = false;
dockFrame.slots[4] = null;
dockFrame.slots[6] = null;
dockFrame.slots[7] = { list: [], currentEffort: '' };
dockFrame.slots[8] = null;
const heroTree = expand(hero.c(heroProps));

/* ── serialize to HTML (void elements + boolean props handled) ──────────── */
const VOID = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);
const ATTR = {
  className: 'class', htmlFor: 'for', ariaExpanded: 'aria-expanded',
  ariaHaspopup: 'aria-haspopup', ariaHidden: 'aria-hidden',
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function serialize(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return esc(node);
  if (Array.isArray(node)) return node.map(serialize).join('');
  if (node.type === React.Fragment || node.type === Symbol.for('Fragment')) return serialize(node.props.children);
  /* Symbols created by the stub: compare by description. */
  if (typeof node.type === 'symbol') return serialize(node.props.children);
  const tag = node.type;
  const attrs = [];
  for (const [k, v] of Object.entries(node.props || {})) {
    if (k === 'children' || k === 'ref' || v === undefined || v === null) continue;
    if (k === 'style') {
      const decl = Object.entries(v).map(([p, val]) => p.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()) + ':' + val).join(';');
      attrs.push('style="' + esc(decl) + '"');
      continue;
    }
    if (k === 'key') continue;
    const name = ATTR[k] || k;
    if (v === false) continue;
    if (v === true) { attrs.push(name); continue; }
    if (typeof v === 'function') continue;
    attrs.push(name + '="' + esc(v) + '"');
  }
  const open = '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '');
  if (VOID.has(String(tag))) return open + '>';
  if (tag === 'style') return open + '>' + node.props.children + '</style>';
  return open + '>' + serialize(node.props.children) + '</' + tag + '>';
}

const body = serialize(tree);
const heroBody = serialize(heroTree);

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-model-radar · 真实组件渲染</title>
<style>
  /* Stand-ins for the host's theme tokens. The plugin only ever writes
     var(--dsw-*)/var(--ds-*); these are the shipped LIGHT values, lifted
     verbatim from dsh-client-ui-theme/lib/client.js. Anything the plugin
     references but this block omits silently falls back to nothing — an
     undefined --dsw-elevation-prominent or --dsw-specific-menu makes the
     popover melt into the composer card, which is a preview defect, not a
     plugin one. Keep every token the plugin touches defined here. */
  :root{
    /* surfaces */
    --dsw-alias-bg-base:#ffffff; --dsw-alias-bg-layer-1:#f6f7f9; --dsw-alias-bg-layer-2:#eceef2;
    --dsw-alias-bg-overlay:#ffffff;
    --dsw-menu-surface-fill:#f8f9fa94; --dsw-specific-menu:var(--dsw-menu-surface-fill);
    --dsw-menu-backdrop-filter:blur(40px) saturate(150%);
    /* borders */
    --dsw-alias-border-l1:#e4e7eb; --dsw-alias-border-l2:#cbd1d9;
    --dsw-alias-border-l3:#0000001f; --dsw-alias-border-l4:#00000029;
    /* labels */
    --dsw-alias-label-primary:#1b1f24; --dsw-alias-label-secondary:#6b7280;
    --dsw-alias-label-caption:#81858c; --dsw-alias-label-tertiary:#81858c;
    --dsw-alias-label-dimmed:#adb2b8;
    /* fills & focus */
    --dsw-alias-interactive-bg-hover:#2631480f;
    --dsw-alias-brand-primary:#3b6cf6;
    --dsw-alias-state-business-primary:#4176e6;
    --dsw-alias-state-success-primary:#12855a; --dsw-alias-state-error-primary:#c62828;
    --dsw-focus-ring-color:var(--dsw-alias-state-business-primary);
    --dsw-focus-ring-width:2px;
    /* scrollbars */
    --dsw-alias-scrollbar-bg-l2:#e5e5e5; --dsw-alias-scrollbar-hover-l2:#d4d4d4;
    /* elevation: stroke + three tiers */
    --dsw-elevation-stroke-color:var(--dsw-alias-border-l4);
    --dsw-elevation-stroke:0 0 0 .5px var(--dsw-elevation-stroke-color);
    --dsw-elevation-soft:var(--dsw-elevation-stroke), 0 4px 16px 0 #00000008, 0 0 24px 0 #00000008;
    --dsw-elevation-panel:var(--dsw-elevation-stroke), 0 3px 8px 0 #00000008, 0 0 16px 0 #00000005;
    --dsw-elevation-prominent:var(--dsw-elevation-stroke), 0 3px 8px 0 #0000000a, 0 0 20px 0 #0000000d;
    /* radii */
    --dsw-radius-xs:4px; --dsw-radius-sm:8px; --dsw-radius-md:12px; --dsw-radius-lg:16px;
    /* type */
    --ds-font-family-code:"SF Mono","JetBrains Mono","Fira Code",Consolas,"Liberation Mono",Menlo,Courier,monospace;
  }
  html,body{margin:0;height:100%}
  body{background:#eef1f5;font-family:"Segoe UI",system-ui,"Microsoft YaHei",sans-serif;color:#1b1f24}
  .stage{position:relative;width:1086px;height:722px;overflow:hidden}

  /* The composer card, so the pill sits where it will actually sit. */
  .composer{position:absolute;left:16px;right:16px;bottom:16px;height:96px;border-radius:14px;
    background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);
    box-shadow:0 1px 3px rgba(16,24,40,.06);padding:12px 14px;box-sizing:border-box;
    display:flex;flex-direction:column;justify-content:space-between}
  .composer .hint{font-size:12.5px;color:var(--dsw-alias-label-secondary)}
  .composer .toolrow{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
  .composer .spacer{flex:1}
  .ship{display:inline-flex;align-items:center;gap:6px;border:1px solid transparent;border-radius:7px;
    padding:4px 9px;font-size:12px;color:var(--dsw-alias-label-secondary)}
  /* The real ContextMeter box: 13px font over a 20px line box plus 1px/8px
     padding = 22px. This is the neighbour the dock pill has to match, so it is
     modelled with the shipped numbers rather than the generic .ship look. */
  .ship.usage{box-sizing:border-box;border:0;border-radius:var(--dsw-radius-sm);
    padding:1px 8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
  .ship .dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
  /* Shipped neighbours, at their real box metrics (context meter 1px 8px over a
     20px line; credits readout 2px 6px over 18px) so the measured heights in
     the probe are the ones the plugin actually has to line up with. */
  #dock .mr-pill{vertical-align:middle}
  .hero{position:absolute;left:16px;right:16px;top:16px;padding:0 4px}
  .herorow{display:flex;align-items:center;gap:2px;
    background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);
    border-radius:14px;padding:10px 12px;box-shadow:0 1px 3px rgba(16,24,40,.06)}
  .hero .hspacer{flex:1}
  /* The shipped workspace chip: min-height 28px, 13px/20px, weight 500, padding 0 8px. */
  .hchip{display:inline-flex;align-items:center;gap:4px;box-sizing:border-box;
    border-radius:var(--dsw-radius-sm);min-height:28px;padding:0 8px;
    color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}
  .hchip .hfolder,.hchip .hchev{color:var(--dsw-alias-label-caption)}
  .probe{position:absolute;left:16px;top:120px;right:16px;font-family:"Consolas",monospace;
    font-size:12px;line-height:19px;color:var(--dsw-alias-label-primary);
    white-space:pre-wrap;padding:8px 10px;border-radius:var(--dsw-radius-sm);
    background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
  ${CSS}
</style></head>
<body><div class="stage">
  <div class="composer">
    <div class="hint">输入消息，或按 ⌘K 打开命令面板</div>
    <div class="toolrow">
      <span class="ship"><span class="dot"></span>activity</span>
      <span class="ship usage">usage</span>
      <!-- our dock entry is injected here: pill + the open popover it owns -->
      <div id="dock"></div>
      <span class="spacer"></span>
      <span class="ship">deepseek-v4.1-flash · 高</span>
    </div>
  </div>

  <!-- New Session row. The host renders this instead of the composer dock row
       while the session is brand new, so the entry has to exist here too, at
       that row's own baseline. -->
  <div class="hero">
    <div class="herorow">
      <span class="hchip"><span class="hfolder">▸</span>deepseek-workspace<span class="hchev">⌄</span></span>
      <span class="hspacer"></span>
      <div id="hero"></div>
    </div>
  </div>

  <div id="probe" class="probe"></div>
</div>
<script>
  document.getElementById('dock').innerHTML = ${JSON.stringify(body)};
  document.getElementById('hero').innerHTML = ${JSON.stringify(heroBody)};
  /* The popover is position:fixed in the plugin; in this static stage we place
     it exactly as place() would — same anchors, same flip condition, same cap —
     so the preview cannot drift from the shipped geometry. Currently both rows
     are above the fold's midpoint, but the dock row is the one that opens. */
  const pop = document.querySelector('.mr-pop');
  const dockPillEl = document.querySelector('#dock .mr-pill');
  if (pop && dockPillEl) {
    const r = dockPillEl.getBoundingClientRect();
    const w = 420, GAP = 8, MARGIN = 12, MIN = 160, MAX = 360;
    const above = r.top - GAP - MARGIN;
    const below = innerHeight - r.bottom - GAP - MARGIN;
    const openUp = above >= MIN || above >= below;
    const room = openUp ? above : below;
    pop.style.width = w + 'px';
    pop.style.maxHeight = Math.min(MAX, Math.max(MIN, room)) + 'px';
    pop.style.left = Math.max(MARGIN, Math.min(r.right - w, innerWidth - w - MARGIN)) + 'px';
    if (openUp) { pop.style.bottom = (innerHeight - r.top + GAP) + 'px'; pop.style.top = ''; }
    else { pop.style.top = (r.bottom + GAP) + 'px'; pop.style.bottom = ''; }
  }
  /* Self-measure. Guessing "22px should look right" is how the first version
     shipped at 28px; this prints the boxes the reviewer is actually looking at,
     including the two shipped neighbours each pill has to match. The placement
     lines are the same arithmetic as usePopoverPlacement, run against the two
     real trigger boxes, so the flip is evidenced by the page rather than by a
     reading of the source. */
  const box = (el) => el ? Math.round(el.getBoundingClientRect().height * 100) / 100 : null;
  const radius = (el) => el ? getComputedStyle(el).borderTopLeftRadius : null;
  const dockPill = document.querySelector('#dock .mr-pill');
  const heroPill = document.querySelector('#hero .mr-pill');
  const usage = document.querySelector('#dock').previousElementSibling;
  const heroChip = document.querySelector('.hchip');
  const side = (el) => {
    const r = el.getBoundingClientRect();
    const GAP = 8, MARGIN = 12, MIN = 160, MAX = 360;
    const above = r.top - GAP - MARGIN;
    const below = innerHeight - r.bottom - GAP - MARGIN;
    const up = above >= MIN || above >= below;
    return { up, room: Math.round(Math.min(MAX, Math.max(MIN, up ? above : below))) };
  };
  const dockSide = side(dockPill);
  const heroSide = side(heroPill);
  const lines = [
    'dock pill     h=' + box(dockPill) + '  radius=' + radius(dockPill),
    'usage (ship)  h=' + box(usage) + '  radius=' + radius(usage),
    'hero pill     h=' + box(heroPill) + '  radius=' + radius(heroPill),
    'workspace chip h=' + box(heroChip) + '  radius=' + radius(heroChip),
    'dock popover  opens ' + (dockSide.up ? 'UP' : 'DOWN') + '  maxHeight=' + dockSide.room,
    'hero popover  opens ' + (heroSide.up ? 'UP' : 'DOWN') + '  maxHeight=' + heroSide.room,
  ];
  console.log(lines.join('\\n'));
  const probe = document.getElementById('probe');
  probe.textContent = '实测盒高（页面自测，非标注）\\n' + lines.join('\\n');
  window.__MEASURED__ = { dockPill: box(dockPill), usage: box(usage), heroPill: box(heroPill), heroChip: box(heroChip) };
</script>
</body></html>`;

writeFileSync(new URL('./preview.html', import.meta.url), html, 'utf8');
console.log('wrote preview.html (' + html.length + ' bytes) | css ' + CSS.length + ' chars | body ' + body.length + ' chars');
