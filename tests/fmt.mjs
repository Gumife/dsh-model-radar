/**
 * Unit checks for the two pure helpers in client.js: fmtCtx and effortLabel.
 * They live in a template-loaded factory, so slice them out and evaluate them
 * in isolation rather than booting the whole module loader.
 *
 * Usage: node tests/fmt.mjs
 */
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const start = src.indexOf('    const EFFORT_KEYS');
const end = src.indexOf('    async function api');
if (start < 0 || end < 0 || end <= start) throw new Error('could not locate the helper block in client.js');

const body = src.slice(start, end);
const { fmtCtx, effortLabel } = new Function(body + '\nreturn { fmtCtx, effortLabel };')();

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (cond) console.log('  ok   ' + label + (extra ? ' — ' + extra : ''));
  else { failures++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); }
};

console.log('fmtCtx:');
const cases = [
  [0, ''], [undefined, ''], [-5, ''], [NaN, ''],
  [1000, '1k'], [32000, '32k'], [128000, '128k'], [200000, '200k'],
  [999499, '999k'], [999999, '1M'], [1000000, '1M'],
  [1048576, '1M'], [1500000, '1.5M'], [2000000, '2M'],
  [10000000, '10M'], [128000000, '128M'],
];
for (const [input, want] of cases) {
  const got = fmtCtx(input);
  ok('fmtCtx(' + String(input) + ') = ' + JSON.stringify(want), got === want, 'got ' + JSON.stringify(got));
}

console.log('\neffortLabel:');
const zh = { effortMinimal: '最低', effortLow: '低', effortMedium: '中', effortHigh: '高', effortXhigh: '极高' };
const tZh = (k) => (zh[k] !== undefined ? zh[k] : k);
const en = { effortMinimal: 'Minimal', effortLow: 'Low', effortMedium: 'Medium', effortHigh: 'High', effortXhigh: 'Extra high' };
const tEn = (k) => (en[k] !== undefined ? en[k] : k);
/* A namespace bind that has not received the dictionary yet returns the key. */
const tMissing = (k) => k;

ok('zh high', effortLabel(tZh, 'high') === '高');
ok('en high is not Chinese', effortLabel(tEn, 'high') === 'High', effortLabel(tEn, 'high'));
ok('en xhigh', effortLabel(tEn, 'xhigh') === 'Extra high');
ok('unknown id passes through', effortLabel(tEn, 'turbo') === 'turbo');
ok('unknown id prefers the host name', effortLabel(tEn, 'turbo', 'Turbo Mode') === 'Turbo Mode');
ok('host name ignored for a known id', effortLabel(tEn, 'high', '高') === 'High');
ok('missing dictionary falls back to the host name', effortLabel(tMissing, 'high', '高') === '高');
ok('missing dictionary and no host name yields the id', effortLabel(tMissing, 'turbo') === 'turbo');
ok('empty id yields empty string', effortLabel(tEn, '') === '');
ok('non-string id yields empty string', effortLabel(tEn, undefined) === '');

if (failures > 0) { console.log('\nFAILED — ' + failures + ' check(s).'); process.exit(1); }
console.log('\nOK — fmtCtx rounds at the unit boundary; effortLabel never leaks Chinese into an English UI.');
