/**
 * verify-host.mjs — exercises index.js (the Host half) against stub services and
 * proves the three things a browser round-trip would prove, without the browser:
 *
 *   1. the route registers at exactly /radar/api and refuses non-POST / fenced;
 *   2. `catalog` projects the real llm provider→model tree, keeps only providers
 *      that advertise models, resolves `current` from model/selection events and
 *      falls back to agentDefaultModel, and folds recent routes deduped;
 *   3. `modelInfo` normalises BOTH effort shapes ({id,name,description} objects
 *      and bare strings) — the bug that silently ate the reasoning chips;
 *   4. `select` calls sessionController.selectModel first, and only falls back to
 *      append+notice / append-only when the controller is absent.
 *
 * Usage: node verify-host.mjs
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as plugin from './index.js';

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log('  ok   ' + label + (extra ? ' — ' + extra : '')); }
  else { failures++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); }
};

console.log('exports: name =', plugin.name, '| inject =', JSON.stringify(plugin.inject));
if (!Array.isArray(plugin.inject) || !plugin.inject.includes('webServer')) {
  throw new Error('host half must inject webServer');
}

/* ── stub llm / agents / controllers ───────────────────────────────────── */
/* Event shapes mirror the real session log: `model/selection` carries the
   selection under .data, and `request/header` nests it in .data.header.config
   with an adapterDefaults marker for effort. */
const selectionEvents = [
  { type: 'request/header', data: { header: { config: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } } } },
  { type: 'request/header', data: { header: { config: { provider: 'zhipu', model: 'glm-5.3' } } } },
  { type: 'request/header', data: { header: { config: { provider: 'zhipu', model: 'glm-5.3', reasoningEffort: 'medium' }, adapterDefaults: { reasoningEffort: true } } } },
  { type: 'model/selection', data: { provider: 'zhipu', model: 'glm-5.3', reasoningEffort: 'medium' } },
];

let selectModelCalls = [];
let controllerSelectModel = async (request) => {
  selectModelCalls.push(request);
  return { provider: request.provider, model: request.model };
};

/* Records which routes the catalog had to interrogate for capacity, so the
   "ask only when the list did not say" rule is observable rather than implied. */
const calls = { resolveModelInfo: [] };

const llm = {
  listProviders: async () => [
    { provider: 'workbuddy', name: 'WorkBuddy' },
    { provider: 'zhipu', name: 'Zhipu' },
    { provider: 'broken-info', name: 'Broken' },
    { provider: 'empty-route', name: 'Empty' },
  ],
  listModels: async (provider) => {
    if (provider === 'workbuddy') {
      /* Inline capacity — the shape a well-behaved adapter *wishes* survived
         the core llm layer. Kept to prove the declarative value is not lost. */
      return [
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 128000, inputModalities: ['text', 'image'] },
        { id: 'deepseek-v4.1', name: 'DeepSeek V4.1', contextWindow: 128000 },
      ];
    }
    /* Capacity deliberately absent: this is what the two shipped adapters
       actually return, because core llm rebuilds each entry without it. */
    if (provider === 'zhipu') return [{ id: 'glm-5.3', name: 'GLM 5.3' }];
    if (provider === 'broken-info') return [{ id: 'mystery', name: 'Mystery' }];
    return [];
  },
  resolveModelInfo: async (provider, model) => {
    calls.resolveModelInfo.push(provider + '/' + model);
    /* Both shipped adapters answer this from memory; the mock mirrors the
       wire shape `normalizeModelInfo` produces, context included. */
    if (model === 'mystery') throw new Error('INVALID_MODEL_CONTEXT');
    if (model === 'glm-5.3') {
      return { context: { contextWindow: 200000 }, reasoning: { efforts: ['minimal', 'medium'], defaultEffort: 'medium' } };
    }
    if (model === 'deepseek-v4.1-flash') {
      /* Object shape — the one that used to be dropped. */
      return { context: { contextWindow: 131072 }, reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'high' } };
    }
    /* Bare-string shape. */
    return { reasoning: { efforts: ['minimal', 'medium'], defaultEffort: 'medium' } };
  },
  resolveCallConfig: async (config) => ({ ok: true, config }),
};

const liveAgent = {
  session: {
    snapshotEvents: () => selectionEvents,
    append: async (type, payload) => { liveAgent.appended.push({ type, payload }); },
  },
  appended: [],
};

/* Mutable service registry: tests delete entries to exercise fallbacks, so
   ctx.get must read from live state rather than a fresh literal each call. */
const services = {
  llm,
  agents: { get: (id) => (id === 'session-live' ? liveAgent : undefined) },
  agentDefaultModel: { currentSelection: () => ({ provider: 'zhipu', model: 'glm-5.3', reasoningEffort: 'medium' }) },
  sessionController: { selectModel: (r) => controllerSelectModel(r) },
};

const ctx = {
  get: (key) => services[key],
  effect: (fn) => { const dispose = fn(); return dispose; },
  webServer: {
    register: (route) => { ctx.__route = route; return () => {}; },
  },
  connection: {
    requestRejection: (req) => (req.headers && req.headers['x-test-fence'] === 'deny' ? 403 : undefined),
  },
};

/* The failure diary writes here instead of the owner's real log directory. */
const logDirProbe = await mkdtemp(join(tmpdir(), 'radar-diary-'));
process.env.DSH_PLUGIN_LOG_DIR = logDirProbe;

plugin.apply(ctx, {});
const route = ctx.__route;
if (!route) throw new Error('apply() never registered a route');
console.log('\nroute:', route.kind, route.path);
ok('registers kind=exact at /radar/api', route.kind === 'exact' && route.path === '/radar/api');

/* ── tiny req/res harness ──────────────────────────────────────────────── */
function call({ method = 'POST', body = {}, headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const req = {
    method,
    headers,
    /* readJsonBody() consumes the stream with `for await`, so the stub must be
       async-iterable exactly like a real IncomingMessage. */
    async *[Symbol.asyncIterator]() {
      if (method === 'GET') return;
      if (text.length > 0) yield Buffer.from(text);
    },
  };
  return new Promise((resolve) => {
    let status = 200;
    const res = {
      writeHead: (code) => { status = code; },
      end: (payload) => {
        let parsed;
        try { parsed = JSON.parse(payload); } catch { parsed = payload; }
        resolve({ status, body: parsed });
      },
      setHeader: () => {},
    };
    route.handler(req, res);
  });
}

const fenced = await call({ headers: { 'x-test-fence': 'deny' } });
ok('fence rejects with 403', fenced.status === 403 && fenced.body.error === 'forbidden', JSON.stringify(fenced.body));

const wrongMethod = await call({ method: 'GET' });
ok('non-POST answers 405', wrongMethod.status === 405, 'status ' + wrongMethod.status);

/* ── catalog ───────────────────────────────────────────────────────────── */
const catalog = await call({ body: { command: 'catalog', sessionId: 'session-live' } });
ok('catalog answers 200', catalog.status === 200);
const providers = catalog.body.providers;
console.log('  providers =', providers.map(p => p.provider + '(' + p.models.length + ')').join(', '));
ok('drops the provider with no models', !providers.some(p => p.provider === 'empty-route'));
ok('keeps every stocked provider', providers.length === 3, 'got ' + providers.length);
ok('projects a model name', providers[0].models[0].name === 'DeepSeek V4.1 Flash');
ok('keeps a declarative contextWindow', providers[0].models[0].contextWindow === 128000);
ok('keeps inputModalities', Array.isArray(providers[0].models[0].inputModalities));

/* The regression this suite exists for: `listModels` entries arrive without
   `contextWindow` (core llm rebuilds them), so the panel's "128k ctx" chip was
   blank in the real host while every stub fed the field directly. Capacity must
   come from resolveModelInfo. */
const zhipu = providers.find(p => p.provider === 'zhipu');
console.log('  zhipu model =', JSON.stringify(zhipu.models[0]));
ok('fills contextWindow from resolveModelInfo when the list omits it',
  zhipu.models[0].contextWindow === 200000, JSON.stringify(zhipu.models[0]));
ok('a model whose info lookup throws stays selectable, just without capacity',
  providers.some(p => p.provider === 'broken-info' && p.models[0].id === 'mystery' && !('contextWindow' in p.models[0])),
  JSON.stringify(providers.find(p => p.provider === 'broken-info')));
ok('a declarative contextWindow is not re-fetched',
  !calls.resolveModelInfo.some(r => r.startsWith('workbuddy/')), JSON.stringify(calls.resolveModelInfo));
ok('capacity is looked up once per model, not once per read',
  calls.resolveModelInfo.length === 2, 'got ' + JSON.stringify(calls.resolveModelInfo));

ok('current comes from model/selection', catalog.body.current.provider === 'zhipu' && catalog.body.current.model === 'glm-5.3',
  JSON.stringify(catalog.body.current));
console.log('  recent =', JSON.stringify(catalog.body.recent));
ok('recent is deduped', new Set(catalog.body.recent.map(r => r.provider + '/' + r.model)).size === catalog.body.recent.length);
ok('recent is newest-first', catalog.body.recent[0].provider === 'zhipu' && catalog.body.recent[0].model === 'glm-5.3');
ok('recent skips effort-only duplicates', catalog.body.recent.length === 2, 'got ' + catalog.body.recent.length);

/* No live session → agentDefaultModel fallback. */
const dead = await call({ body: { command: 'catalog', sessionId: 'session-missing' } });
ok('falls back to agentDefaultModel when the session is not live',
  dead.status === 200 && dead.body.current.provider === 'zhipu', JSON.stringify(dead.body.current));

/* ── modelInfo: both effort shapes ─────────────────────────────────────── */
const infoObjects = await call({ body: { command: 'modelInfo', provider: 'workbuddy', model: 'deepseek-v4.1-flash' } });
console.log('  object-shape efforts =', JSON.stringify(infoObjects.body));
ok('normalises {id,name} efforts', infoObjects.body.efforts.length === 2 && infoObjects.body.efforts[0].name === '低');
ok('reports defaultEffort for object shape', infoObjects.body.defaultEffort === 'high');

const infoStrings = await call({ body: { command: 'modelInfo', provider: 'workbuddy', model: 'deepseek-v4.1' } });
console.log('  string-shape efforts =', JSON.stringify(infoStrings.body));
ok('normalises bare-string efforts', infoStrings.body.efforts.length === 2 && infoStrings.body.efforts[0].id === 'minimal');
ok('string shape yields a display name', infoStrings.body.efforts[0].name.length > 0);

const infoUnknown = await call({ body: { command: 'modelInfo', provider: '', model: '' } });
ok('empty route answers 200 with an empty ladder', infoUnknown.status === 200 && infoUnknown.body.efforts.length === 0);

/* ── select ────────────────────────────────────────────────────────────── */
const missing = await call({ body: { command: 'select', sessionId: '', provider: 'zhipu', model: 'glm-5.3' } });
ok('select rejects a blank sessionId with 400', missing.status === 400, JSON.stringify(missing.body));

const notLive = await call({ body: { command: 'select', sessionId: 'ghost', provider: 'zhipu', model: 'glm-5.3' } });
ok('select rejects a non-live session with 409', notLive.status === 409, JSON.stringify(notLive.body));

const picked = await call({ body: { command: 'select', sessionId: 'session-live', provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } });
console.log('  select via =', picked.body.via, '| selection =', JSON.stringify(picked.body.selection));
ok('select prefers sessionController.selectModel', picked.body.via === 'controller');
ok('select forwards reasoningEffort', selectModelCalls.at(-1).reasoningEffort === 'high');
ok('select echoes the new selection', picked.body.selection.model === 'deepseek-v4.1-flash');

/* Controller gone → append path (no @deepseek-ai/dsh-agent here, so expect
   append-only; append+notice is what a real host resolves). */
delete services.sessionController;
const viaAppend = await call({ body: { command: 'select', sessionId: 'session-live', provider: 'zhipu', model: 'glm-5.3' } });
console.log('  fallback via =', viaAppend.body.via, '| appended =', JSON.stringify(liveAgent.appended));
ok('falls back to append when the controller is absent', viaAppend.status === 200 && viaAppend.body.via !== 'controller');
ok('the fallback really appended a model/selection event',
  liveAgent.appended.some(e => e.type === 'model/selection' && e.payload.model === 'glm-5.3'));

const unknown = await call({ body: { command: 'nonsense' } });
ok('unknown command answers 400', unknown.status === 400);

/* ── credits: read-only snapshot, no upstream ──────────────────────────── */
/* Point DSH_HOME at a scratch dir so the test never touches the real
   snapshot the user's refresh writes. */
const scratch = await mkdtemp(join(tmpdir(), 'radar-credits-'));
process.env.DSH_HOME = join(scratch, '.dsh');
const credDir = join(process.env.DSH_HOME, 'credits-expiry');
const credSnap = join(credDir, 'latest.json');

const empty = await call({ body: { command: 'credits' } });
ok('credits answers 200 when there is no snapshot yet', empty.status === 200 && empty.body.ok === true && empty.body.missing === true,
  JSON.stringify(empty.body).slice(0, 120));
ok('a missing snapshot is not an error', empty.body.error === undefined);

const payload = { schema: 'credits-expiry-snapshot/v1', generatedAtMs: 1, windowDays: 15,
  providers: { workbuddy: { accounts: [{ scope: 'cn/x', nickname: 'x', total: 10, expiringSoon: 10, nearestExpiryMs: 2, packages: [] }],
    errors: [], expiringSoon: 10, overdueRemain: 0, nearestExpiryMs: 2 } } };
await mkdir(credDir, { recursive: true });
await writeFile(credSnap, JSON.stringify(payload), 'utf8');

const filled = await call({ body: { command: 'credits', force: true } });
ok('credits returns the snapshot once the file exists',
  filled.body.ok === true && filled.body.missing === false && filled.body.snapshot.providers.workbuddy.expiringSoon === 10,
  JSON.stringify(filled.body.snapshot?.providers?.workbuddy?.expiringSoon));

/* Cache: overwrite the file and re-read without force — must serve the cached copy. */
await writeFile(credSnap, JSON.stringify({ ...payload, generatedAtMs: 999 }), 'utf8');
const cached = await call({ body: { command: 'credits' } });
ok('repeated reads are served from cache, not from disk', cached.body.snapshot?.generatedAtMs === 1, 'got ' + cached.body.snapshot?.generatedAtMs);
const forced = await call({ body: { command: 'credits', force: true } });
ok('force bypasses the cache', forced.body.snapshot?.generatedAtMs === 999, 'got ' + forced.body.snapshot?.generatedAtMs);

const brokePath = join(credDir, 'latest.json');
await writeFile(brokePath, '{ not json', 'utf8');
const broken = await call({ body: { command: 'credits', force: true } });
ok('a corrupt snapshot reports an error instead of throwing', broken.status === 200 && broken.body.ok === false && typeof broken.body.error === 'string',
  JSON.stringify(broken.body.error).slice(0, 80));
await writeFile(brokePath, JSON.stringify(payload), 'utf8');

const noScript = await call({ body: { command: 'creditsRefresh' } });
ok('refresh without a registered script fails with a hint', noScript.body.ok === false && /report\.mjs|报告脚本/.test(noScript.body.error ?? ''),
  JSON.stringify(noScript.body.error).slice(0, 100));

/* A stub writer script stands in for report.mjs: it rewrites the snapshot the
   same way, proving the spawn + invalidate path without touching upstream. */
const stubScript = join(scratch, 'fake-report.mjs');
await writeFile(stubScript, [
  'import { appendFile, writeFile } from "node:fs/promises";',
  'import { dirname, join } from "node:path";',
  'const arg = process.argv.find(a => a.startsWith("--snapshot="));',
  'const snap = arg.slice(11);',
  'const host = process.argv.find(a => a.startsWith("--host="));',
  'await appendFile(join(dirname(snap), "runs.log"), "run " + (host ?? "") + "\\n");',
  'await writeFile(snap, JSON.stringify({ schema: "credits-expiry-snapshot/v1", generatedAtMs: 4242, providers: {} }), "utf8");',
].join('\n'), 'utf8');
await writeFile(join(credDir, 'source.json'), JSON.stringify({ script: stubScript }), 'utf8');

/* The report script reads Qoder credits from the host's own local route, so it
   has to be told this address. The route handler lifts it off the request's
   Host header — assert the whole chain, not just that spawn happened. */
const refreshed = await call({ body: { command: 'creditsRefresh' }, headers: { host: '127.0.0.1:59999' } });
/* Can this host run a child node process at all? A confined sandbox either
   refuses spawn outright or kills the child before main (0xC0000142). Probe it
   directly, so the skip below is a fact about the machine rather than a guess
   scraped out of an error string. */
const childRuns = await new Promise((resolve) => {
  let child;
  try { child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true }); }
  catch { resolve(false); return; }
  child.once('error', () => resolve(false));
  child.once('close', (code) => resolve(code === 0));
});

if (childRuns === false) {
  console.log('  SKIP 3 spawn-dependent assertions — this sandbox cannot run child node processes; the plugin path is exercised by the two assertions below');
  ok('a refused spawn is reported as a readable error, not a crash', refreshed.body.ok === false && typeof refreshed.body.error === 'string',
    JSON.stringify(refreshed.body.error ?? '').slice(0, 110));
  ok('the refusal hands the user a runnable fallback command', /node .*--snapshot=/.test(refreshed.body.manual ?? ''),
    JSON.stringify(refreshed.body.manual ?? '').slice(0, 120));
  ok('the fallback command carries the host address too', /--host="?http:\/\/127\.0\.0\.1:59999/.test(refreshed.body.manual ?? ''),
    JSON.stringify(refreshed.body.manual ?? '').slice(0, 160));
  ok('a refused spawn leaves the old snapshot readable, not empty',
    (await call({ body: { command: 'credits', force: true } })).body.snapshot?.generatedAtMs === 1);
} else {
  ok('refresh runs the script and reports success', refreshed.body.ok === true, JSON.stringify(refreshed.body.error ?? 'ok').slice(0, 120));
  ok('refresh invalidates the read cache (fresh file, not the cached copy)', refreshed.body.snapshot?.generatedAtMs === 4242,
    'got ' + refreshed.body.snapshot?.generatedAtMs);
  const afterRefresh = await call({ body: { command: 'credits' } });
  ok('the next plain read sees the refreshed snapshot', afterRefresh.body.snapshot?.generatedAtMs === 4242,
    'got ' + afterRefresh.body.snapshot?.generatedAtMs);
  /* Read the log before it gets reset by the double-click case below. */
  const firstRun = await readFile(join(credDir, 'runs.log'), 'utf8');
  ok('the spawned script is told which host address to read', firstRun.includes('--host=http://127.0.0.1:59999'),
    JSON.stringify(firstRun.trim()));
  /* Two clicks in the same tick must share one in-flight run: the whole point of
     the guard is that a double press does not mean two upstream rounds. */
  await rm(join(credDir, 'runs.log'), { force: true });
  await Promise.all([call({ body: { command: 'creditsRefresh' } }), call({ body: { command: 'creditsRefresh' } })]);
  const runs = (await readFile(join(credDir, 'runs.log'), 'utf8')).trim().split('\n').length;
  ok('two clicks at once run the script once, not twice', runs === 1, 'ran ' + runs + ' times');
}

/* ── failure diary ─────────────────────────────────────────────────────── */
/* The catalog walk swallows its own seam failures by design (an empty sweep is
 * transient, not "no models"), so the only deterministic throw through the
 * route's catch is the agents lookup it does NOT guard. That is exactly the
 * kind of half-covered seam this diary exists for. */
const diaryFile = join(logDirProbe, 'dsh-model-radar.ndjson');
const readDiary = async () => {
  try { return (await readFile(diaryFile, 'utf8')).split('\n').filter(line => line.trim() !== ''); }
  catch { return []; }
};

const healthyAgents = services.agents;
services.agents = { get() { throw new Error('agents seam exploded'); } };
const failing = await call({ body: { command: 'catalog', sessionId: 'session-live' } });
services.agents = healthyAgents;

ok('diary: the unguarded seam failure is a 500', failing.status === 500, 'status ' + failing.status);
const diaryLines = await readDiary();
ok('diary: a handled failure leaves exactly one line', diaryLines.length === 1, 'lines=' + diaryLines.length);
const entry = diaryLines.length === 1 ? JSON.parse(diaryLines[0]) : {};
ok('diary: the line names the command', entry.command === 'catalog', String(entry.command));
ok('diary: the line carries the failure message', /agents seam exploded/.test(String(entry.message)), String(entry.message));
ok('diary: the line is timestamped', typeof entry.at === 'string' && !Number.isNaN(Date.parse(entry.at)), String(entry.at));

/* A diary that cannot be written must be invisible to the caller. */
const blocked = join(logDirProbe, 'blocked');
await writeFile(blocked, 'not a directory', 'utf8');
process.env.DSH_PLUGIN_LOG_DIR = blocked;
services.agents = { get() { throw new Error('agents seam exploded'); } };
const stillFailing = await call({ body: { command: 'catalog', sessionId: 'session-live' } });
services.agents = healthyAgents;
ok('diary: an unwritable diary does not change the response',
  stillFailing.status === 500 && /agents seam exploded/.test(String(stillFailing.body?.error)),
  'status ' + stillFailing.status + ' error=' + String(stillFailing.body?.error));
process.env.DSH_PLUGIN_LOG_DIR = logDirProbe;

/* Successes must stay out of the diary: a file that records everything is a file
 * nobody opens, which is the same as not writing one. */
const beforeSuccess = (await readDiary()).length;
await call({ body: { command: 'catalog', sessionId: 'session-live' } });
await call({ body: { command: 'credits' } });
const afterSuccess = (await readDiary()).length;
ok('diary: successful requests write nothing', afterSuccess === beforeSuccess,
  beforeSuccess + ' -> ' + afterSuccess);

await rm(logDirProbe, { recursive: true, force: true });

await rm(scratch, { recursive: true, force: true });
delete process.env.DSH_HOME;

console.log('\n' + (failures === 0 ? 'OK — host half verified end to end against stubs.' : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
