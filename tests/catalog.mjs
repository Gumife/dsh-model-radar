/**
 * catalogProviders: proves the two behaviours the panel depends on and that a
 * stub round-trip cannot show by accident —
 *
 *   1. providers are queried CONCURRENTLY (a serial sweep takes N × delay);
 *   2. a second open within the TTL is served from cache, and concurrent opens
 *      coalesce onto one in-flight build.
 *
 * Uses a fresh module instance per case: the cache is module-level state, so
 * importing once and reusing it would measure the first test, not the second.
 *
 * Usage: node tests/catalog.mjs
 */
import { pathToFileURL } from 'node:url';

const INDEX_URL = new URL('../index.js', import.meta.url);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (cond) console.log('  ok   ' + label + (extra ? ' — ' + extra : ''));
  else { failures++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); }
};

/**
 * Boot a fresh plugin instance whose llm costs `delayMs` per listModels call
 * and `infoDelayMs` per resolveModelInfo call, and records how many provider
 * sweeps and capacity lookups actually happened.
 */
async function boot({ providers, delayMs = 0, infoDelayMs = 0, failListProviders = false, failListModels = [], badges = {} }) {
  /* Cache-bust so each case gets its own module-level cache. */
  const mod = await import(INDEX_URL.href + '?case=' + Math.random().toString(36).slice(2));
  const calls = { listProviders: 0, listModels: 0, resolveModelInfo: 0, perProvider: new Map() };

  const llm = {
    listProviders: async () => {
      calls.listProviders++;
      if (failListProviders) throw new Error('provider registry unreachable');
      return providers.map(p => ({ provider: p, name: p.toUpperCase() }));
    },
    listModels: async (provider) => {
      calls.listModels++;
      calls.perProvider.set(provider, (calls.perProvider.get(provider) ?? 0) + 1);
      if (delayMs > 0) await sleep(delayMs);
      if (failListModels.includes(provider)) throw new Error(provider + ' channel exploded');
      /* badge rides on the listModels entry, exactly as llm.types projects it. */
      const badge = badges[provider];
      return [{ id: provider + '-m1', name: provider + ' M1', ...(badge === undefined ? {} : { badge }) }];
    },
    /* Capacity arrives here and nowhere else — the real core llm rebuilds
       listModels entries without `contextWindow`. */
    resolveModelInfo: async (provider, model) => {
      calls.resolveModelInfo++;
      if (infoDelayMs > 0) await sleep(infoDelayMs);
      return { context: { contextWindow: 1000 + calls.resolveModelInfo }, reasoning: {} };
    },
    resolveCallConfig: async (c) => ({ ok: true, config: c }),
  };

  const ctx = {
    get: (key) => ({ llm, agents: { get: () => undefined }, agentDefaultModel: { currentSelection: () => null } })[key],
    effect: (fn) => fn(),
    webServer: { register: (route) => { ctx.__route = route; return () => {}; } },
    connection: { requestRejection: () => undefined },
  };
  mod.apply(ctx, {});

  const request = (body) => new Promise((resolve) => {
    const text = JSON.stringify(body);
    const req = {
      method: 'POST',
      headers: {},
      async *[Symbol.asyncIterator]() { yield Buffer.from(text); },
    };
    let status = 200;
    const res = {
      writeHead: (code) => { status = code; },
      setHeader: () => {},
      end: (payload) => resolve({ status, body: JSON.parse(payload) }),
    };
    ctx.__route.handler(req, res);
  });

  return { request, calls };
}

/* ── 1. concurrency ─────────────────────────────────────────────────────── */
console.log('concurrency:');
{
  const providers = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  const DELAY = 40;
  const { request, calls } = await boot({ providers, delayMs: DELAY });
  const t0 = Date.now();
  const res = await request({ command: 'catalog', sessionId: '' });
  const elapsed = Date.now() - t0;
  const serialFloor = providers.length * DELAY;
  console.log('  6 providers × ' + DELAY + 'ms: ' + elapsed + 'ms (serial floor ' + serialFloor + 'ms)');
  ok('catalog answers 200', res.status === 200);
  ok('all providers present', res.body.providers.length === providers.length);
  ok('one listModels call per provider', calls.listModels === providers.length, 'got ' + calls.listModels);
  ok('the sweep is concurrent, not serial', elapsed < serialFloor * 0.6,
    elapsed + 'ms vs serial ' + serialFloor + 'ms');
}

/* ── 2. cache TTL ───────────────────────────────────────────────────────── */
console.log('\ncache:');
{
  const { request, calls } = await boot({ providers: ['a', 'b'], delayMs: 0 });
  const first = await request({ command: 'catalog', sessionId: '' });
  const afterFirst = { ...calls.perProvider };
  const second = await request({ command: 'catalog', sessionId: '' });
  ok('first read builds the tree', first.body.providers.length === 2);
  ok('second read reuses the cache',
    calls.listModels === 2, 'listModels went ' + JSON.stringify(afterFirst) + ' → ' + calls.listModels);
  ok('both reads return the same providers',
    JSON.stringify(first.body.providers) === JSON.stringify(second.body.providers));
  ok('catalog still resolves current per request (not cached)',
    'current' in second.body && 'recent' in second.body);
}

/* ── 3. in-flight coalescing ────────────────────────────────────────────── */
console.log('\ncoalescing:');
{
  const { request, calls } = await boot({ providers: ['x', 'y'], delayMs: 30 });
  const [r1, r2, r3] = await Promise.all([
    request({ command: 'catalog', sessionId: '' }),
    request({ command: 'catalog', sessionId: '' }),
    request({ command: 'catalog', sessionId: '' }),
  ]);
  ok('three concurrent opens all succeed', r1.status === 200 && r2.status === 200 && r3.status === 200);
  ok('three concurrent opens share one sweep',
    calls.listModels === 2, 'listModels = ' + calls.listModels + ' (expected 2, one per provider)');
  ok('coalesced readers agree', JSON.stringify(r1.body.providers) === JSON.stringify(r3.body.providers));
}

/* ── 4. an empty sweep is not pinned ────────────────────────────────────── */
console.log('\nempty sweep:');
{
  const { request, calls } = await boot({ providers: [], delayMs: 0 });
  const first = await request({ command: 'catalog', sessionId: '' });
  const second = await request({ command: 'catalog', sessionId: '' });
  ok('an empty catalog answers 200', first.status === 200 && first.body.providers.length === 0);
  ok('an empty sweep is retried rather than cached for a TTL',
    calls.listProviders === 2, 'listProviders = ' + calls.listProviders);
  ok('the retry is also empty', second.body.providers.length === 0);
}

/* ── 5. capacity is filled in, concurrently ─────────────────────────────── */
console.log('capacity:');
{
  const providers = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
  const INFO_DELAY = 40;
  const { request, calls } = await boot({ providers, infoDelayMs: INFO_DELAY });
  const t0 = Date.now();
  const res = await request({ command: 'catalog', sessionId: '' });
  const elapsed = Date.now() - t0;
  const serialFloor = providers.length * INFO_DELAY;
  console.log('  6 capacity lookups × ' + INFO_DELAY + 'ms: ' + elapsed + 'ms (serial floor ' + serialFloor + 'ms)');
  ok('every model gains a contextWindow',
    res.body.providers.every(p => typeof p.models[0].contextWindow === 'number'),
    JSON.stringify(res.body.providers.map(p => p.models[0])));
  ok('one lookup per model', calls.resolveModelInfo === providers.length, 'got ' + calls.resolveModelInfo);
  ok('lookups run concurrently, not per provider in series', elapsed < serialFloor * 0.6,
    elapsed + 'ms vs serial ' + serialFloor + 'ms');
}

/* ── 6. a failing lookup must not cost the model ────────────────────────── */
console.log('\ncapacity failure:');
{
  /* Reuse boot(), then break its llm by rebuilding a module instance whose
     resolveModelInfo always rejects: the model must survive without capacity. */
  const mod = await import(INDEX_URL.href + '?case=' + Math.random().toString(36).slice(2));
  const llm = {
    listProviders: async () => [{ provider: 'flaky', name: 'Flaky' }],
    listModels: async () => [{ id: 'flaky-m1', name: 'Flaky M1' }],
    resolveModelInfo: async () => { throw new Error('INVALID_MODEL_CONTEXT'); },
    resolveCallConfig: async (c) => ({ ok: true, config: c }),
  };
  const ctx = {
    get: (key) => ({ llm, agents: { get: () => undefined }, agentDefaultModel: { currentSelection: () => null } })[key],
    effect: (fn) => fn(),
    webServer: { register: (route) => { ctx.__route = route; return () => {}; } },
    connection: { requestRejection: () => undefined },
  };
  mod.apply(ctx, {});
  const body = await new Promise((resolve) => {
    const text = JSON.stringify({ command: 'catalog', sessionId: '' });
    const req = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(text); } };
    const res = { writeHead: () => {}, setHeader: () => {}, end: (p) => resolve(JSON.parse(p)) };
    ctx.__route.handler(req, res);
  });
  ok('a throwing lookup still lists the model', body.providers.length === 1 && body.providers[0].models.length === 1,
    JSON.stringify(body.providers));
  ok('the model simply carries no contextWindow', !('contextWindow' in body.providers[0].models[0]),
    JSON.stringify(body.providers[0].models[0]));
}

/* ── provider failures are visible, not swallowed ───────────────────────── */
/* The host's own selector prints one warning row per failed group. A plugin
   that just drops the group leaves the user looking at a hole with no reason,
   so the failure has to reach the wire with the provider's name on it. */
{
  const { request } = await boot({ providers: ['ok1', 'broken', 'ok2'], failListModels: ['broken'] });
  const res = await request({ command: 'catalog', sessionId: '' });
  console.log('\nfailed provider:');
  ok('the healthy providers still list', res.body.providers.length === 2,
    JSON.stringify(res.body.providers.map(p => p.provider)));
  ok('the failed provider is named on the wire', Array.isArray(res.body.failures) && res.body.failures.length === 1,
    JSON.stringify(res.body.failures));
  ok('the failure carries the provider id', res.body.failures[0].id === 'broken', String(res.body.failures[0]?.id));
  ok('the failure carries a display name', res.body.failures[0].name === 'BROKEN', String(res.body.failures[0]?.name));
  ok('the failure carries the throw message', /channel exploded/.test(String(res.body.failures[0].message)),
    String(res.body.failures[0]?.message));
}

{
  const { request } = await boot({ providers: [], failListProviders: true });
  const res = await request({ command: 'catalog', sessionId: '' });
  console.log('\nfailed provider list:');
  ok('a dead provider list answers 200, not 500', res.status === 200, 'status ' + res.status);
  ok('the list failure still reaches the wire', res.body.failures?.length === 1, JSON.stringify(res.body.failures));
  ok('the list failure is marked with the * sentinel', res.body.failures[0].id === '*', String(res.body.failures[0]?.id));
}

{
  const { request } = await boot({ providers: ['solo'], delayMs: 0 });
  const res = await request({ command: 'catalog', sessionId: '' });
  console.log('\nhealthy catalog:');
  ok('no failures key when everything answers', !('failures' in res.body), JSON.stringify(Object.keys(res.body)));
}

/* ── badge rides through to the wire ────────────────────────────────────── */
/* llm.listModels already ships badge {text, tone}; dropping it made the radar
   the only place a model's status label disappeared. */
{
  const { request } = await boot({
    providers: ['tone'],
    badges: { tone: { text: 'BETA', tone: 'warning' } },
  });
  const res = await request({ command: 'catalog', sessionId: '' });
  const model = res.body.providers[0].models[0];
  console.log('\nbadge:');
  ok('a string badge survives the projection', model.badge?.text === 'BETA', JSON.stringify(model));
  ok('the badge keeps its tone', model.badge?.tone === 'warning', JSON.stringify(model.badge));
}

{
  const { request } = await boot({
    providers: ['nobadge'],
    badges: { nobadge: { text: '', tone: 'warning' } },
  });
  const res = await request({ command: 'catalog', sessionId: '' });
  const model = res.body.providers[0].models[0];
  ok('an empty badge text is dropped, not rendered blank', !('badge' in model), JSON.stringify(model));
}

{
  const { request } = await boot({
    providers: ['objbadge'],
    /* A localised message object needs an i18n resolver this plugin has no way
       to reach; dropping beats rendering "[object Object]". */
    badges: { objbadge: { text: { key: 'model.beta' }, tone: 'info' } },
  });
  const res = await request({ command: 'catalog', sessionId: '' });
  const model = res.body.providers[0].models[0];
  ok('a message-object badge is dropped rather than stringified', !('badge' in model), JSON.stringify(model));
}

console.log('\n' + (failures === 0
  ? 'OK — the catalog sweep is concurrent, cached for a TTL, coalesced, never pins an empty answer, surfaces provider failures by name, carries badges, and fills capacity without losing a model.'
  : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
