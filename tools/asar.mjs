/*
 * Minimal ASAR reader (header layout verified 2026-10-20):
 *   u32 @0  = 4
 *   u32 @4  = size of the header pickle (dataStart = 8 + this)
 *   u32 @8  = payload size (json length + padding)
 *   u32 @12 = exact json byte length
 *   json    = bytes [16, 16 + jsonLen)
 *
 * Usage:
 *   node tools/asar.mjs <asar> list <regex>
 *   node tools/asar.mjs <asar> extract <entry/path> <outFile>
 */
import fs from 'node:fs';
import path from 'node:path';

const [, , asarPath, cmd, ...rest] = process.argv;
if (!asarPath || !cmd) {
  console.error('usage: node tools/asar.mjs <asar> list <regex> | extract <entry> <out>');
  process.exit(2);
}

const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const pickleSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
const tree = JSON.parse(jsonBuf.toString('utf8'));
const dataStart = Math.ceil((8 + pickleSize) / 4) * 4;

function walk(node, prefix, out) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (child.files) walk(child, p, out);
    else if (typeof child.offset === 'string') out.push({ path: p, size: child.size, offset: Number(child.offset) });
  }
}

if (cmd === 'list') {
  const re = new RegExp(rest[0] || '.');
  const all = [];
  walk(tree, '', all);
  for (const f of all) if (re.test(f.path)) console.log(f.size + '\t' + f.path);
} else if (cmd === 'extract') {
  const want = rest[0];
  const outFile = rest[1];
  const all = [];
  walk(tree, '', all);
  const hit = all.find(f => f.path === want) || all.find(f => f.path.endsWith('/' + want));
  if (!hit) { console.error('not found: ' + want); process.exit(1); }
  const buf = Buffer.alloc(hit.size);
  fs.readSync(fd, buf, 0, hit.size, dataStart + hit.offset);
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, buf);
  console.log('extracted ' + hit.path + ' -> ' + outFile + ' (' + hit.size + 'B)');
} else {
  console.error('unknown command: ' + cmd);
  process.exit(2);
}
