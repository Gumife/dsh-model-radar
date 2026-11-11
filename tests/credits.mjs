/**
 * Unit checks for the credits-expiry wording helpers in client.js.
 *
 * Why a dedicated file: verify-client.mjs can only drive the rendered tree,
 * and its credits fixture carries no packages[] — so the one thing that was
 * actually wrong (a window total printed next to a single instant) fell
 * through every existing assertion. These helpers are pure, so slice them out
 * of the factory and evaluate them directly.
 *
 * Usage: node tests/credits.mjs
 */
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const start = src.indexOf('    const DAY_MS = 86400000;');
const end = src.indexOf('    /** How old the snapshot is, in hours');
if (start < 0 || end < 0 || end <= start) throw new Error('could not locate the credits helper block in client.js');

const body = src.slice(start, end);
const { daysUntil, humanUntil, expiringAtInstant, expiringWithin, creditsView, creditsSoonLine, DISPLAY_WINDOW_DAYS } =
  new Function(body + '\nreturn { daysUntil, humanUntil, expiringAtInstant, expiringWithin, creditsView, creditsSoonLine, DISPLAY_WINDOW_DAYS };')();

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (cond) console.log('  ok   ' + label + (extra ? ' — ' + extra : ''));
  else { failures++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); }
};

const H = 3600000;
const D = 86400000;
const NOW = Date.UTC(2026, 10, 10, 8, 54, 57); // the real snapshot instant

console.log('daysUntil rounds DOWN (a warning must not overstate runway):');
ok('30.7h is 1 day, not 2', daysUntil(NOW + 30.71 * H, NOW) === '1', daysUntil(NOW + 30.71 * H, NOW));
ok('27.8h is 1 day', daysUntil(NOW + 27.83 * H, NOW) === '1', daysUntil(NOW + 27.83 * H, NOW));
ok('exactly 3 days is 3 (epsilon absorbs render delay)', daysUntil(NOW + 3 * D, NOW) === '3', daysUntil(NOW + 3 * D, NOW));
/* The 60s epsilon means anything up to a minute short of a boundary still
   reads as that boundary. Deliberate: it absorbs the gap between computing a
   figure and painting it, and erring by <1min on an expiry warning is
   harmless, whereas erring by a whole day is not. */
ok('within the 60s epsilon still says 3', daysUntil(NOW + 3 * D - 30000, NOW) === '3', daysUntil(NOW + 3 * D - 30000, NOW));
ok('past the epsilon drops to 2', daysUntil(NOW + 3 * D - 90000, NOW) === '2', daysUntil(NOW + 3 * D - 90000, NOW));
ok('already expired clamps to 0', daysUntil(NOW - 5 * H, NOW) === '0', daysUntil(NOW - 5 * H, NOW));
ok('NaN yields empty, not "NaN"', daysUntil(NaN, NOW) === '', daysUntil(NaN, NOW));

console.log('\nhumanUntil spells the same instant out:');
/* NOW is the snapshot instant, so the gap is the full 30.71h; by render time
   it has shrunk to ~27.8h and reads "1 天 3 小时". Both spellings come from the
   same branch, so pin the one this NOW produces. */
ok('30.71h reads 1 day 6 hours', humanUntil(NOW + 30.71 * H, NOW) === '1 天 6 小时', humanUntil(NOW + 30.71 * H, NOW));
ok('27.83h reads 1 day 3 hours', humanUntil(NOW + 27.83 * H, NOW) === '1 天 3 小时', humanUntil(NOW + 27.83 * H, NOW));
ok('6h reads 6 hours', humanUntil(NOW + 6 * H, NOW) === '6 小时', humanUntil(NOW + 6 * H, NOW));
ok('exactly 2 days has no dangling 0 小时', humanUntil(NOW + 2 * D, NOW) === '2 天', humanUntil(NOW + 2 * D, NOW));
ok('past instants say 已过期', humanUntil(NOW - H, NOW) === '已过期', humanUntil(NOW - H, NOW));

console.log('\nexpiringAtInstant sums only packages sharing that exact instant:');
const at = NOW + 30.71 * H;
const entry = {
  expiringSoon: 1904.0716,
  nearestExpiryMs: at,
  accounts: [{
    nickname: 'u', expiringSoon: 1904.0716, nearestExpiryMs: at,
    packages: [
      { name: 'a', remain: 404.0716, expiresAtMs: at },
      { name: 'b', remain: 100, expiresAtMs: at },
      { name: 'c', remain: 100, expiresAtMs: at + 7 * 60000 },
      { name: 'd', remain: 100, expiresAtMs: at + 14 * D },
    ],
  }],
};
ok('the instant total is 504.0716, not the 1904 window total',
  Math.abs(expiringAtInstant(entry, at) - 504.0716) < 1e-9, String(expiringAtInstant(entry, at)));
ok('detail present but no package at that instant is a known 0, not null',
  expiringAtInstant(entry, at + 12345) === 0, String(expiringAtInstant(entry, at + 12345)));
ok('no package detail yields null so the caller drops the claim',
  expiringAtInstant({ accounts: [{ packages: [] }] }, at) === null);
ok('a missing accounts array yields null', expiringAtInstant({}, at) === null);
ok('zero/negative remain is not counted as expiring',
  expiringAtInstant({ accounts: [{ packages: [{ remain: 0, expiresAtMs: at }] }] }, at) === 0);

console.log('\nexpiringWithin recomputes the panel\'s own window over package detail:');
ok('the display window is 3 days', DISPLAY_WINDOW_DAYS === 3, String(DISPLAY_WINDOW_DAYS));
ok('only packages inside 3 days count (404.07 + 100 + 100, not the 14-day one)',
  Math.abs(expiringWithin(entry, NOW, 3).soon - 604.0716) < 1e-9,
  String(expiringWithin(entry, NOW, 3).soon));
ok('it reports the nearest of those, not the stored one',
  expiringWithin(entry, NOW, 3).nearest === at, String(expiringWithin(entry, NOW, 3).nearest));
/* The far package sits at NOW+15.28d, so a 15-day cut still excludes it —
   widening the window has to reach past it, which is the point of the check. */
ok('a wider window picks up the far package too',
  Math.abs(expiringWithin(entry, NOW, 20).soon - 704.0716) < 1e-9,
  String(expiringWithin(entry, NOW, 20).soon));
ok('already-expired packages are not counted as expiring',
  expiringWithin({ accounts: [{ packages: [{ remain: 5, expiresAtMs: NOW - H }] }] }, NOW, 3).soon === 0);
/* The distinction that makes the fallback safe: a provider holding accounts
   with no package detail is UNKNOWN, while a provider holding no accounts at
   all is KNOWN to be empty. Collapsing the two would either fabricate a zero
   or resurrect a stale total. */
ok('no package detail yields null so the caller keeps the stored figure',
  expiringWithin({ accounts: [{ packages: [] }] }, NOW, 3) === null);
ok('no accounts at all is a known empty, not unknown',
  JSON.stringify(expiringWithin({ accounts: [] }, NOW, 3)) === '{"soon":0,"nearest":null}',
  JSON.stringify(expiringWithin({ accounts: [] }, NOW, 3)));
ok('a non-object yields null', expiringWithin(null, NOW, 3) === null);

console.log('\ncreditsView headline names the window total AND the first drop:');
const view = creditsView(entry, NOW);
ok('the window is stated as a spread, not a single moment',
  /604 分将在 3 天内陆续过期/.test(view.title), view.title.split('\n')[0]);
ok('the first instant carries its own amount',
  /最早 11-11 23:37（剩 1 天 6 小时）到期 504 分/.test(view.title), view.title.split('\n')[0]);
ok('the old false sentence is gone', !/604 分将在 11-11 23:37/.test(view.title));
ok('the per-account line separates window total from instant amount',
  /窗口内 604 分，最早 11-11 23:37 到期 504 分/.test(view.title),
  (view.title.split('\n')[1] || '(no second line)'));
ok('the badge uses the floored day count', view.label === '604·1d', view.label);
/* The whole point of recomputing: a snapshot written against a 15-day window
   must not leak its wider total into a 3-day view. */
const stale = { expiringSoon: 1904.0716, nearestExpiryMs: at, accounts: entry.accounts, errors: [] };
ok('a 15-day snapshot is re-cut to 3 days, not trusted',
  /604 分将在 3 天内陆续过期/.test(creditsView(stale, NOW).title),
  creditsView(stale, NOW).title.split('\n')[0]);
/* A row whose only balance expires beyond the window must not appear at all:
   naming 100 分 under a "3 天内" heading is the same overstatement, one level
   down. */
const farOnly = {
  expiringSoon: 100,
  accounts: [{ nickname: 'far', expiringSoon: 100, nearestExpiryMs: NOW + 14 * D, packages: [{ remain: 100, expiresAtMs: NOW + 14 * D }] }],
  errors: [],
};
ok('a row expiring beyond the window is dropped, not restated',
  !/far/.test((creditsView(farOnly, NOW) || { title: '' }).title),
  JSON.stringify(creditsView(farOnly, NOW)));
/* Read failures survive the window filter — they are not about expiry. */
const failedOnly = { expiringSoon: 0, overdueRemain: 0, accounts: [], errors: [{ scope: 'x', nickname: 'gone', error: '401' }] };
ok('read failures still produce a badge when nothing expires',
  (creditsView(failedOnly, NOW) || {}).label === '?1', (creditsView(failedOnly, NOW) || {}).label);

console.log('\nfallback when the snapshot has no package detail:');
/* accounts[] present but every packages[] empty = the shape an older snapshot
   has when upstream returned no per-package detail. */
const bare = { expiringSoon: 500, nearestExpiryMs: at, accounts: [{ packages: [] }], errors: [] };
const bareView = creditsView(bare, NOW);
ok('the stored total survives when detail is unknown', bareView.soon === 500, String(bareView.soon));
ok('no invented amount next to the instant', !/到期 \d/.test(bareView.title), bareView.title);
ok('the instant and the runway are still named',
  /最早 11-11 23:37（剩 1 天 6 小时）/.test(bareView.title), bareView.title);
ok('windowDays=0 degrades to plain 将陆续过期',
  /500 分将陆续过期/.test(creditsSoonLine(bare, 500, at, NOW, 0)), creditsSoonLine(bare, 500, at, NOW, 0));
ok('nearest=null states the total with no fake time',
  creditsSoonLine(bare, 500, null, NOW, 3) === '500 分将在 3 天内陆续过期',
  creditsSoonLine(bare, 500, null, NOW, 3));

console.log('\nnothing to say yields null (no empty badge):');
ok('a clean channel returns null',
  creditsView({ expiringSoon: 0, overdueRemain: 0, errors: [] }, NOW) === null);
ok('a missing entry returns null', creditsView(null, NOW) === null);

/* The snapshot is an external file — older script, hand edit, half a write.
   A malformed shape must degrade the badge, never throw: a throw inside render
   takes the whole panel down, which is far worse than a missing number. */
console.log('\nmalformed snapshots degrade instead of throwing:');
const hostile = [
  ['accounts is not an array', { expiringSoon: 5, accounts: 'x' }],
  ['an accounts element is null', { expiringSoon: 5, accounts: [null] }],
  ['an accounts element is a string', { expiringSoon: 5, accounts: ['x'] }],
  ['errors is not an array', { errors: 'x', expiringSoon: 0 }],
  ['an errors element is null', { errors: [null], expiringSoon: 0 }],
  ['an errors element is a number', { errors: [5], expiringSoon: 0 }],
  ['a packages element is null', { expiringSoon: 5, nearestExpiryMs: NOW + H, accounts: [{ packages: [null], expiringSoon: 5, nearestExpiryMs: NOW + H }] }],
  ['expiringSoon is NaN', { expiringSoon: NaN }],
  ['every field is missing', {}],
];
for (const [label, entry] of hostile) {
  let threw = null;
  let view;
  try { view = creditsView(entry, NOW); } catch (error) { threw = error; }
  ok(label + ' does not throw', threw === null, threw === null ? 'view=' + (view === null ? 'null' : JSON.stringify(view.label)) : threw.message);
}

console.log('\n' + (failures === 0
  ? 'OK — expiry copy states the window total as a spread, names the true amount at the first instant, and never rounds runway up.'
  : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
