/**
 * dsh-model-radar — Host half.
 *
 * Owns one fenced HTTP route, /radar/api, with four commands:
 *   catalog  — every provider and its advertised models, plus the session's
 *              current selection and its recent routes (folded from the log).
 *   select   — commit a model switch for one session. Primary path: the host
 *              sessionController's own selectModel (it appends the durable
 *              event AND refreshes the agent-scoped ref the request pipeline
 *              actually reads). Fallback path, for hosts without that seam:
 *              validate through llm.resolveCallConfig, append
 *              `model/selection`, then call @deepseek-ai/dsh-agent's
 *              installModelSelection(agentCtx) — which on 0.2.2 installs a
 *              pre-step "model changed" notice listener, NOT a selection ref.
 *              The appended event is the durable write; report append+notice.
 *   credits  — read the local credits-expiry snapshot (read-only, no upstream).
 *   creditsRefresh — run the report script once to rewrite that snapshot. This
 *              is the only upstream path in the plugin and only a deliberate
 *              click reaches it.
 *
 * The catalog walk and the selection fold replicate dsh-better-sidebar's
 * proven reading of the same seams. agent.options is deliberately NOT
 * trusted as "current model" — it freezes the creation-time default.
 */

import { spawn } from 'node:child_process';
import { existsSync, appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const name = 'dsh-model-radar';
const inject = ['webServer', 'sessions', 'connection'];

const PROVIDER_LIMIT = 40;
const MODEL_LIMIT = 80;

function firstString(...values) {
  for (const value of values) if (typeof value === 'string' && value !== '') return value;
  return '';
}

function providerEntryOf(entry) {
  if (entry === null || typeof entry !== 'object') return undefined;
  const record = entry;
  const provider = firstString(record.provider, record.route, record.id);
  if (provider === '') return undefined;
  return { provider, label: firstString(record.name, record.displayName, record.label, record.title, provider) };
}

function modelEntryOf(entry) {
  if (entry === null || typeof entry !== 'object') return undefined;
  const record = entry;
  const id = firstString(record.id, record.model, record.name);
  if (id === '') return undefined;
  /* badge is already on the wire from llm.listModels (llm.types validates
     {text: string | message, tone}); the host's own selector renders it as a
     Tag. Keep only the literal-text form — a message object would need an
     i18n resolver this plugin does not carry, and a dropped badge is better
     than a rendered "[object Object]". */
  const badge = record.badge;
  const badgeText = badge !== null && typeof badge === 'object' ? badge.text : undefined;
  return {
    id,
    name: firstString(record.name, record.displayName, record.label, record.title, id),
    ...(typeof record.contextWindow === 'number' && record.contextWindow > 0 ? { contextWindow: record.contextWindow } : {}),
    ...(Array.isArray(record.inputModalities) ? { inputModalities: record.inputModalities.filter(m => typeof m === 'string') } : {}),
    ...(typeof badgeText === 'string' && badgeText !== '' ? { badge: { text: badgeText, tone: typeof badge.tone === 'string' ? badge.tone : undefined } } : {}),
  };
}

/**
 * Normalize the host's reasoning metadata into the wire shape the picker reads.
 *
 * `resolveModelInfo` returns `reasoning.efforts` as OBJECTS
 * (`{ id, name, description? }`) — the shipped ModelSelect renders `effort.name`
 * and matches on `effort.id`. An earlier version filtered for `typeof e ===
 * 'string'`, which silently dropped every entry and made the whole reasoning
 * row disappear (reported as "思考轻度也没有了"). Accept both shapes so a host
 * that ever flattens to bare ids still works.
 */
function effortsOf(reasoning) {
  const raw = Array.isArray(reasoning?.efforts) ? reasoning.efforts : [];
  const efforts = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      if (entry !== '') efforts.push({ id: entry, name: entry });
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    const id = firstString(entry.id, entry.effort, entry.value);
    if (id === '') continue;
    efforts.push({ id, name: firstString(entry.name, entry.label, entry.title, id) });
  }
  const seen = new Set();
  const unique = efforts.filter(e => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  const fallback = typeof reasoning?.defaultEffort === 'string' && reasoning.defaultEffort !== ''
    ? reasoning.defaultEffort
    : null;
  return { efforts: unique, defaultEffort: fallback };
}

/**
 * The model's context capacity, or undefined when the deployment does not
 * report one.
 *
 * `listModels` is a list of IDS, not metadata: the core llm layer rebuilds
 * every entry with only provider/id/name/description/inputModalities, so a
 * `contextWindow` an adapter put there never survives the trip. The real
 * number lives in `resolveModelInfo`'s `context.contextWindow` — the same
 * field the host's own context gauge reads. Ask per model instead of trusting
 * the catalog entry, and treat every failure as "unknown": a model without a
 * published capacity must stay selectable.
 *
 * Cheap by construction, not luck: both shipped adapters answer this from
 * memory (pi-ai from its config snapshot, deepseek from the resolved key's
 * `options()`), so a sweep is object reads rather than HTTP round trips.
 */
async function contextWindowOf(llm, provider, model) {
  if (typeof llm.resolveModelInfo !== 'function') return undefined;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    const width = info?.context?.contextWindow;
    return typeof width === 'number' && width > 0 ? width : undefined;
  } catch {
    return undefined;
  }
}

async function buildCatalog(ctx) {
  const llm = ctx.get('llm');
  if (llm === undefined) return { providers: [], failures: [] };
  /* A provider that cannot answer must be visible, not silently absent: the
     host's own selector renders one warning row per failed group, and a plugin
     that just drops the group leaves the user staring at a hole with no reason
     for it. Collect the reason alongside the failure and keep going. */
  const failures = [];
  const listed = await Promise.resolve(llm.listProviders())
    .catch((error) => {
      failures.push({ id: '*', name: '', message: error instanceof Error ? error.message : String(error) });
      return [];
    });
  if (!Array.isArray(listed)) return { providers: [], failures };

  /* Resolve the provider list first, then ask every provider for its models
     concurrently. The old loop awaited one provider at a time, so a catalog
     read cost N sequential round trips; the panel re-reads the catalog on
     every open, which made that serial cost visible as a slow first paint. */
  const parsed = listed.slice(0, PROVIDER_LIMIT)
    .map(providerEntryOf)
    .filter(entry => entry !== undefined);
  const settled = await Promise.all(parsed.map(entry =>
    Promise.resolve(llm.listModels(entry.provider))
      .then(list => (Array.isArray(list) ? list.slice(0, MODEL_LIMIT) : []))
      .catch((error) => {
        /* Name the provider so the warning row can say which group is missing
           — a bare "load failed" with no name is not actionable. */
        failures.push({ id: entry.provider, name: entry.label, message: error instanceof Error ? error.message : String(error) });
        return [];
      })));

  const drafts = [];
  parsed.forEach((entry, index) => {
    const usable = settled[index].flatMap(model => {
      const item = modelEntryOf(model);
      return item === undefined ? [] : [item];
    });
    /* A provider that advertises nothing is not a choice — dropping it here
       keeps the wire payload (and therefore the column) free of dead rows. */
    if (usable.length === 0) return;
    drafts.push({ provider: entry.provider, name: entry.label, models: usable });
  });

  /* Fill in capacity for every model that did not declare one, across all
     providers at once. Sequential per provider would reintroduce the same
     N-times-worse latency the model sweep just lost. */
  await Promise.all(drafts.map(draft => Promise.all(draft.models.map(model =>
    model.contextWindow === undefined
      ? contextWindowOf(llm, draft.provider, model.id).then((width) => {
        if (width !== undefined) model.contextWindow = width;
      })
      : undefined))));

  return {
    providers: drafts.map(draft => ({ provider: draft.provider, name: draft.name, models: draft.models })),
    failures,
  };
}

/* The provider→model tree changes on the order of minutes, not milliseconds,
   while the panel asks for it on every open. Cache it briefly, and coalesce
   concurrent readers onto one in-flight build so opening the panel twice in
   quick succession cannot fan out into two full provider sweeps. */
const CATALOG_TTL_MS = 30_000;
let catalogCache = { at: 0, result: null, inflight: undefined };

async function catalogProviders(ctx) {
  const fresh = catalogCache.result !== null && Date.now() - catalogCache.at < CATALOG_TTL_MS;
  if (fresh) return catalogCache.result;
  if (catalogCache.inflight !== undefined) return catalogCache.inflight;
  const inflight = buildCatalog(ctx)
    .then((result) => {
      /* An empty sweep is usually a transient seam failure, not "the user has
         no models" — do not pin that answer for a whole TTL. */
      catalogCache = result.providers.length === 0
        ? { at: 0, result: null, inflight: undefined }
        : { at: Date.now(), result, inflight: undefined };
      return result;
    })
    .catch(() => {
      catalogCache = { at: 0, result: null, inflight: undefined };
      return { providers: [], failures: [] };
    });
  catalogCache.inflight = inflight;
  return inflight;
}

/** The session's effective selection: pending `model/selection` ?? last
 *  `request/header`, mirroring the core modelSelection projection. */
function effectiveSelection(events) {
  let pending;
  let lastUsed;
  for (const event of events) {
    if (event?.type === 'model/selection') {
      const data = event.data;
      if (data && typeof data.provider === 'string' && typeof data.model === 'string') {
        pending = { provider: data.provider, model: data.model, ...(typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {}) };
      }
      continue;
    }
    if (event?.type !== 'request/header') continue;
    const config = event.data?.header?.config;
    if (!config || typeof config !== 'object') continue;
    if (typeof config.provider !== 'string' || typeof config.model !== 'string') continue;
    const isDefaultEffort = event.data?.header?.adapterDefaults?.reasoningEffort === true;
    lastUsed = {
      provider: config.provider,
      model: config.model,
      ...(!isDefaultEffort && typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}),
    };
  }
  return pending ?? lastUsed;
}

/** Distinct recent routes, newest first — the "最近使用" rail. */
function recentRoutes(events, limit = 12) {
  const routes = [];
  const seen = new Set();
  for (let i = events.length - 1; i >= 0 && routes.length < limit; i--) {
    const config = events[i]?.type === 'request/header' ? events[i].data?.header?.config : undefined;
    if (!config || typeof config.provider !== 'string' || config.provider === '' || typeof config.model !== 'string' || config.model === '') continue;
    const key = `${config.provider}/${config.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ provider: config.provider, model: config.model });
  }
  return routes;
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/* ------------------------------------------------------------------ */
/* Failure diary                                                       */
/* ------------------------------------------------------------------ */

/* Same contract as dsh-prompt-forge's diary, deliberately: one file per
 * plugin under ~/.dsh/plugin-logs, one NDJSON line per FAILURE, nothing on the
 * success path. DSH_PLUGIN_LOG_DIR redirects it so a test can write somewhere
 * disposable.
 *
 * The catalog walk and the credits refresh are the two things here that talk to
 * the outside world, and they are exactly what the unit suites cannot cover:
 * the suites feed them stubs, so they prove the code handles an answer, never
 * that the answer arrived. When QA or a user says "the panel is empty", this
 * file is the difference between reading a cause and re-deriving one. */
const LOG_DIR_ENV = 'DSH_PLUGIN_LOG_DIR';
const LOG_MAX_BYTES = 256 * 1024;
const LOG_KEEP = 3;

function logDir() {
  const override = process.env[LOG_DIR_ENV];
  if (typeof override === 'string' && override !== '') return override;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return home === '' ? '' : join(home, '.dsh', 'plugin-logs');
}

/* Best-effort throughout: a diagnostic that throws turns a handled failure into
 * an unhandled one, which is the one thing this file must never do. */
function logFailure(command, fields) {
  try {
    const dir = logDir();
    if (dir === '') return;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name + '.ndjson');
    try {
      if (statSync(file).size >= LOG_MAX_BYTES) {
        for (let i = LOG_KEEP - 1; i >= 1; i -= 1) {
          try { renameSync(file + '.' + String(i), file + '.' + String(i + 1)); } catch { /* not there yet */ }
        }
        renameSync(file, file + '.1');
      }
    } catch { /* first write, or the size could not be read */ }
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), command, ...fields }) + '\n');
  } catch { /* a diary that cannot be written must not break the request */ }
}

/* A model route is the only thing in a radar request worth recording: it is
 * short, it is never personal, and it is the first question anyone asks when a
 * switch did not take. */
function failureFields(command, body, error) {
  const fields = { message: error instanceof Error ? error.message : String(error) };
  if (body !== null && typeof body === 'object') {
    if (typeof body.provider === 'string') fields.provider = body.provider;
    if (typeof body.model === 'string') fields.model = body.model;
  }
  return fields;
}

/* ------------------------------------------------------------------ *
 * Credits expiry: READ-ONLY on a local snapshot file.
 *
 * The numbers come from a report script the user runs (or triggers via the
 * refresh button). Nothing here touches a provider's upstream API: the
 * plugins' own cards already poll every 60s and two WorkBuddy accounts got
 * flagged `account-restricted` upstream, so a third per-account consumer in
 * the model picker would be the wrong kind of traffic. Opening the picker
 * therefore never costs a request — it stats and reads one small JSON file.
 * ------------------------------------------------------------------ */

/**
 * DSH_HOME is inconsistent across installs: here it already ends in `.dsh`,
 * elsewhere it is the plain user home. Normalise both to the real ~/.dsh so
 * the agreed snapshot directory does not silently depend on how the host was
 * launched. Same trap as the report script's own path handling.
 */
function dshHomeDir() {
  const raw = process.env.DSH_HOME || join(homedir(), '.dsh');
  const trimmed = raw.replace(/[\\/]+$/, '');
  return /[\\/]\.dsh$/.test(trimmed) || trimmed === '.dsh' ? trimmed : join(trimmed, '.dsh');
}

/**
 * Where the snapshot lives. Config wins (patch yml `config:` block), so a
 * non-default workspace needs no code change; the default is a host-level
 * directory that survives the workspace moving.
 */
function creditsPaths(config) {
  const dir = typeof config?.creditsDir === 'string' && config.creditsDir !== ''
    ? config.creditsDir
    : join(dshHomeDir(), 'credits-expiry');
  return { dir, snapshot: join(dir, 'latest.json'), source: join(dir, 'source.json') };
}

const creditsReadCache = { at: 0, key: '', value: null };
const CREDITS_READ_TTL_MS = 15_000;

/** Read the snapshot. `missing` is a normal state, not an error. */
async function readCreditsSnapshot(config, force) {
  const { dir, snapshot, source } = creditsPaths(config);
  const now = Date.now();
  if (!force && creditsReadCache.key === snapshot && creditsReadCache.at !== 0 && now - creditsReadCache.at < CREDITS_READ_TTL_MS) {
    return creditsReadCache.value;
  }
  let result;
  try {
    result = { ok: true, missing: false, path: snapshot, snapshot: JSON.parse(await readFile(snapshot, 'utf8')) };
  } catch (error) {
    const code = error?.code;
    result = code === 'ENOENT'
      ? { ok: true, missing: true, path: snapshot, dir }
      : { ok: false, missing: true, path: snapshot, dir, error: `快照文件读取失败：${error instanceof Error ? error.message : String(error)}` };
  }
  /* Tell the client how to get data if there is none, without hardcoding a
     workspace path: the script's own location is whatever registered last. */
  if (result.missing === true) {
    try { result.registeredScript = JSON.parse(await readFile(source, 'utf8'))?.script ?? null; }
    catch { result.registeredScript = null; }
  }
  creditsReadCache.at = now;
  creditsReadCache.key = snapshot;
  creditsReadCache.value = result;
  return result;
}

function invalidateCreditsRead() {
  creditsReadCache.at = 0;
  creditsReadCache.key = '';
  creditsReadCache.value = null;
}

/**
 * The address this request arrived on, as the caller sees it. Used to tell the
 * report script which port to read the local Qoder route from. Works with both
 * a Headers instance and a plain object, since the host hands us one of the two
 * depending on how the request was proxied.
 */
function selfHostOf(req) {
  const headers = req?.headers;
  if (headers === undefined || headers === null) return undefined;
  const read = (key) => {
    if (typeof headers.get === 'function') return headers.get(key);
    const lower = key.toLowerCase();
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === lower) return value;
    }
    return undefined;
  };
  const host = read('host');
  if (typeof host !== 'string' || host.length === 0) return undefined;
  /* A Host header is bare "127.0.0.1:58567"; the report script wants a URL.
     Forwarded/X-Forwarded-Proto would tell us https, but this server only
     speaks http on loopback, so hardcoding it cannot mislead. */
  return `http://${host}`;
}

/** One refresh at a time: the button is cheap to press twice. */
let creditsRefreshRun = null;
const CREDITS_REFRESH_TIMEOUT_MS = 90_000;

/**
 * Re-run the report script once, writing a fresh snapshot. This is the ONLY
 * path in this plugin that reaches upstream, and only a deliberate click gets
 * here. Uses the host's own node binary and a fixed script path, no shell.
 */
function refreshCreditsSnapshot(config, selfHost) {
  if (creditsRefreshRun !== null) return creditsRefreshRun;
  creditsRefreshRun = (async () => {
    const { snapshot, source } = creditsPaths(config);
    let registered = null;
    try { registered = JSON.parse(await readFile(source, 'utf8')); } catch { /* not registered */ }
    const script = typeof registered?.script === 'string' ? registered.script : null;
    if (script === null || !existsSync(script)) {
      return { ok: false, error: '找不到积分报告脚本：先跑一次 node report.mjs --snapshot=<该目录>/latest.json 让它登记' };
    }
    /* The report script reads Qoder credits from this very process's local
       route, so it needs to know our address. The host's own env may or may not
       carry DSH_WEB_URL, and scanning ports costs seconds, so hand it the Host
       header this request arrived on — it is exactly what the browser used. */
    const args = ['--snapshot=' + snapshot];
    if (typeof selfHost === 'string' && selfHost.length > 0) args.push('--host=' + selfHost);
    const started = Date.now();
    /* Under a packaged Electron host, process.execPath is the app binary, not
       node. ELECTRON_RUN_AS_NODE makes that same binary behave as plain node,
       which is how the host itself runs its child node processes. */
    const asNode = process.versions?.electron !== undefined ? { ELECTRON_RUN_AS_NODE: '1' } : {};
    const run = (capture) => new Promise((resolve) => {
      let child;
      try {
        child = spawn(process.execPath, [script, ...args], {
          cwd: dirname(script),
          env: { ...process.env, ...asNode },
          /* Constrained hosts refuse the named pipes a captured stdio needs
             (spawn EPERM). 'ignore' is allowed everywhere, so output capture is
             the attempt that gets retried without it rather than a hard failure. */
          stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
          windowsHide: true,
        });
      } catch (error) {
        /* A confined host throws here instead of emitting 'error'. */
        resolve({ spawnError: error instanceof Error ? error.message : String(error), errno: error?.code, tail: '' });
        return;
      }
      let tail = '';
      if (capture) {
        child.stdout.on('data', (chunk) => { tail = (tail + chunk).slice(-2000); });
        child.stderr.on('data', (chunk) => { tail = (tail + chunk).slice(-2000); });
      }
      let settled = false;
      const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ...value, tail }); };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish({ timedOut: true });
      }, CREDITS_REFRESH_TIMEOUT_MS);
      child.once('error', (error) => finish({ spawnError: error instanceof Error ? error.message : String(error), errno: error?.code }));
      child.once('close', (code) => finish({ code }));
    });

    let outcome = await run(true);
    if (outcome.spawnError !== undefined && outcome.errno === 'EPERM') {
      outcome = await run(false);
      if (outcome.spawnError === undefined) outcome.uncaptured = true;
    }
    invalidateCreditsRead();
    if (outcome.timedOut === true) return { ok: false, error: `刷新超时（>${CREDITS_REFRESH_TIMEOUT_MS / 1000}s），未确认上游是否响应` };
    /* Some hosts forbid spawning child processes outright (throw, or a child
       that dies before main). The snapshot is still readable either way, so
       hand the user the exact command that produces it — a refusal without a
       way forward just strands them. The --host is repeated here because a
       terminal has no DSH_WEB_URL: without it the script has to scan ports,
       and a scan that misses makes the Qoder section silently empty. */
    const manual = `node "${script}" --snapshot="${snapshot}"${typeof selfHost === 'string' && selfHost.length > 0 ? ` --host="${selfHost}"` : ''}`;
    if (outcome.spawnError !== undefined) {
      return { ok: false, error: `本机宿主不允许启动报告脚本：${outcome.spawnError}`, manual };
    }
    if (outcome.code !== 0) {
      return {
        ok: false,
        error: `报告脚本退出码 ${outcome.code}：${outcome.tail.slice(-200) || (outcome.uncaptured === true ? '（受限宿主，未捕获输出）' : '（无输出）')}`,
        manual,
      };
    }
    const fresh = await readCreditsSnapshot(config, true);
    return fresh.ok === true
      ? { ok: true, tookMs: Date.now() - started, snapshot: fresh.snapshot ?? null, missing: fresh.missing === true }
      : { ok: false, error: fresh.error ?? '刷新完成但读不到快照' };
  })().finally(() => { creditsRefreshRun = null; });
  return creditsRefreshRun;
}

async function handleSelect(ctx, body) {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const provider = typeof body.provider === 'string' ? body.provider : '';
  const model = typeof body.model === 'string' ? body.model : '';
  if (sessionId === '' || provider === '' || model === '') return { error: 'sessionId, provider and model are required', status: 400 };
  const reasoningEffort = typeof body.reasoningEffort === 'string' && body.reasoningEffort !== '' ? body.reasoningEffort : undefined;
  const selection = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };

  const agents = ctx.get('agents');
  const agent = agents?.get(sessionId);
  if (agent === undefined) return { error: 'the session is not live', status: 409 };

  /* Reject a route the deployment cannot route (mirrors the controller). */
  const llm = ctx.get('llm');
  if (llm?.resolveCallConfig !== undefined) {
    try {
      await llm.resolveCallConfig({ provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });
    } catch (error) {
      return { error: `model "${provider}/${model}" is unavailable: ${error instanceof Error ? error.message : String(error)}`, status: 400 };
    }
  }

  /* Primary: the host controller does append + ref refresh itself. */
  const controller = ctx.get('sessionController');
  if (controller?.selectModel !== undefined) {
    try {
      await controller.selectModel({ sessionId, provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });
      return { ok: true, selection, via: 'controller' };
    } catch (error) {
      return { error: `selectModel failed: ${error instanceof Error ? error.message : String(error)}`, status: 500 };
    }
  }

  /* Fallback for hosts without the seam: replicate what the composer commits.
     installModelSelection(agentCtx) takes ONE argument on 0.2.2 — it installs an
     agent/pre-step listener that appends a "[model changed: ...]" notice when the
     model switches; it does not install a selection ref, so there is nothing for a
     second argument to do. The appended event is the durable write either way. */
  agent.session.append('model/selection', selection);
  try {
    const { installModelSelection } = await import('@deepseek-ai/dsh-agent');
    installModelSelection(agent.ctx);
  } catch {
    /* No dsh-agent on this host: the appended event is still durable and the
       next cold read picks it up; report the degraded commit honestly. */
    return { ok: true, selection, via: 'append-only' };
  }
  return { ok: true, selection, via: 'append+notice' };
}

export function apply(ctx, config) {
  const fence = (req) => ctx.connection.requestRejection(req) === undefined;

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/radar/api',
    handler: async (req, res) => {
      if (!fence(req)) return json(res, 403, { ok: false, error: 'forbidden' });
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      let body;
      try { body = await readJsonBody(req); }
      catch (error) { return json(res, 400, { ok: false, error: `bad request body: ${error instanceof Error ? error.message : String(error)}` }); }

      try {
        if (body.command === 'catalog') {
          const catalog = await catalogProviders(ctx);
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
          const agent = sessionId === '' ? undefined : ctx.get('agents')?.get(sessionId);
          const events = agent?.session.snapshotEvents() ?? [];
          const fallback = ctx.get('agentDefaultModel')?.currentSelection?.();
          const fallbackRoute = fallback && typeof fallback.provider === 'string' && typeof fallback.model === 'string'
            ? { provider: fallback.provider, model: fallback.model }
            : undefined;
          return json(res, 200, {
            ok: true,
            providers: catalog.providers,
            /* Providers that threw. Optional on the wire: an old client that
               does not know the field simply ignores it, and an empty list is
               omitted rather than sent as [] so the payload stays identical to
               the pre-0.1.1 shape when everything is healthy. */
            ...(catalog.failures.length === 0 ? {} : { failures: catalog.failures }),
            current: effectiveSelection(events) ?? fallbackRoute ?? null,
            recent: recentRoutes(events),
          });
        }
        if (body.command === 'modelInfo') {
          const provider = typeof body.provider === 'string' ? body.provider : '';
          const model = typeof body.model === 'string' ? body.model : '';
          const llm = ctx.get('llm');
          if (llm?.resolveModelInfo === undefined || provider === '' || model === '') {
            return json(res, 200, { ok: true, efforts: [], defaultEffort: null });
          }
          try {
            const info = await llm.resolveModelInfo(provider, model);
            return json(res, 200, { ok: true, ...effortsOf(info?.reasoning) });
          } catch {
            return json(res, 200, { ok: true, efforts: [], defaultEffort: null });
          }
        }
        if (body.command === 'select') {
          const result = await handleSelect(ctx, body);
          return 'error' in result ? json(res, result.status, { ok: false, error: result.error }) : json(res, 200, result);
        }
        /* Read-only: one stat + one small file read, zero upstream traffic. */
        if (body.command === 'credits') {
          return json(res, 200, await readCreditsSnapshot(config, body.force === true));
        }
        /* The only path that reaches upstream, and only on a deliberate click. */
        if (body.command === 'creditsRefresh') {
          return json(res, 200, await refreshCreditsSnapshot(config, selfHostOf(req)));
        }
        return json(res, 400, { ok: false, error: 'unknown command' });
      } catch (error) {
        logFailure(typeof body?.command === 'string' ? body.command : 'unknown', failureFields(body?.command, body, error));
        return json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  }), `${name}: /radar/api route`);
}

export { name, inject };
