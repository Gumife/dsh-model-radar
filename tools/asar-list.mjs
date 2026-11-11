// Minimal asar reader: parse the header, list entries, optionally extract one file.
// Layout: [u32 4][u32 headerPickleSize][u32 jsonLen][json...pad4][file data...]
// Usage:
//   node tools/asar-list.mjs <asar> list <regex>
//   node tools/asar-list.mjs <asar> extract <entryPath> <outFile>
import fs from 'node:fs';

const [asarPath, mode, a, b] = process.argv.slice(2);
const fd = fs.openSync(asarPath, 'r');

const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const pickleSize = head.readUInt32LE(4);   // 8 + pickleSize = file-data start
const jsonLen = head.readUInt32LE(12);     // payload length; JSON begins at byte 16
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
const header = JSON.parse(jsonBuf.toString('utf8'));
const dataStart = 8 + pickleSize;

const files = [];
(function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (child.files) walk(child, p);
    else files.push({ path: p, size: child.size, offset: child.offset });
  }
})(header, '');

if (mode === 'list') {
  const re = new RegExp(a || '.', 'i');
  const hits = files.filter(f => re.test(f.path));
  for (const f of hits) console.log(String(f.size).padStart(9), f.path);
  console.error(`# ${files.length} entries total, ${hits.length} matched`);
} else if (mode === 'extract') {
  const entry = files.find(f => f.path === a);
  if (!entry) { console.error('not found: ' + a); process.exit(1); }
  const buf = Buffer.alloc(entry.size);
  fs.readSync(fd, buf, 0, entry.size, dataStart + Number(entry.offset));
  fs.writeFileSync(b, buf);
  console.log(`wrote ${entry.size} bytes -> ${b}`);
} else {
  console.error('mode must be list|extract');
  process.exit(1);
}
fs.closeSync(fd);
