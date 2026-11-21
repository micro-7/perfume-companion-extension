// Fails the build if something that looks like a Google API key is in the source or the build output.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Old (AIza...) and new (AQ.xxxx...) Google API key formats.
const PATTERN = /AIza[0-9A-Za-z_-]{20,}|\bAQ\.[0-9A-Za-z_-]{30,}/;
const dirs = ['src', 'public', 'dist'];
const hits = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (!/\.(png|ico|jpg|jpeg|woff2?)$/i.test(name) && PATTERN.test(readFileSync(p, 'utf8'))) hits.push(p);
  }
}

for (const d of dirs) if (existsSync(d)) walk(d);
if (hits.length) {
  console.error('Possible API key found in:\n  ' + hits.join('\n  '));
  process.exit(1);
}
console.log('no-secrets check passed');
