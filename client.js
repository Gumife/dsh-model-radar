/**
 * dsh-model-radar — Client half (bypass edition).
 *
 * WHAT THIS IS
 * A standalone radar panel that lives in `conversation.composer.dock` — the
 * ambient row BELOW the composer card. It does NOT register on
 * `conversation.input.model`, so the shipped model selector keeps its seat and
 * stays fully functional. Clicking the radar pill opens the grouped directory:
 * the provider column on the left, each provider's MODELS FLYING OUT TO ITS
 * RIGHT (hover previews, click pins), a search box that filters both columns,
 * a 最近使用 rail, and the 推理等级 (reasoning effort) chips for the current
 * route. Switching commits through /radar/api, whose Host half validates via
 * llm.resolveCallConfig and calls the host's sessionController.selectModel —
 * the same authoritative path the stock composer uses, so both controls can
 * never disagree about what is selected.
 *
 * WHY BYPASS INSTEAD OF TAKEOVER
 * The previous revision registered on `conversation.input.model` (replaceRisk
 * `shadows-shipped-ui`) and, together with a profile bundle change, left the
 * composer with no model button at all. The instructions for this revision are
 * explicit: get a working entry point FIRST, do not shadow shipped UI. The
 * seat code is kept below behind REGISTER_SEAT so the takeover is a one-line
 * flip, but it ships OFF.
 *
 * Layout contract: the popover is a flex COLUMN bounded by
 * `max-width: min(420px, 100vw - 32px)` / `max-height: min(360px, 100vh - 96px)`
 * and placed from its measured offsetWidth/offsetHeight (MARGIN 12, clamped
 * into the viewport, re-placed on resize/scroll and on the card's own resize).
 * The two-column body is `min-height: 0` so `overflow-y: auto` on each column
 * actually produces a scrollbar instead of pushing the footer past the border.
 * Default selection is the CURRENT model's provider, else the first provider
 * that actually advertises models — never a provider with an empty list.
 *
 * Keyboard: type to filter, ↑/↓ move the highlight, Enter switches, Esc closes.
 *
 * Styling uses only --dsw-alias-* theme tokens; the <style> tag renders inside
 * the component so unmounting removes it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-radar',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    /* Both popovers are PORTALLED to document.body.
     *
     * .mr-pop is position:fixed and its coordinates are viewport rects from
     * getBoundingClientRect(). The composer's dock carries backdrop-filter,
     * which — exactly like transform — makes it a containing block for fixed
     * descendants. While the panel rendered inside that dock, "fixed" resolved
     * against the dock rather than the viewport and the menu opened shifted,
     * away from its trigger. document.body has no such property, so the portal
     * restores the coordinate system the placement maths already assumes.
     * (dsh-prompt-forge had the identical defect; it was copied from here.) */

    const NS = 'dsh-model-radar';

    /*
     * ── 交付开关（HANDOFF 优先级①）──────────────────────────────────────────
     * false（本版默认）— 只做旁路入口：模型雷达住在 conversation.composer.dock，
     *                    官方模型按钮（shipped-ui / Kb）完整保留、不被遮蔽。
     * true            — 额外注册 conversation.input.model，接管官方席位。
     *
     * 接管前必读（该槽 replaceRisk = 'shadows-shipped-ui'，注册即顶掉官方按钮，
     * 上一轮就是在这里把 composer 的模型按钮整个弄没的）：
     *   0. 退回手段只有一条：把本常量改回 false，然后**整进程重启**。客户端插件
     *      替换已安装的包不会热更，HMR 只对新装 bundle 生效。
     *   1. inject 首参就是 sessionId：`inject: (sessionId) => ({ sessionId })`。
     *      写成 `inject: () => ({ sessionId })` 会拿到 undefined；也不要指望从
     *      standardProps 里拿——binding.props 不携带 session id。
     *   2. effortsOf() 必须兼容 `{ id, name, description }` 对象形状。早期按
     *      `typeof e === 'string'` 过滤会把整排推理等级静默吞掉。
     *   3. 弹层里滚动容器的子项必须 `min-height: 0`（见 .mr-cols），否则 grid
     *      行拒绝收缩，两列永远不出滚动条，footer 被顶出边框。
     */
    const REGISTER_SEAT = false;

    /*
     * Particle motion: on by default, and the user's choice is remembered.
     *
     * It used to be driven by (prefers-reduced-motion:reduce), which reads
     * SPI_GETCLIENTAREAANIMATION — a Windows-wide flag that "Adjust for best
     * performance" clears. On such a machine every user of this panel got a
     * frozen field with no way to say otherwise, and the rung differences the
     * field exists to show were unreachable. A per-plugin switch can be
     * disagreed with; a machine-wide preference cannot.
     *
     * window.localStorage is absent in the verify harness and can throw in a
     * privacy mode, so both reads and writes are guarded and a failure just
     * means "not remembered", never a broken panel.
     */
    const MOTION_KEY = 'dsh-model-radar:motion';

    function readMotion() {
      try {
        const raw = window.localStorage.getItem(MOTION_KEY);
        return raw === null ? true : raw !== 'still';
      } catch { return true; }
    }

    function writeMotion(on) {
      try { window.localStorage.setItem(MOTION_KEY, on ? 'move' : 'still'); }
      catch { /* not remembered; the panel still works */ }
    }

    const CSS = `
/* flex:none is load-bearing. The dock row is display:flex with gap:12px,
   justify-content:center, max-width:100% and NO flex-wrap, and it already
   carries activity / usage / credits / the context meter. Every flex child
   defaults to min-width:auto + flex-shrink:1, so without flex:none this entry
   is the one that gets squeezed to zero width once the row is full — the
   occupant still shows up in the Slot tree as active, but nothing paints. */
.mr-root{position:relative;display:inline-flex;flex:none;font-size:13px;color:var(--dsw-alias-label-primary)}

/* Dock pill: the bypass entry point. This row sits on a 22px baseline, not the
   28px of the input bar above it: the shipped ContextMeter next to us is
   padding 1px 8px over a 20px line box, and the workbuddy credits readout is
   2px 6px over 18px — both settle at exactly 22px. An explicit 28px here stood
   6px proud of both neighbours, and that extra height is also what made the
   radius read as wrong (8px looks tighter on a taller box). So: 22px box,
   radius stays --dsw-radius-sm to match the context meter in the same row,
   no border, and the hover/expanded fill is --dsw-alias-interactive-bg-hover.
   The label stays just "模型雷达": the shipped trigger elsewhere already names
   the live model and effort. */
.mr-pill{display:inline-flex;align-items:center;gap:4px;box-sizing:border-box;
  height:22px;max-width:320px;
  padding:0 4px 0 8px;background:0 0;border:0;border-radius:var(--dsw-radius-sm);
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}

/* Hero-row variant. The New Session row is NOT the composer dock row and must
   not borrow its metrics: the shipped member of that row is the workspace chip
   at min-height 28px, 13px/20px, font-weight 500, padding 0 8px. Rendering the
   22px pill there would just move the same "does not match its neighbour"
   complaint up one surface. Only geometry and weight change. */
.mr-pill.mr-hero{height:28px;padding:0 8px;font-weight:500;color:var(--dsw-alias-label-primary)}
.mr-pill.mr-hero .txt{font-weight:500}
.mr-pill:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.mr-pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.mr-pill:focus-visible{outline:none;box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary)))}
.mr-pill .ico{flex:none;width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.4;
  stroke-linecap:round;opacity:.9}
.mr-pill .txt{flex:none;white-space:nowrap}
.mr-pill .chev{flex:none;width:10px;height:10px;stroke:currentColor;fill:none;stroke-width:2;
  color:var(--dsw-alias-label-caption,var(--dsw-alias-label-secondary));transition:transform .12s}
.mr-pill[aria-expanded="true"] .chev{transform:rotate(180deg)}

/* Seat trigger (only used when REGISTER_SEAT is flipped on). Same metrics. */
.mr-trigger{display:inline-flex;align-items:center;gap:4px;height:28px;max-width:360px;
  padding:0 4px 0 8px;background:0 0;border:0;border-radius:var(--dsw-radius-sm);
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.mr-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.mr-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.mr-trigger .txt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mr-trigger .chev{flex:none;width:10px;height:10px;stroke:currentColor;fill:none;stroke-width:2;
  color:var(--dsw-alias-label-caption,var(--dsw-alias-label-secondary));transition:transform .12s}
.mr-trigger[aria-expanded="true"] .chev{transform:rotate(180deg)}

/* Popover: flex column bounded by the space above the trigger (inline style).
   Everything here is copied from the shipped model menu so the two surfaces are
   indistinguishable: width max 420 / height max 360, 4px inset padding, no
   border, the .5px hairline + soft shadow come from --dsw-elevation-prominent
   (its stroke colour is pinned to border-l1 exactly as the shipped menu does),
   and the fill/backdrop come from the shared menu-surface tokens. Never
   hardcode a shadow or a colour here — light/dark both have to work. */
.mr-pop{position:fixed;z-index:1100;display:flex;flex-direction:column;
  width:420px;min-width:min(240px,calc(100vw - 32px));
  max-width:min(420px,calc(100vw - 32px));max-height:min(360px,calc(100vh - 96px));
  padding:4px;overflow:hidden;border:0;border-radius:var(--dsw-radius-lg);
  background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));
  -webkit-backdrop-filter:var(--dsw-menu-backdrop-filter);backdrop-filter:var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);
  --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}

.mr-search{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:2px 2px 4px}
.mr-search input{flex:1;min-width:0;background:0 0;color:var(--dsw-alias-label-primary);
  border:0;border-radius:var(--dsw-radius-md);padding:5px 7px;font:inherit;font-size:12px;
  outline:none}
.mr-search input::placeholder{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-secondary))}
.mr-search input:focus-visible{box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary)))}

/* Body: min-height:0 is the whole fix — without it the grid rows refuse to
   shrink, the columns never overflow, and no scrollbar ever appears. */
.mr-cols{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:196px minmax(0,1fr);
  overflow:hidden}
.mr-provs,.mr-models{min-height:0;overflow-y:auto;padding:2px;overscroll-behavior:contain}
.mr-provs{border-right:1px solid var(--dsw-alias-border-l1)}
.mr-provs::-webkit-scrollbar,.mr-models::-webkit-scrollbar{width:9px}
.mr-provs::-webkit-scrollbar-thumb,.mr-models::-webkit-scrollbar-thumb{
  background:var(--dsw-alias-border-l2);border-radius:9px}
.mr-provs::-webkit-scrollbar-track,.mr-models::-webkit-scrollbar-track{background:transparent}

/* Section labels scroll with their column on purpose: two sticky headers in
   one scroll container pin to the same top:0 and paint over each other, which
   reads as a broken/clipped row. */
/* Section labels use label-SECONDARY, not the caption/tertiary rung. Those are
   #81858c on the menu surface — 3.61:1, under the 4.5:1 floor for text this
   small. label-secondary is #6b7280 (4.70:1) and still reads a full step
   quieter than label-primary, which is what the hierarchy needs. */
.mr-sec{padding:7px 8px 4px;color:var(--dsw-alias-label-secondary);
  font-size:11px;line-height:16px;letter-spacing:.06em;text-transform:uppercase}
/* Second line of the model column header: a quieter hint, not a second title.
   It inherits the section colour deliberately — opacity would stack alpha on
   an already-muted token and drop it back under 4.5:1. */
.mr-sec.sub{padding-top:0;text-transform:none;letter-spacing:0;font-size:11px}
.mr-prov,.mr-model{display:flex;align-items:center;gap:6px;width:100%;background:none;
  border:1px solid transparent;border-radius:var(--dsw-radius-md);min-height:34px;padding:5px 7px;
  color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.mr-prov{font-size:13px;line-height:20px}
.mr-prov:hover,.mr-prov.on,.mr-model:hover,.mr-model.hl{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.mr-prov.on{border-color:var(--dsw-alias-border-l2)}
.mr-model.cur{border-color:var(--dsw-alias-brand-primary)}
.mr-model.hl{border-color:var(--dsw-alias-border-l2)}
.mr-prov .n,.mr-model .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Model ids are identifiers, so they get the code face — but the shipped menu
   renders model names in the text face, so this stays same-size (13px/18px)
   and un-bolded; the code face alone carries the distinction. */
.mr-model .n{font-family:var(--ds-font-family-code);font-size:13px;font-weight:400;line-height:18px}
.mr-prov .c,.mr-model .b{color:var(--dsw-alias-label-secondary);
  font-size:11.5px;white-space:nowrap}
.mr-prov .c.zero{opacity:.45}

/* Model badge (llm.listModels ships {text, tone}; the shipped selector renders
   it as a Tag). flex:none so it never squeezes the id — the id is what the row
   exists to say — and shrinks with an ellipsis only when the row truly runs out. */
.mr-model .bg{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;
  padding:0 5px;border-radius:var(--dsw-radius-sm,6px);
  font-family:var(--dsw-font-family);font-size:11px;line-height:16px;white-space:nowrap;
  color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-bg-layer-2)}
.mr-model .bg.warning{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d8862c) 18%, transparent);
  color:var(--dsw-alias-state-warn-primary,#d8862c)}
.mr-model .bg.success{background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#30a46c) 18%, transparent);
  color:var(--dsw-alias-state-success-primary,#30a46c)}
.mr-model .bg.danger{background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5484d) 18%, transparent);
  color:var(--dsw-alias-state-error-primary,#e5484d)}
.mr-model .bg.info,.mr-model .bg.solid{background:color-mix(in srgb, var(--dsw-alias-state-business-primary,#4c6ef5) 18%, transparent);
  color:var(--dsw-alias-state-business-primary,#4c6ef5)}

/* Provider load failures. A hole with no explanation is worse than a warning
   row: the host's own selector prints one line per failed group, and so do we.
   Bounded height — a host with every provider down must not push the columns
   out of the popover. */
.mr-fails{flex:none;max-height:72px;overflow-y:auto;overscroll-behavior:contain;
  margin:0 6px 4px;padding:4px 7px;border-radius:var(--dsw-radius-md);
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d8862c) 10%, transparent)}
.mr-fail{font-size:11.5px;line-height:17px;color:var(--dsw-alias-state-warn-primary,#d8862c);
  overflow-wrap:anywhere}
.mr-fail + .mr-fail{margin-top:2px}

/* Reasoning ladder: a filled capsule you drag, not a row of pill buttons.
   The accent is deliberately its own colour pair rather than a theme token —
   the ladder is the one control in this popover that should read as "live",
   and the monochrome tokens (label-primary is pure black / pure white) would
   make the fill indistinguishable from a progress bar. Both light and dark
   values are declared so neither theme is an afterthought; the dark pair is
   lifted in luminance so it does not vibrate against #2c2c2e. */
.mr-effort{flex:0 0 auto;display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;
  align-items:center;column-gap:10px;padding:10px 10px 9px;
  border-top:1px solid var(--dsw-alias-border-l1)}
.mr-effort .lab{color:var(--dsw-alias-label-secondary);
  font-size:12px;line-height:18px;white-space:nowrap}
/* The motion switch: 18px, glyph-only, meaning carried by title + aria-label.
   Text ("粒子：动") measured 48px and squeezed the rail on the 420px popover;
   the glyph costs one column-gap instead. Dimmed while frozen so the state is
   readable without hovering. */
.mr-motion{flex:none;width:18px;height:18px;padding:0;background:0 0;border:0;
  border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;line-height:18px;cursor:pointer;text-align:center}
.mr-motion:hover{color:var(--dsw-alias-label-primary)}
.mr-motion:focus-visible{outline:none;
  box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) var(--dsw-focus-ring-color,#5b6cf9)}
.mr-motion.still{opacity:.55}

/* 22px rail: the capsule itself is 18px, and the 2px top/bottom slack is pure
   hit area so the drag does not demand pixel accuracy. The 11px side margin is
   the knob's radius — a knob parked at 0% or 100% sits fully inside the box. */
.mr-rail{--mr-a:#5b6cf9;--mr-b:#7c5cf5;--mr-dot:#fff;
  position:relative;height:22px;margin:0 11px;cursor:pointer;
  touch-action:none;-webkit-user-select:none;user-select:none}
@media (prefers-color-scheme:dark){
  .mr-rail{--mr-a:#6c7bff;--mr-b:#9a72ff}
}
.mr-rail:focus-visible{outline:none}
.mr-rail:focus-visible .knob{box-shadow:0 1px 3px rgba(0,0,0,.28),
  0 0 0 var(--dsw-focus-ring-width,2px) var(--dsw-focus-ring-color,var(--mr-a))}

/* The empty half has to stay visible on a dark menu: border-l1 is .06 white,
   which a 18px capsule swallows — border-l2 (.12 / .1) is the same family one
   step up. */
.mr-rail .track{position:absolute;left:0;right:0;top:2px;height:18px;
  border-radius:999px;background:var(--dsw-alias-border-l2,var(--dsw-alias-border-l1))}
/* overflow:hidden is what lets the particles be plain absolutely-positioned
   spans: they clip to the capsule's own rounded edge for free, so a particle
   near the leading end never pokes past the rounded corner. */
.mr-rail .fill{position:absolute;left:0;top:2px;height:18px;border-radius:999px;
  overflow:hidden;pointer-events:none;
  background:linear-gradient(90deg,var(--mr-a),var(--mr-b));
  transition:width .16s cubic-bezier(.4,0,.2,1)}
/* While dragging the fill must track the pointer exactly; an easing curve here
   would make the capsule lag the knob and look broken. */
.mr-rail.dragging .fill{transition:none}
/* Particles FLOW ALONG THE FILL, left to right — the same direction the
   capsule grows when the rung rises. They used to rise vertically, which read
   as a sandstorm inside a horizontal gauge: motion perpendicular to the thing
   it is measuring. Two independent keyframe tracks (travel-and-fade, and a
   vertical bob) are combined per particle. EVERY number that matters here is
   per-particle and set inline from the hash: --dur, the delay, --run (how far
   it travels), --bob (how far it wanders off the centreline) and --o-max.
   Nothing is shared, so the field never pulses in unison.
   The first cut of this got three things wrong and looked like static noise:
   1-2px grains at 16px per 2.9s is 5px/s, i.e. 0.08px per frame at 60Hz —
   below the threshold where the eye reads motion at all. Grains are now
   0.8-3.1px travelling 11-26px in 0.6-2.5s (4-40px/s), and the rung shortens
   --dur directly so the harder the model thinks the faster the sand runs. */
.mr-rail .p{position:absolute;border-radius:50%;background:var(--mr-dot);
  transform:translate(-50%,-50%);
  animation:mr-drift var(--dur,1.6s) linear infinite,
            mr-sway calc(var(--dur,1.6s) * 1.9) ease-in-out infinite alternate;
  animation-delay:var(--delay,0s), calc(var(--delay,0s) * -0.7);
  will-change:transform,opacity}
/* The travel is in PIXELS, not percentages: a percentage of a 1px particle is
   under 3px, which reads as jitter rather than flow. --run is a per-layer
   constant (26 / 17 / 11) and the endpoint is shifted RIGHT of the origin, so
   every grain leaves toward the fill's leading end and the gradient edge clips
   it instead of it dying in mid-air. */
@keyframes mr-drift{
  0%  {transform:translate(-50%,-50%) scale(.45);opacity:0}
  12% {opacity:var(--o-max,.8)}
  62% {opacity:calc(var(--o-max,.8) * .55)}
  100%{transform:translate(calc(-50% + var(--run,17px)),-50%) scale(1.15);opacity:0}
}
/* --bob is a per-layer half-height: the near band wanders 4px off the
   centreline, the far band 1.5px. Without it every grain tracked the same
   horizontal line and the field read as one sheet sliding right rather than
   sand with depth. */
@keyframes mr-sway{
  from{translate:0 calc(var(--bob,2.5px) * -1)}
  to  {translate:0 var(--bob,2.5px)}
}
/* Freezing the field is the plugin's OWN switch, never a media query.
   (prefers-reduced-motion:reduce) is derived from SPI_GETCLIENTAREAANIMATION,
   which Windows flips globally for reasons that have nothing to do with this
   panel — "adjust for best performance" in the classic performance-options
   dialog sets it. On such a machine the field was frozen forever, and with it
   every rung difference (5->20 particles, 2.9s->2.0s) was invisible. The
   switch keeps the same look when frozen: the dust still gives the capsule its
   texture, it just stops travelling. */
.mr-rail.still .p{animation:none;opacity:var(--o-max,.5)}
.mr-rail .knob{position:absolute;top:0;width:22px;height:22px;margin-left:-11px;
  border-radius:50%;background:#fff;pointer-events:none;
  box-shadow:0 1px 3px rgba(0,0,0,.28);
  transition:box-shadow .14s ease,transform .14s ease}
.mr-rail:hover .knob{box-shadow:0 2px 6px rgba(0,0,0,.32)}
.mr-rail.dragging .knob{transform:scale(1.06);box-shadow:0 2px 8px rgba(0,0,0,.35)}
.mr-rail.dis{opacity:.55}
.mr-rail.dis,.mr-rail.dis *{cursor:default}

/* Current rung. min-width holds the rail's own width steady as the label
   changes 低 → 极高; without it the whole ladder reflows on every pick. */
.mr-effort .now{color:var(--mr-now,#5b6cf9);font-size:12px;line-height:18px;
  font-weight:600;white-space:nowrap;min-width:2.4em;text-align:right}
@media (prefers-color-scheme:dark){ .mr-effort .now{--mr-now:#8f9cff} }

.mr-foot{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:5px 8px;border-top:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-secondary);
  font-size:12px;line-height:18px;min-height:26px;white-space:nowrap;overflow:hidden}
.mr-foot>span{overflow:hidden;text-overflow:ellipsis;min-width:0}
.mr-foot>span:last-child{flex:none}
.mr-foot .err{color:var(--dsw-alias-state-error-primary)}
.mr-foot .meta{font-family:var(--ds-font-family-code);font-size:11px}
.mr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
  min-height:120px;padding:20px 14px;text-align:center;
  color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
/*
 * Credits-expiry badge. It sits between the provider name and the model count
 * and must never push the count out of the 196px column, so it is flex:none,
 * tabular-numeral and one token wide ("1258·3d").
 *
 * It is a filled pill rather than tinted text: the warning token alone measured
 * 2.78:1 at 11.5px on the dark theme (the same trap dsh-better-display avoided
 * with a 16% colour-mix fill), and the figure is the point of the badge — it
 * must be legible, not decorative. Text is the primary label token, so the
 * colour carries meaning on top of a readable number instead of replacing it.
 */
.mr-prov .x{flex:none;display:inline-block;padding:0 5px;border-radius:var(--dsw-radius-sm,6px);
  font-size:12px;line-height:16px;white-space:nowrap;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d8862c) 18%, transparent)}
.mr-prov .x.dead{background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5484d) 18%, transparent)}
.mr-prov .x.quiet{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
/* Footer slot for the snapshot age + the one button allowed to reach upstream.
   flex:0 1 auto — it takes only what its short label needs so the model meta
   on the left keeps priority, and shrinks (with the ellipsis below) if the row
   runs out of room. */
.mr-foot .x{flex:0 1 auto;display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:0;overflow:visible}
.mr-foot .x .lab{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-secondary);font-size:12px}
.mr-foot .x .lab.warn{color:var(--dsw-alias-state-warn-primary,#d8862c);font-weight:600}
.mr-refresh{flex:none;background:0 0;border:1px solid var(--dsw-alias-border-l1);
  border-radius:var(--dsw-radius-md);min-height:20px;padding:1px 8px;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;cursor:pointer}
.mr-refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.mr-refresh:disabled{opacity:.55;cursor:default}
`;

    /* Host Tag tones we have a palette for. Anything else falls back to the
       neutral chip rather than inventing a colour the theme does not own. */
    const BADGE_TONES = {
      warning: 'warning', success: 'success', danger: 'danger',
      info: 'info', solid: 'info', neutral: '', outline: '', quiet: '',
    };

    const EFFORT_KEYS = {
      minimal: 'effortMinimal', low: 'effortLow', medium: 'effortMedium',
      high: 'effortHigh', xhigh: 'effortXhigh',
    };

    /* Host effort ids are stable (`minimal`…`xhigh`), but the display names
       they arrive with are host-localised and a bare-string ladder carries no
       name at all. Resolve through the plugin locale first, so an English UI
       never falls back to the Chinese table that used to live here. */
    function effortLabel(t, id, hostName) {
      if (typeof id !== 'string' || id === '') return '';
      const key = EFFORT_KEYS[id];
      if (key !== undefined) {
        const text = t(key);
        if (typeof text === 'string' && text !== '' && text !== key) return text;
      }
      if (typeof hostName === 'string' && hostName !== '') return hostName;
      return id;
    }

    /**
     * Reasoning ladder as one continuous rail.
     *
     * The button row it replaces fired a host round trip on every press; a rail
     * must instead follow the pointer without talking to the host, so the knob
     * is drawn from local drag state and only the RELEASE commits. Snapping picks
     * the nearest stop in percentage space, which keeps the rungs evenly spaced
     * whether there are three, four, or five of them.
     *
     * Keys mirror a native slider (arrows step, Home/End jump) and stop
     * propagating: the dock listens on document in the capture phase and drives
     * the model list with the arrow keys, so the rail must claim them while it
     * has focus.
     */
    function EffortBar({ t, list, value, onPick, disabled }) {
      const railRef = React.useRef(null);
      /* Whether a press is in flight has to survive pointermove without a
         render, so it lives in a ref; only the dragged percentage re-renders. */
      const draggingRef = React.useRef(false);
      const [dragPct, setDragPct] = React.useState(null);
      const [motion, setMotion] = React.useState(readMotion);
      const toggleMotion = () => {
        setMotion((was) => { writeMotion(!was); return !was; });
      };

      const n = list.length;
      const indexOfValue = () => {
        const at = list.findIndex(e => e.id === value);
        return at < 0 ? 0 : at;
      };
      const pctOf = (i) => (n <= 1 ? 100 : (i / (n - 1)) * 100);

      /* While dragging the knob follows the pointer; otherwise it sits on the
         committed rung. Both are percentages of the same track, so the two
         states cannot disagree about where a stop lives. */
      const knobPct = dragPct === null ? pctOf(indexOfValue()) : dragPct;
      const clampPct = (v) => Math.max(0, Math.min(100, v));

      /* Nearest stop, not which side we crossed: the two rules differ at the
         midpoint, and nearest is what the eye expects the knob to settle on. */
      const stopAt = (pct) => {
        if (n <= 1) return 0;
        const raw = Math.round((pct / 100) * (n - 1));
        return Math.max(0, Math.min(n - 1, raw));
      };

      const pctFromEvent = (ev) => {
        const el = railRef.current;
        if (!el || typeof el.getBoundingClientRect !== 'function') return null;
        const rect = el.getBoundingClientRect();
        if (!rect || !(rect.width > 0)) return null;
        return clampPct(((ev.clientX - rect.left) / rect.width) * 100);
      };

      const commit = (idx) => {
        const eff = list[idx];
        if (!eff || eff.id === value || disabled) return;
        onPick(eff.id);
      };

      const onPointerDown = (ev) => {
        if (disabled) return;
        if (typeof ev.button === 'number' && ev.button > 0) return;
        if (ev.preventDefault) ev.preventDefault();
        draggingRef.current = true;
        const pct = pctFromEvent(ev);
        if (pct !== null) setDragPct(pct);
        /* Pointer capture keeps the drag alive when the cursor leaves the 18px
           track, which it will on the first fast flick. Not every environment
           implements it and the test stub has no DOM at all, so it is optional. */
        const el = ev.currentTarget;
        if (el && typeof el.setPointerCapture === 'function' && typeof ev.pointerId === 'number') {
          try { el.setPointerCapture(ev.pointerId); } catch (e) { /* keep going */ }
        }
      };

      const onPointerMove = (ev) => {
        if (!draggingRef.current) return;
        const pct = pctFromEvent(ev);
        if (pct !== null) setDragPct(pct);
      };

      const endDrag = (ev) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        const fromEvent = ev ? pctFromEvent(ev) : null;
        const pct = fromEvent === null ? dragPct : fromEvent;
        setDragPct(null);
        if (pct !== null) commit(stopAt(pct));
      };

      /* A cancelled pointer (the system took over) still settles the knob but
         must NOT commit: the user never chose a stop. */
      const onPointerCancel = () => { draggingRef.current = false; setDragPct(null); };

      const onKeyDown = (ev) => {
        if (disabled) return;
        const at = indexOfValue();
        let next = null;
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') next = Math.min(n - 1, at + 1);
        else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') next = Math.max(0, at - 1);
        else if (ev.key === 'Home') next = 0;
        else if (ev.key === 'End') next = n - 1;
        if (next === null) return;
        ev.preventDefault();
        ev.stopPropagation();
        commit(next);
      };
      const at = Math.min(indexOfValue(), Math.max(0, n - 1));
      const curLabel = n > 0 ? effortLabel(t, list[at].id, list[at].name) : '';

      /* Particle field. Deterministic hash rather than Math.random(): the same
         rung must produce the same constellation on every render, or the dust
         would reshuffle whenever an unrelated prop changed. The rung index
         feeds the count, the brightness and the tempo.

         Three depth bands, not one homogeneous field. A grain's band fixes its
         size, its travel and its sway together, because that is what depth
         looks like: near sand is bigger, faster and wanders further; far sand
         is a faint hairline that barely moves. One band alone reads as a sheet
         sliding up — the earlier version's flaw. */
      const dust = (() => {
        const rung = stopAt(clampPct(knobPct));
        /* 8 grains at the bottom rung, 26 at the top: the ladder gets denser,
           not just faster. n <= 1 means the host gave us no ladder at all, so
           a small fixed field is all we should spend. */
        const count = n <= 1 ? 8 : 8 + rung * 6;
        /* Band table: r = radius px, run = travel px (rightward, along the
           fill), bob = half-height px off the centreline, o = peak alpha,
           dur = seconds per traverse. baseDur shrinks with the rung so the
           whole field speeds up together. */
        const bands = [
          { r: [1.9, 3.1], run: 26, bob: 4.0, o: [0.62, 0.9], dur: [1.15, 1.75] },
          { r: [1.2, 2.0], run: 17, bob: 2.6, o: [0.42, 0.68], dur: [1.35, 2.10] },
          { r: [0.8, 1.4], run: 11, bob: 1.5, o: [0.24, 0.44], dur: [1.70, 2.60] },
        ];
        const out = [];
        for (let i = 0; i < count; i += 1) {
          /* Three independent hashes per grain. sin() is a cheap deterministic
             scrambler here, not a model of anything. */
          const h1 = Math.sin((i + 1) * 12.9898 + rung * 78.233) * 43758.5453;
          const h2 = Math.sin((i + 1) * 39.3468 + rung * 11.135) * 24634.6345;
          const h3 = Math.sin((i + 1) * 4.898 + rung * 31.77) * 12345.6789;
          const h4 = Math.sin((i + 1) * 7.3127 + rung * 5.117) * 19876.4321;
          const f1 = h1 - Math.floor(h1);
          const f2 = h2 - Math.floor(h2);
          const f3 = h3 - Math.floor(h3);
          const f4 = h4 - Math.floor(h4);
          /* Round-robin the bands so the mix is stable and every rung keeps
             the same ratio of near to far grains; the hash only jitters it. */
          const band = bands[(i + (f4 > 0.66 ? 1 : 0)) % bands.length];
          const mix = (range, t) => range[0] + (range[1] - range[0]) * t;
          /* Durations shorten as the rung rises: 1.0x at the bottom, ~0.62x at
             the top, so the top rung runs visibly faster and not merely denser.
             Delays are negative so the field is already mid-flight on mount
             instead of all grains starting together. */
          const speed = 1 - rung * 0.095;
          const dur = mix(band.dur, f3) * speed;
          out.push({
            /* x starts in the left 85% so a grain has the whole capsule still
               ahead of it to cross; y is spread over the full height because
               the motion is horizontal now and nothing has to climb. */
            x: 3 + f1 * 82,
            y: 22 + f2 * 56,
            r: mix(band.r, f2),
            o: mix(band.o, f1),
            dur: dur.toFixed(2) + 's',
            delay: (-f3 * dur * 1.7).toFixed(2) + 's',
            run: band.run + 'px',
            bob: band.bob.toFixed(1) + 'px',
          });
        }
        return out;
      })();

      return h('div', { className: 'mr-effort' },
        h('span', { className: 'lab' }, t('effort')),
        h('div', {
          ref: railRef,
          className: 'mr-rail' + (disabled ? ' dis' : '') + (dragPct === null ? '' : ' dragging')
            + (motion ? '' : ' still'),
          role: 'slider',
          tabIndex: disabled ? -1 : 0,
          'aria-label': t('effort'),
          'aria-valuemin': 0,
          'aria-valuemax': Math.max(0, n - 1),
          'aria-valuenow': indexOfValue(),
          'aria-valuetext': curLabel,
          'aria-disabled': disabled ? 'true' : undefined,
          onPointerDown,
          onPointerMove,
          onPointerUp: endDrag,
          onPointerCancel,
          onKeyDown,
        },
          h('div', { className: 'track' }),
          h('div', { className: 'fill', style: { width: clampPct(knobPct) + '%' } },
            /* Particles ride inside the fill and are clipped by its own rounded
               edge, so they need no per-particle bounds math. Count and alpha
               rise with the rung: the ladder should look busier the harder the
               model is asked to think. */
            dust.map((pt, i) => h('span', {
              key: 'p' + i,
              className: 'p',
              style: { left: pt.x + '%', top: pt.y + '%', width: pt.r + 'px',
                height: pt.r + 'px', opacity: pt.o,
                '--dur': pt.dur, '--delay': pt.delay, '--o-max': pt.o,
                '--run': pt.run, '--bob': pt.bob },
            })),
          ),
          h('div', { className: 'knob', style: { left: clampPct(knobPct) + '%' } }),
        ),
        /* The current rung, printed once on the right. While dragging it
           previews the stop the knob would settle on, so the number under the
           pointer and the word beside it never disagree. */
        h('span', { className: 'now' }, n > 0
          ? effortLabel(t, list[Math.min(stopAt(clampPct(knobPct)), n - 1)].id,
            list[Math.min(stopAt(clampPct(knobPct)), n - 1)].name)
          : ''),
        /* The switch that replaced the media query. It sits on the rail row
           because that is the only thing it affects, and it says what it is
           doing in its title (the visible label is a single glyph). */
        h('button', {
          type: 'button',
          className: 'mr-motion' + (motion ? '' : ' still'),
          title: motion ? t('motionOn') : t('motionOff'),
          'aria-label': motion ? t('motionOn') : t('motionOff'),
          'aria-pressed': motion ? 'true' : 'false',
          onClick: toggleMotion,
        }, motion ? '✳' : '·'),
      );
    }


    function fmtCtx(n) {
      if (typeof n !== 'number' || !(n > 0)) return '';
      /* Round at the unit boundary instead of truncating: 999_999 used to
         print "1000k" and 1_048_576 printed "1.048576M". One decimal is
         plenty for a context window. */
      const k = Math.round(n / 1000);
      if (k < 1000) return k + 'k';
      const m = n / 1000000;
      const rounded = m >= 10 ? Math.round(m) : Math.round(m * 10) / 10;
      return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + 'M';
    }

    async function api(command, payload) {
      const res = await fetch('/radar/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command, ...payload }),
      });
      const body = await res.json().catch(() => ({ ok: false, error: 'bad response' }));
      if (!body.ok) throw new Error(body.error || command + ' failed');
      return body;
    }

    /*
     * Same route, but an ok:false answer comes back as data instead of an
     * exception. The credits commands carry a user-facing recovery hint (the
     * exact node command to run by hand) on their failure body, and throwing
     * that away would leave the button with nothing to show.
     */
    async function apiSoft(command, payload) {
      try {
        const res = await fetch('/radar/api', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command, ...payload }),
        });
        return await res.json().catch(() => ({ ok: false, error: 'bad response' }));
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    }

    function useRadar(sessionId) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState('');
      const load = React.useCallback(async () => {
        try {
          const body = await api('catalog', { sessionId: sessionId || '' });
          setData(body);
          setError('');
        } catch (e) { setError(String(e && e.message ? e.message : e)); }
      }, [sessionId]);
      return { data, setData, error, setError, load };
    }

    /*
     * ── credits-expiry readout ───────────────────────────────────────────
     *
     * Sourced from a local snapshot file the host reads, never from the
     * upstream billing APIs. Those APIs are already polled every 60s by the
     * WorkBuddy and TRAE cards, and two WorkBuddy accounts on this machine are
     * flagged upstream as account-restricted for unusual traffic; a third
     * per-account consumer inside a model picker would be exactly the wrong
     * kind of pressure. So opening the radar costs one local file read, and the
     * only thing that reaches upstream is the explicit refresh button.
     */
    const DAY_MS = 86400000;

    /*
     * How far ahead the panel speaks. The report script defaults to the same
     * number; the clamp exists because the snapshot on disk may still be a
     * 15-day file written before that default changed, and a figure the panel
     * is not supposed to talk about must not leak into the badge.
     */
    const DISPLAY_WINDOW_DAYS = 3;

    /** Compact credit figure: whole numbers above 100, one decimal below. */
    function creditNum(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return '';
      return String(n >= 100 ? Math.round(n) : Math.round(n * 10) / 10);
    }

    function shortTime(ms) {
      const d = new Date(ms);
      const p = (v) => String(v).padStart(2, '0');
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    /*
     * Whole days until an expiry, rounded DOWN.
     *
     * Rounding up was a lie in the direction that hurts: 30.7h left rendered as
     * "2d". A warning that overstates the remaining time is the one error an
     * expiry warning must not make, so the figure now under-reports and the
     * tooltip carries the hours. The +60s epsilon absorbs the milliseconds
     * between seeding a value and rendering it, which would otherwise turn an
     * exact "3 days from now" into floor(2.9999) = 2.
     */
    function daysUntil(ms, now) {
      const diff = ms - now;
      if (!Number.isFinite(diff)) return '';
      return String(Math.max(0, Math.floor((diff + 60000) / DAY_MS)));
    }

    /** Same instant as daysUntil, but spelled out: "1 天 4 小时", "6 小时". */
    function humanUntil(ms, now) {
      const diff = ms - now;
      if (!Number.isFinite(diff)) return '';
      if (diff <= 0) return '已过期';
      const days = Math.floor((diff + 60000) / DAY_MS);
      const hours = Math.floor((diff + 60000 - days * DAY_MS) / 3600000);
      if (days === 0) return Math.max(1, hours) + ' 小时';
      return hours === 0 ? days + ' 天' : days + ' 天 ' + hours + ' 小时';
    }

    /*
     * Sum the packages expiring inside the display window.
     *
     * Returns null when the detail is incomplete, because a partial total is
     * worse than none: the caller keeps using the stored figure in that case
     * rather than presenting a number that silently drops accounts. An entry
     * with no accounts at all is "known to be empty", not "unknown".
     */
    function expiringWithin(scope, now, windowDays) {
      if (!scope || typeof scope !== 'object') return null;
      const rows = Array.isArray(scope.accounts) ? scope.accounts
        : Array.isArray(scope.packages) ? [scope] : null;
      if (rows === null) return null;
      if (rows.length === 0) return { soon: 0, nearest: null };
      const cut = now + windowDays * DAY_MS;
      let soon = 0;
      let nearest = null;
      for (const row of rows) {
        /* An account with no packages[] could be "no packages" or "upstream
           gave no detail"; those are different facts and this function cannot
           tell them apart, so it declines to answer. */
        if (!Array.isArray(row?.packages) || row.packages.length === 0) return null;
        for (const pkg of row.packages) {
          const at = pkg?.expiresAtMs;
          const remain = Number(pkg?.remain);
          if (!Number.isFinite(at) || at <= now || at > cut) continue;
          if (!Number.isFinite(remain) || remain <= 0) continue;
          soon += remain;
          if (nearest === null || at < nearest) nearest = at;
        }
      }
      return { soon, nearest };
    }

    /*
     * How much actually expires AT one instant.
     *
     * expiringSoon is the sum over the whole window (16 packages for trae),
     * while nearestExpiryMs is only the earliest one of them. Pairing the two
     * in one sentence claims the entire window total drops at the first
     * timestamp — for trae that read "1904 分将在 11-11 23:37 过期" when only
     * 404 did, and 1400 more were still weeks of runway. Sum the packages that
     * share that exact instant instead, and return null when the snapshot
     * carries no package detail so the caller can fall back to a statement
     * that does not make the false claim.
     */
    function expiringAtInstant(scope, instant) {
      if (!scope || typeof scope !== 'object') return null;
      /* Accept both shapes it is called with: a provider entry (accounts[],
         for the headline) and a single account row (packages[] directly, for
         the per-account line). Writing this for one shape only made the
         per-account amount silently vanish. */
      const rows = Array.isArray(scope.accounts) ? scope.accounts
        : Array.isArray(scope.packages) ? [scope] : null;
      if (rows === null) return null;
      /* haveDetail ≠ haveMatch. Detail present with no package at this instant
         is a known 0; only a complete absence of package detail is unknown
         (null), and that is what lets the caller suppress the amount instead
         of inventing one. */
      let haveDetail = false;
      let sum = 0;
      for (const row of rows) {
        /* An empty packages[] carries no information — it is the shape the
           snapshot uses when the upstream never returned package detail — so
           it must count as unknown, not as "nothing expires here". */
        if (!Array.isArray(row?.packages) || row.packages.length === 0) continue;
        haveDetail = true;
        for (const pkg of row.packages) {
          if (pkg?.expiresAtMs !== instant) continue;
          const remain = Number(pkg.remain);
          if (Number.isFinite(remain) && remain > 0) sum += remain;
        }
      }
      return haveDetail ? sum : null;
    }

    /*
     * The headline sentence. "1904 分将在 11-11 23:37 过期" was wrong on both
     * counts: 1904 is the whole 15-day window total across 16 packages, and
     * only 404 of it expired at that instant. Say the window total is spread
     * out, then name the first drop and its own amount. When the snapshot has
     * no package detail the amount at that instant is unknown, so the sentence
     * drops the claim instead of guessing.
     */
    function creditsSoonLine(entry, soon, nearest, now, windowDays) {
      const windowText = windowDays > 0 ? '将在 ' + windowDays + ' 天内陆续过期' : '将陆续过期';
      if (nearest === null) return creditNum(soon) + ' 分' + windowText;
      const atAmount = expiringAtInstant(entry, nearest);
      const when = '最早 ' + shortTime(nearest) + '（剩 ' + humanUntil(nearest, now) + '）';
      return atAmount === null
        ? creditNum(soon) + ' 分' + windowText + '，' + when
        : creditNum(soon) + ' 分' + windowText + '，' + when + '到期 ' + creditNum(atAmount) + ' 分';
    }

    /*
     * Fold a stored figure and its recomputed window into the pair to display.
     *
     * The recomputed value wins whenever it exists: the snapshot on disk may
     * have been written against a wider window than the panel now speaks, and
     * showing a 15-day total under a "3 天内" caption is exactly the class of
     * false claim this whole block exists to prevent. When the detail is
     * missing, fall back to the stored pair — that is what the old code used
     * unconditionally, so the degradation path is the known-good one.
     */
    function withinWindow(storedSoon, storedNearest, scope, now) {
      const computed = expiringWithin(scope, now, DISPLAY_WINDOW_DAYS);
      if (computed === null) {
        return { soon: Number(storedSoon) || 0, nearest: typeof storedNearest === 'number' ? storedNearest : null };
      }
      return computed;
    }

    /** Per-provider view model, or null when there is nothing honest to show. */
    function creditsView(entry, now) {
      if (!entry) return null;
      const overdue = Number(entry.overdueRemain) || 0;
      const win = withinWindow(entry.expiringSoon, entry.nearestExpiryMs, entry, now);
      const soon = win.soon;
      const nearest = win.nearest;
      /* The snapshot is an external file: it can be written by an older
         script, hand-edited, or caught mid-write. Every array read below is
         guarded, because a throw inside render takes the whole panel down —
         a wrong badge is a cosmetic bug, a white screen is not. */
      const errors = Array.isArray(entry.errors) ? entry.errors : [];
      const rows = Array.isArray(entry.accounts) ? entry.accounts : [];
      const failed = errors.length;
      if (soon <= 0 && overdue <= 0 && failed <= 0) return null;
      return {
        soon,
        overdue,
        failed,
        nearest,
        label: soon > 0
          ? creditNum(soon) + (nearest === null ? '' : '·' + daysUntil(nearest, now) + 'd')
          : overdue > 0 ? '!' + creditNum(overdue) : '?' + failed,
        /* Rows are muted when the warning is only "some accounts could not be
           read" — that is stale information, not imminent loss. */
        kind: soon > 0 ? 'soon' : overdue > 0 ? 'dead' : 'quiet',
        title: [
          soon > 0 ? creditsSoonLine(entry, soon, nearest, now, DISPLAY_WINDOW_DAYS) : null,
          overdue > 0 ? creditNum(overdue) + ' 分已过到期时间但上游仍报余额，随时可能被回收' : null,
          /* Name the unreadable accounts: '?1' with no name gives the user
             nothing to act on, and a revoked credential is otherwise silent
             until it is re-logged-in. */
          failed > 0 ? failed + ' 个账号查不到积分（凭据失效或未登录）：'
            + errors.slice(0, 3).map((row) => (row && typeof row === 'object' ? row.nickname || row.scope : '') || '').filter(Boolean).join('、') : null,
          rows.slice(0, 3).map((row) => {
            if (!row || typeof row !== 'object') return null;
            const rowWin = withinWindow(row.expiringSoon, row.nearestExpiryMs, row, now);
            /* A row whose only expiring balance sits outside the window has
               nothing to say here — naming it under a 3-day heading would be
               the same overstatement, one level down. */
            if (!(rowWin.soon > 0) && !(row.overdueRemain > 0)) return null;
            const at = rowWin.nearest === null ? '?' : shortTime(rowWin.nearest);
            const atAmount = rowWin.nearest === null ? null : expiringAtInstant(row, rowWin.nearest);
            /* Same rule as the headline: only name an amount next to a moment
               when that amount really does expire at that moment. */
            const atText = atAmount === null ? '' : ' 到期 ' + creditNum(atAmount) + ' 分';
            return (row.nickname || row.scope) + '：窗口内 ' + creditNum(rowWin.soon) + ' 分，最早 ' + at + atText;
          }).filter(Boolean).join('\n'),
        ].filter(Boolean).join('\n'),
      };
    }

    /** How old the snapshot is, in hours (rounded down) — the badge is a
     *  statement about a moment in the past, so the footer says which moment. */
    function creditsAgeHours(meta) {
      const at = meta && meta.snapshot ? Number(meta.snapshot.generatedAtMs) : NaN;
      if (!Number.isFinite(at)) return null;
      return Math.max(0, Math.floor((Date.now() - at) / 3600000));
    }

    /** Older than a day: warn, because the figures no longer describe today. */
    function creditsStale(meta) {
      const hours = creditsAgeHours(meta);
      return hours !== null && hours >= 24;
    }

    function creditsLabel(meta, note, t) {
      if (note) return note;
      if (!meta || meta.missing === true) return t('creditsNone');
      const hours = creditsAgeHours(meta);
      if (hours === null) return t('creditsUnknown');
      if (hours < 1) return t('creditsJustNow');
      if (hours < 24) return t('creditsAgo') + ' ' + hours + 'h';
      return t('creditsAgo') + ' ' + Math.floor(hours / 24) + 'd';
    }

    function creditsHint(meta, note, manual, t) {
      if (manual) return t('creditsManual') + '\n' + manual;
      if (note) return note;
      if (!meta || meta.missing === true) {
        return t('creditsNoneHint') + (meta && meta.registeredScript ? '\n' + meta.registeredScript : '');
      }
      /* Name the window the panel actually speaks in, not the one the file
         was written with: a wide-window snapshot shown under a "15 天窗口"
         footer while the numbers above it are 3-day would be two different
         claims in one popover. */
      return t('creditsHint') + ' · ' + DISPLAY_WINDOW_DAYS + t('creditsWindowSuffix');
    }

    /**
     * Snapshot read + the one manual refresh. Like the catalog, nothing is
     * fetched until the popover opens.
     */
    function useCredits() {
      const [meta, setMeta] = React.useState(null);
      const [note, setNote] = React.useState('');
      const [manual, setManual] = React.useState('');
      const [refreshing, setRefreshing] = React.useState(false);
      const loadCredits = React.useCallback(async () => {
        /* No force here: the host serves this from a 15s cache, so opening the
           panel repeatedly is free. Only refresh() forces a re-read. */
        const body = await apiSoft('credits', {});
        if (body.ok === false) {
          /* A read failure must not take the model list down with it: the badge
             just disappears and the reason sits in the footer. */
          setMeta(null);
          setNote(body.error || '');
          setManual(body.manual || '');
          return;
        }
        setMeta(body);
        setNote('');
        setManual('');
      }, []);
      const refresh = React.useCallback(async () => {
        setRefreshing(true);
        setNote('');
        setManual('');
        try {
          const body = await apiSoft('creditsRefresh', {});
          if (body.ok === false) {
            /* The host refused to run the script (or the script failed). Both
               come with the command that does the same thing by hand. */
            setNote(body.error || '刷新失败');
            setManual(body.manual || '');
            return;
          }
          const fresh = await apiSoft('credits', { force: true });
          if (fresh.ok !== false) setMeta(fresh);
        } finally { setRefreshing(false); }
      }, []);
      return { meta, note, manual, refreshing, loadCredits, refresh };
    }

    /** Reasoning ladder for the current route (host model info, never hardcoded). */
    function useEfforts(current) {
      const [efforts, setEfforts] = React.useState({ list: [], currentEffort: null });
      const provider = current ? current.provider : null;
      const model = current ? current.model : null;
      /*
       * The ladder belongs to the ROUTE, so the fetch is keyed by provider and
       * model only. Keying it by `current.reasoningEffort` as well made every
       * effort pick re-run this effect: pickEffort updates `current`, the
       * dependency changed, and the same unchanged ladder was fetched again —
       * one wasted round trip per chip press. The selected effort is tracked
       * locally by pickEffort, so it only has to seed from the host once per
       * route. Capture it when the request starts instead of closing over
       * `current`, which would otherwise be stale now that effort is not a dep.
       */
      const effortAtRequest = current ? current.reasoningEffort : null;
      React.useEffect(() => {
        if (!provider || !model) { setEfforts({ list: [], currentEffort: null }); return; }
        let dead = false;
        api('modelInfo', { provider, model })
          .then(info => {
            if (dead) return;
            /* Wire shape is { id, name } — the visible chip text is the host's
               own label (e.g. 轻度/中度), resolved via effortLabel at render. */
            const list = Array.isArray(info.efforts)
              ? info.efforts.filter(e => e && typeof e.id === 'string' && e.id !== '')
              : [];
            setEfforts({ list, currentEffort: effortAtRequest || info.defaultEffort || null });
          })
          .catch(() => { if (!dead) setEfforts({ list: [], currentEffort: effortAtRequest || null }); });
        return () => { dead = true; };
      }, [provider, model]);
      return { efforts, setEfforts };
    }

    /**
     * The provider the right pane should open on: the current model's own
     * provider when it has models, else the first provider that advertises
     * any, else the first. Never a provider with an empty list — that was the
     * "右侧永远空" bug.
     */
    function pickDefaultProvider(providers, current) {
      if (current) {
        const own = providers.find(p => p.provider === current.provider && p.models.length > 0);
        if (own) return own.provider;
      }
      const stocked = providers.find(p => p.models.length > 0);
      return stocked ? stocked.provider : (providers[0] ? providers[0].provider : '');
    }

    /**
     * Popover placement: opens toward whichever side has room, right-aligned.
     *
     * Vertical anchoring is never a computed `top` when opening upward. The
     * popover does not exist yet on the very first place() call (it renders
     * only once `pos` is set), so a top computed from a measured height has to
     * guess on that first paint — with the old fallback it assumed 360px and
     * the panel visibly jumped to its real height once ResizeObserver fired.
     * Anchoring the bottom edge 8px above the trigger is height-independent:
     * the first paint is already correct, and a shorter or taller panel grows
     * upward instead of moving. Horizontal still needs the measured width,
     * because the panel is right-aligned to the trigger and 420px is only a
     * maximum.
     *
     * Flipping matters now that the entry also lives in the New Session row:
     * that row sits near the top of the viewport, where "always open upward"
     * has only ~32px to work with. The old `Math.max(160, above)` floor then
     * pinned a 160px panel whose bottom edge was 8px above a trigger 52px from
     * the top — 116px of it hung off the viewport. So: open upward when there
     * is at least MIN_PANEL above, otherwise downward, and let maxHeight be the
     * room actually available on the chosen side (still capped at 360).
     */
    const POPOVER_MIN = 160;
    const POPOVER_MAX = 360;
    const POPOVER_MARGIN = 12;
    const POPOVER_GAP = 8;

    function usePopoverPlacement(open, triggerRef, popRef) {
      const [pos, setPos] = React.useState(null);
      const place = React.useCallback(() => {
        const el = triggerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const menu = popRef.current;
        const lw = menu ? menu.offsetWidth : 0;
        const width = lw > 0 ? lw : Math.min(420, window.innerWidth - POPOVER_MARGIN * 2);
        let left = rect.right - width;
        left = Math.min(Math.max(left, POPOVER_MARGIN), window.innerWidth - width - POPOVER_MARGIN);
        /* Room on each side, measured against the viewport margins and the gap
           to the trigger. Upward is the default (it is what the composer row
           has always used); it is abandoned only when it cannot hold a usable
           panel and the other side can hold a bigger one. */
        const above = rect.top - POPOVER_GAP - POPOVER_MARGIN;
        const below = window.innerHeight - rect.bottom - POPOVER_GAP - POPOVER_MARGIN;
        const openUp = above >= POPOVER_MIN || above >= below;
        if (openUp) {
          setPos({
            left,
            bottom: window.innerHeight - rect.top + POPOVER_GAP,
            maxHeight: Math.min(POPOVER_MAX, Math.max(POPOVER_MIN, above)),
          });
        } else {
          setPos({
            left,
            top: rect.bottom + POPOVER_GAP,
            maxHeight: Math.min(POPOVER_MAX, Math.max(POPOVER_MIN, below)),
          });
        }
      }, [triggerRef, popRef]);
      return { pos, place };
    }

    /** Radar body: search box + provider column + flying model column. */
    function RadarPanel({ data, error, t, onDone, onPick, effortBar, credits, creditsFoot }) {
      const cur = data.current;
      const now = Date.now();
      /*
       * Providers that advertise zero models are dropped entirely: they can
       * never produce a selection, they only lengthen the column and push the
       * real entries out of sight. Filtering happens before search so an empty
       * provider can never "match" and re-enter the list.
       */
      const stocked = data.providers.filter(p => p.models.length > 0);

      const [query, setQuery] = React.useState('');
      const [active, setActive] = React.useState(() => pickDefaultProvider(stocked, cur));
      const [hl, setHl] = React.useState(0);
      const inputRef = React.useRef(null);
      const listRef = React.useRef(null);

      React.useEffect(() => { const el = inputRef.current; if (el) el.focus(); }, []);

      const q = query.trim().toLowerCase();
      const hit = (text) => !q || String(text).toLowerCase().includes(q);
      const providers = stocked.filter(p =>
        hit(p.provider + ' ' + p.name) || p.models.some(m => hit(m.id + ' ' + m.name)));
      const shown = providers.find(p => p.provider === active) || providers[0] || null;
      const models = shown ? shown.models.filter(m => hit(m.id + ' ' + m.name)) : [];
      const recent = (data.recent || []).filter(r => hit(r.provider + '/' + r.model));
      const shownKey = shown ? shown.provider : '';

      /*
       * Snapshot channels are keyed by region too (workbuddy / workbuddy-global,
       * trae / trae-global) which is exactly how the catalog names its providers,
       * so the join is a name match — nothing is inferred across regions.
       */
      const creditsFor = {};
      const snap = credits && credits.missing !== true ? credits.snapshot : null;
      if (snap && snap.providers) {
        for (const p of stocked) {
          const view = creditsView(snap.providers[p.provider], now);
          if (view) creditsFor[p.provider] = view;
        }
      }

      /* Reset the keyboard highlight whenever the visible model list changes. */
      React.useEffect(() => { setHl(models.length > 0 ? 0 : -1); }, [shownKey, q]);

      /*
       * Keep the highlighted row visible inside the scrolling column — and
       * ONLY that column. scrollIntoView() walks every scrollable ancestor,
       * the document among them, so arrowing past the last visible row could
       * scroll the chat behind the popover. Doing the arithmetic by hand keeps
       * the movement local to `.mr-models`.
       */
      React.useEffect(() => {
        const box = listRef.current;
        if (!box) return;
        const el = box.querySelector('.mr-model.hl');
        if (!el) return;
        /* rect deltas, not offsetTop: the nearest positioned ancestor here is
           the popover (.mr-pop is position:fixed), not the scrolling column,
           so offsetTop would be measured against the wrong box. */
        const b = box.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        if (r.top < b.top) box.scrollTop -= b.top - r.top;
        else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
      }, [hl]);

      const onKeyDown = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onDone(); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (models.length === 0) return;
          setHl(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + models.length) % models.length);
          return;
        }
        if (e.key === 'Enter' && models[hl]) { e.preventDefault(); onPick(shown.provider, models[hl].id); }
      };

      const emptyText = q ? t('noMatch') : t('noModels');

      /* Footer text describes whatever row the keyboard is on. */
      const nf = models[hl];
      const focusMeta = nf
        ? [
          nf.id,
          fmtCtx(nf.contextWindow) ? fmtCtx(nf.contextWindow) + ' ctx' : '',
          nf.inputModalities && nf.inputModalities.indexOf('image') >= 0 ? t('vision') : '',
        ].filter(Boolean).join(' · ')
        : '';

      /*
       * One row per provider that threw. The host's own selector renders these
       * and a plugin that silently drops the group leaves an unexplained hole;
       * the text names the group so the row is actionable without opening the
       * failure diary. id '*' marks a failed provider LIST, which has no name.
       */
      const failures = Array.isArray(data.failures) ? data.failures : [];

      return h(React.Fragment, null,
        h('div', { className: 'mr-search' },
          h('input', {
            ref: inputRef, type: 'search', value: query, placeholder: t('search'),
            spellCheck: false, autoComplete: 'off',
            onChange: e => setQuery(e.target.value),
            onKeyDown,
          }),
        ),
        failures.length === 0 ? null : h('div', { className: 'mr-fails' },
          failures.map(f => h('div', { className: 'mr-fail', key: 'f:' + f.id, title: f.message },
            f.id === '*'
              ? t('groupLoadFailedAll', { message: f.message })
              : t('groupLoadFailed', { name: f.name || f.id, message: f.message }),
          )),
        ),
        h('div', { className: 'mr-cols' },
          h('div', { className: 'mr-provs' },
            !q && recent.length > 0 ? h(React.Fragment, null,
              h('div', { className: 'mr-sec' }, t('recent')),
              recent.slice(0, 3).map(r => {
                const isCur = cur && cur.provider === r.provider && cur.model === r.model;
                return h('button', {
                  key: 'rec:' + r.provider + '/' + r.model, type: 'button',
                  className: 'mr-model' + (isCur ? ' cur' : ''),
                  title: r.provider + '/' + r.model,
                  onClick: () => onPick(r.provider, r.model),
                }, h('span', { className: 'n' }, r.provider + '/' + r.model));
              }),
            ) : null,
            h('div', { className: 'mr-sec' }, t('providers')),
            providers.length === 0
              ? h('div', { className: 'mr-empty' }, t('noMatch'))
              : providers.map(p => {
                /* One compact warning per provider: credits about to be lost.
                   Absent (not "0") when there is nothing to warn about. */
                const warn = creditsFor[p.provider] || null;
                return h('button', {
                  key: p.provider, type: 'button',
                  className: 'mr-prov' + (shownKey === p.provider ? ' on' : ''),
                  title: p.name,
                  onMouseEnter: () => setActive(p.provider),
                  onFocus: () => setActive(p.provider),
                  onClick: () => setActive(p.provider),
                },
                  h('span', { className: 'n' }, p.name),
                  warn ? h('span', {
                    className: 'x' + (warn.kind === 'soon' ? '' : warn.kind === 'dead' ? ' dead' : ' quiet'),
                    title: warn.title,
                  }, warn.label) : null,
                  h('span', { className: 'c' + (p.models.length === 0 ? ' zero' : '') },
                    String(p.models.length)));
              }),
          ),
          h('div', { className: 'mr-models', ref: listRef },
            !shown
              ? h('div', { className: 'mr-empty' }, t('pickProvider'))
              : h(React.Fragment, null,
                /*
                 * The header names the provider, nothing else. The earlier
                 * "name · models (open at right)" wording wrapped onto two
                 * lines inside the 190px column and read as a broken label.
                 */
                h('div', { className: 'mr-sec' }, shown.name),
                h('div', { className: 'mr-sec sub' }, t('modelsIn')),
                models.length === 0
                  ? h('div', { className: 'mr-empty' }, emptyText)
                  : models.map((m, i) => {
                    const isCur = cur && cur.provider === shown.provider && cur.model === m.id;
                    /*
                     * Metadata lives in ONE row at the bottom (see the footer
                     * below) instead of trailing every model id. Two chips per
                     * row inside a ~190px column truncated the id itself to
                     * "deepseek-…", which is the one thing the row must say.
                     */
                    return h('button', {
                      key: shown.provider + '/' + m.id, type: 'button',
                      className: 'mr-model' + (isCur ? ' cur' : '') + (i === hl ? ' hl' : ''),
                      title: shown.provider + '/' + m.id,
                      onMouseEnter: () => setHl(i),
                      onClick: () => onPick(shown.provider, m.id),
                    },
                      h('span', { className: 'n' }, m.name === m.id ? m.id : m.name),
                      /* Badge before the checkmark: the host's own trigger puts
                         it ahead of the name, and a row that already ends in ✓
                         must not end in two competing marks. tone is an open
                         string on the wire; unknown tones fall back to neutral. */
                      m.badge && m.badge.text
                        ? h('span', {
                          className: 'bg' + (BADGE_TONES[m.badge.tone] ? ' ' + BADGE_TONES[m.badge.tone] : ''),
                          title: m.badge.text,
                        }, m.badge.text)
                        : null,
                      isCur ? h('span', { className: 'b' }, '✓') : null,
                    );
                  }),
              ),
          ),
        ),
        effortBar || null,
        h('div', { className: 'mr-foot' },
          error
            ? h('span', { className: 'err' }, error)
            : h('span', { className: 'meta' }, focusMeta || t('footHint')),
          creditsFoot || null,
          h('span', null, '↑↓ Enter · Esc'),
        ),
      );
    }

    /** The radar icon: concentric arcs plus a sweep, drawn in currentColor. */
    function RadarIcon() {
      return h('svg', { className: 'ico', viewBox: '0 0 16 16', 'aria-hidden': true },
        h('circle', { cx: 8, cy: 8, r: 6.4 }),
        h('circle', { cx: 8, cy: 8, r: 3.6 }),
        h('circle', { cx: 8, cy: 8, r: 1.1, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M8 8 L12.6 3.4' }),
      );
    }

    /**
     * The bypass entry point: a pill in the composer dock that opens the radar
     * card. It owns its own open/close state — nothing else on the page has to
     * mount first, so it cannot self-collapse the way the old seat-watching
     * fallback did.
     */
    function RadarDock({ sessionId, t, surface }) {
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const triggerRef = React.useRef(null);
      const popRef = React.useRef(null);
      const { data, setData, error, setError, load } = useRadar(sessionId);
      const { pos, place } = usePopoverPlacement(open, triggerRef, popRef);
      const cur = data ? data.current : null;
      const { efforts, setEfforts } = useEfforts(cur);
      /* Credits badge: appended after the existing hooks so the hook order of
         open/busy/refs/data/error/pos/efforts stays exactly as shipped. */
      const { meta: credits, note: creditsNote, manual: creditsManual, refreshing, loadCredits, refresh } = useCredits();
      /* 'hero' means the New Session row, whose baseline is 28px (workspace
         chip), not the composer dock row's 22px. Geometry only — see CSS. */
      const pillClass = surface === 'hero' ? 'mr-pill mr-hero' : 'mr-pill';

      /* Same lazy rule as the catalog: read the snapshot on first open only.
         This is one local file read on the host, not an upstream call. */
      React.useEffect(() => {
        if (!open) return;
        loadCredits();
      }, [open, loadCredits]);

      /* Nothing is fetched on mount. The pill always reads "模型雷达"; the route
         only appears in its title attribute, and the effort chips only exist
         inside the panel. Reading the catalog plus model info here cost two
         round trips per mounted session to populate a tooltip nobody had
         opened — so the first read happens on first open instead. */
      React.useEffect(() => {
        if (!open) return;
        load();
        place();
        const away = (e) => {
          if (e.target.closest && (e.target.closest('.mr-pop') || e.target.closest('.mr-pill'))) return;
          setOpen(false);
        };
        const key = (e) => { if (e.key === 'Escape') setOpen(false); };
        const reflow = () => place();
        document.addEventListener('mousedown', away, true);
        document.addEventListener('keydown', key, true);
        window.addEventListener('resize', reflow);
        window.addEventListener('scroll', reflow, true);
        const menu = popRef.current;
        const watcher = typeof ResizeObserver !== 'undefined' && menu ? new ResizeObserver(reflow) : null;
        if (watcher && menu) watcher.observe(menu);
        /* The popover is fixed, so it does not follow the trigger on its own.
           A multi-line composer grows the card and pushes the dock row down
           without firing resize or scroll — watch the trigger box itself. */
        const anchor = triggerRef.current;
        const anchorWatcher = typeof ResizeObserver !== 'undefined' && anchor
          ? new ResizeObserver(reflow) : null;
        if (anchorWatcher && anchor) anchorWatcher.observe(anchor);
        return () => {
          document.removeEventListener('mousedown', away, true);
          document.removeEventListener('keydown', key, true);
          window.removeEventListener('resize', reflow);
          window.removeEventListener('scroll', reflow, true);
          if (watcher) watcher.disconnect();
          if (anchorWatcher) anchorWatcher.disconnect();
        };
      }, [open, load, place]);

      const close = () => setOpen(false);
      const confirm = (selection) => {
        setData(d => (d ? { ...d, current: selection } : d));
        close();
      };

      const pick = async (provider, model) => {
        setBusy(true); setError('');
        try {
          const body = await api('select', { sessionId, provider, model });
          confirm(body.selection);
        } catch (e) { setError(String(e && e.message ? e.message : e)); }
        finally { setBusy(false); }
      };

      /*
       * The knob settles the instant the pointer is released, then the host is
       * told. It used to be the other way round: setEfforts only ran AFTER
       * `await api('select')` came back, so a pick sat on the old rung for one
       * host round trip (1-2s on a cold channel) and — because the write also
       * set `busy` — the whole rail dimmed and went inert while it waited. A
       * slider that lags its own thumb reads as broken even when the write
       * eventually lands, so the local rung is optimistic, `busy` is not
       * touched by effort writes at all, and a rejection rolls back only if no
       * newer pick has been made in the meantime.
       */
      const pickEffort = async (effort) => {
        if (!cur) return;
        const was = efforts.currentEffort;
        setEfforts(e => ({ ...e, currentEffort: effort }));
        setError('');
        try {
          const body = await api('select', {
            sessionId, provider: cur.provider, model: cur.model, reasoningEffort: effort,
          });
          setData(d => (d ? { ...d, current: body.selection } : d));
        } catch (e) {
          /* Roll back only if the knob is still where this failed pick left it.
             A stale rejection must not undo a newer, successful pick. Comparing
             the value needs no extra hook, which matters: RadarDock's hook
             order is seeded positionally by verify-client.mjs. */
          setEfforts(e2 => (e2.currentEffort === effort ? { ...e2, currentEffort: was } : e2));
          setError(String(e && e.message ? e.message : e));
        }
      };

      /*
       * Keep the pill short: icon + "模型雷达" + chevron.
       *
       * It used to also echo the current route ("… deepseek-v4.1-flash-free"),
       * which measured 318px — nearly half of the 743px dock row. The shipped
       * trigger sits in the same row and already names the model and effort, so
       * repeating it bought nothing and left the row crowded. The route is still
       * one keystroke away: it is on the pill's title attribute, and the panel
       * marks the current model with a check plus the provider heading.
       */
      const route = busy ? t('switching')
        : cur
          ? cur.model + (cur.reasoningEffort ? ' · ' + effortLabel(t, cur.reasoningEffort) : '')
          : '';

      return h('div', { className: 'mr-root' },
        h('style', null, CSS),
        h('button', {
          ref: triggerRef, className: pillClass, type: 'button',
          'aria-expanded': open, 'aria-haspopup': 'dialog',
          title: route ? t('dockTitle') + ' — ' + route : t('dockTitle'),
          onClick: () => setOpen(o => !o),
        },
          h(RadarIcon),
          h('span', { className: 'txt' }, t('dockIdle')),
          h('svg', { className: 'chev', viewBox: '0 0 16 16', 'aria-hidden': true },
            h('path', { d: 'M4 6l4 4 4-4' })),
        ),
        open && pos ? ReactDOM.createPortal(h('div', {
          className: 'mr-pop',
          ref: popRef,
          role: 'dialog',
          /* pos carries either `bottom` (opened upward) or `top` (flipped down
             for a trigger near the top of the viewport); exactly one is set, so
             pass both through and let the absent one stay undefined. */
          style: { left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight },
        },
          data
            ? h(RadarPanel, {
              data, error, t, onDone: close, onPick: pick,
              credits,
              /* The only control in this panel that can reach upstream, so it is
                 a deliberate button and never automatic. */
              creditsFoot: h('span', { className: 'x' },
                h('span', {
                  className: 'lab' + (creditsStale(credits) ? ' warn' : ''),
                  title: creditsHint(credits, creditsNote, creditsManual, t),
                }, creditsLabel(credits, creditsNote, t)),
                h('button', {
                  type: 'button', className: 'mr-refresh', disabled: refreshing,
                  title: creditsManual || t('creditsRefreshTitle'),
                  onClick: () => { refresh(); },
                }, refreshing ? t('creditsRefreshing') : t('creditsRefresh')),
              ),
              /* Same props, same hook order: the rail owns its own hooks because
                 RadarDock's slots are seeded by verify-client.mjs positionally. */
              effortBar: cur && efforts.list.length > 0 ? h(EffortBar, {
                t: t,
                list: efforts.list,
                value: efforts.currentEffort,
                onPick: pickEffort,
                disabled: busy,
              }) : null,
            })
            : h('div', { className: 'mr-empty' }, error || t('loading')),
        ), document.body) : null,
      );
    }

    /**
     * Seat: replaces the stock model trigger + popup.
     * ONLY mounted when REGISTER_SEAT is true — see the switch note at the top.
     */
    function ModelSeat({ sessionId, t }) {
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const triggerRef = React.useRef(null);
      const popRef = React.useRef(null);
      const { data, setData, error, setError, load } = useRadar(sessionId);
      const { pos, place } = usePopoverPlacement(open, triggerRef, popRef);
      const cur = data ? data.current : null;
      const { efforts, setEfforts } = useEfforts(cur);

      React.useEffect(() => {
        if (!open) return;
        load();
        place();
        const away = (e) => {
          if (e.target.closest && (e.target.closest('.mr-pop') || e.target.closest('.mr-trigger'))) return;
          setOpen(false);
        };
        const key = (e) => { if (e.key === 'Escape') setOpen(false); };
        const reflow = () => place();
        document.addEventListener('mousedown', away, true);
        document.addEventListener('keydown', key, true);
        window.addEventListener('resize', reflow);
        window.addEventListener('scroll', reflow, true);
        const menu = popRef.current;
        const watcher = typeof ResizeObserver !== 'undefined' && menu ? new ResizeObserver(reflow) : null;
        if (watcher && menu) watcher.observe(menu);
        return () => {
          document.removeEventListener('mousedown', away, true);
          document.removeEventListener('keydown', key, true);
          window.removeEventListener('resize', reflow);
          window.removeEventListener('scroll', reflow, true);
          if (watcher) watcher.disconnect();
        };
      }, [open, load, place]);

      const close = () => setOpen(false);
      const pick = async (provider, model) => {
        setBusy(true); setError('');
        try {
          const body = await api('select', { sessionId, provider, model });
          setData(d => (d ? { ...d, current: body.selection } : d));
          close();
        } catch (e) { setError(String(e && e.message ? e.message : e)); }
        finally { setBusy(false); }
      };
      /*
       * The knob settles the instant the pointer is released, then the host is
       * told. It used to be the other way round: setEfforts only ran AFTER
       * `await api('select')` came back, so a pick sat on the old rung for one
       * host round trip (1-2s on a cold channel) and — because the write also
       * set `busy` — the whole rail dimmed and went inert while it waited. A
       * slider that lags its own thumb reads as broken even when the write
       * eventually lands, so the local rung is optimistic, `busy` is not
       * touched by effort writes at all, and a rejection rolls back only if no
       * newer pick has been made in the meantime.
       */
      const pickEffort = async (effort) => {
        if (!cur) return;
        const was = efforts.currentEffort;
        setEfforts(e => ({ ...e, currentEffort: effort }));
        setError('');
        try {
          const body = await api('select', {
            sessionId, provider: cur.provider, model: cur.model, reasoningEffort: effort,
          });
          setData(d => (d ? { ...d, current: body.selection } : d));
        } catch (e) {
          /* Roll back only if the knob is still where this failed pick left it.
             A stale rejection must not undo a newer, successful pick. Comparing
             the value needs no extra hook, which matters: RadarDock's hook
             order is seeded positionally by verify-client.mjs. */
          setEfforts(e2 => (e2.currentEffort === effort ? { ...e2, currentEffort: was } : e2));
          setError(String(e && e.message ? e.message : e));
        }
      };

      const label = busy ? t('switching')
        : cur
          ? cur.model + (cur.reasoningEffort ? ' · ' + effortLabel(t, cur.reasoningEffort) : '')
          : t('noSelection');

      return h('div', { className: 'mr-root' },
        h('style', null, CSS),
        h('button', {
          ref: triggerRef, className: 'mr-trigger', type: 'button',
          'aria-expanded': open, 'aria-haspopup': 'dialog',
          title: cur ? cur.provider + '/' + cur.model : label,
          onClick: () => setOpen(o => !o),
        },
          h('span', { className: 'txt' }, label),
          h('svg', { className: 'chev', viewBox: '0 0 16 16', 'aria-hidden': true },
            h('path', { d: 'M4 6l4 4 4-4' })),
        ),
        open && pos ? ReactDOM.createPortal(h('div', {
          className: 'mr-pop',
          ref: popRef,
          role: 'dialog',
          /* pos carries either `bottom` (opened upward) or `top` (flipped down
             for a trigger near the top of the viewport); exactly one is set, so
             pass both through and let the absent one stay undefined. */
          style: { left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight },
        },
          data
            ? h(RadarPanel, {
              data, error, t, onDone: close, onPick: pick,
              /* Same props, same hook order: the rail owns its own hooks because
                 RadarDock's slots are seeded by verify-client.mjs positionally. */
              effortBar: cur && efforts.list.length > 0 ? h(EffortBar, {
                t: t,
                list: efforts.list,
                value: efforts.currentEffort,
                onPick: pickEffort,
                disabled: busy,
              }) : null,
            })
            : h('div', { className: 'mr-empty' }, error || t('loading')),
        ), document.body) : null,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const dicts = {
          zh: {
            noSelection: '未选择模型', loading: '加载模型目录…',
            search: '搜索模型 / 提供方…', recent: '最近使用', providers: '提供方',
            modelsIn: '选择模型', pickProvider: '把鼠标移到左侧提供方上，它的模型在右边展开',
            noMatch: '没有匹配项', noModels: '该提供方没有暴露任何模型',
            groupLoadFailed: '{name} 加载失败：{message}',
            groupLoadFailedAll: '提供方列表加载失败：{message}',
            retry: '重试',
            switching: '切换中…', footHint: '点击模型即切换本会话模型',
            vision: '视觉', effort: '推理等级',
            effortMinimal: '最低', effortLow: '低', effortMedium: '中',
            effortHigh: '高', effortXhigh: '极高',
            dockIdle: '模型雷达', dockTitle: '模型雷达：按提供方分组浏览全部模型（不替换输入框里的官方选择器）',
            creditsNone: '无积分快照', creditsUnknown: '快照不可用',
            creditsJustNow: '刚刷新', creditsAgo: '快照', creditsWindowSuffix: '天窗口',
            creditsRefresh: '刷新', creditsRefreshing: '查询中…',
            creditsRefreshTitle: '跑一次报告脚本，向三家各查一轮（这是唯一会打到上游的按钮）',
            creditsHint: '只读本地快照，不向上游发请求；要最新数字点右侧刷新',
            creditsNoneHint: '还没有快照。手动跑一次：node report.mjs --snapshot=<目录>/latest.json，之后这里就有数据',
            creditsManual: '本机宿主不让插件起子进程，请手动跑这一条：',
            motionOn: '粒子在动（点一下静止）',
            motionOff: '粒子已静止（点一下恢复）',
          },
          en: {
            noSelection: 'No model', loading: 'Loading catalog…',
            search: 'Search models / providers…', recent: 'Recent', providers: 'Providers',
            modelsIn: 'pick a model', pickProvider: 'Hover a provider to open its models at right',
            noMatch: 'No matches', noModels: 'This provider advertises no models',
            groupLoadFailed: '{name} failed to load: {message}',
            groupLoadFailedAll: 'Provider list failed to load: {message}',
            retry: 'Retry',
            switching: 'Switching…', footHint: 'Click a model to switch this session',
            vision: 'vision', effort: 'Effort',
            effortMinimal: 'Minimal', effortLow: 'Low', effortMedium: 'Medium',
            effortHigh: 'High', effortXhigh: 'Extra high',
            dockIdle: 'Model radar', dockTitle: 'Model radar: browse every model grouped by provider (the shipped composer selector stays in place)',
            creditsNone: 'no credits snapshot', creditsUnknown: 'credits snapshot unavailable',
            creditsJustNow: 'credits just refreshed', creditsAgo: 'credits snapshot', creditsWindowSuffix: 'd window',
            creditsRefresh: 'Refresh', creditsRefreshing: 'querying…',
            creditsRefreshTitle: 'Run the report script once — one round per channel upstream (the only button here that reaches them)',
            creditsHint: 'Reads a local snapshot only, no upstream calls; press Refresh for current figures',
            creditsNoneHint: 'No snapshot yet. Run it once by hand: node report.mjs --snapshot=<dir>/latest.json',
            creditsManual: 'This host forbids spawning the report script; run it by hand:',
            motionOn: 'Particles are moving (click to freeze)',
            motionOff: 'Particles are frozen (click to animate)',
          },
        };
        ctx.effect(() => ctx.locale.register(NS, dicts), 'dsh-model-radar: dictionaries');
        const t = ctx.locale.bind(NS);

        /*
         * The bypass entry point. `conversation.composer.dock` is kind:list and
         * replaceRisk:'none' — a fresh id is ADDED beside the shipped entries
         * (activity / usage), it replaces nothing.
         *
         * `sessionId` arrives through inject: it is the first argument the slot
         * passes for session-scoped slots. Do not move it into the returned
         * object as a literal — see contract note 1 at the top of this file.
         */
        ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-model-radar',
          order: 40,
          registrant: 'dsh-model-radar',
          locale: NS,
          inject: (sessionId) => ({ sessionId }),
        }, (props) => h(RadarDock, { ...props, surface: 'dock', t }))), 'dsh-model-radar: composer dock entry');

        /*
         * New Session (hero) entry. The host does NOT render composer.dock in
         * that phase — conversation-client.js gates it on
         *   variant === "composer" && input !== undefined && sessionId !== undefined
         * and the hero passes variant:"hero", so the whole dock row (activity,
         * usage and us alike) disappears until the first message lands. The
         * hero row has its own list slot, conversation.hero.options
         * (replaceRisk:'none', declared by conversation.content / Kb), whose
         * own gate is only `sessionId !== undefined` — i.e. it shows for a
         * freshly created session, which is exactly the state the user was
         * missing us in. It is empty today, so a fresh id adds beside nothing.
         *
         * The two slots are mutually exclusive by construction (hero phase vs
         * composer phase), so this is never double-mounted; open state and the
         * catalog cache live per mounted instance either way.
         */
        ctx.effect(() => ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
          name: 'conversation.hero.options',
          id: 'dsh-model-radar',
          order: 40,
          registrant: 'dsh-model-radar',
          locale: NS,
          inject: (sessionId) => ({ sessionId }),
        }, (props) => h(RadarDock, { ...props, surface: 'hero', t }))), 'dsh-model-radar: new session entry');

        /*
         * Off by default. Flipping REGISTER_SEAT to true puts the radar INTO the
         * composer's model seat and shadows the shipped selector — read the
         * switch note at the top before doing that.
         */
        if (REGISTER_SEAT) {
          ctx.effect(() => ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
            name: 'conversation.input.model',
            id: 'dsh-model-radar',
            registrant: 'dsh-model-radar',
            locale: NS,
            inject: (sessionId) => ({ sessionId }),
          }, (props) => h(ModelSeat, { ...props, t }))), 'dsh-model-radar: model seat');
        }
      },
    };
  },
});
