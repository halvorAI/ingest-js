// Runs `demo` from the built package and renders its real output as an animated terminal SVG
// (assets/demo.svg), so the README demo never drifts from what the command prints.
// Run: npm run build && node scripts/render-demo.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = execFileSync(process.execPath, [resolve(root, 'dist/bin.js'), 'demo'], { cwd: root })
  .toString()
  .replace(/evt_[0-9A-Z]{26}(?=: Travel)/, 'evt_01KDEMO0000000000000000000')
  .replace(/sha256:[0-9a-f]{12}…/, 'sha256:3645911b116c…')
  .trimEnd()
  .split('\n');
const lines = ['$ npx @halvorai/ingest demo', ...out];
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const lh = 20, top = 52, w = 860, h = top + lines.length * lh + 20;
const cls = (t) =>
  t.startsWith('$') ? 'p' : /^\s*PASS/.test(t) ? 'ok' : /^\s*FAIL|^\s*- |failed$/.test(t) ? 'bad' : /^\d\./.test(t) ? 'hd' : /verified$/.test(t) ? 'v' : 'n';
const rows = lines
  .map((t, i) => `<text class="${cls(t)}" x="20" y="${top + i * lh}" style="animation-delay:${(i * 0.18).toFixed(2)}s">${esc(t)}</text>`)
  .join('\n');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="t">
<title id="t">Output of npx @halvorai/ingest demo: an event signed and verified, a sample evidence pack that passes, and the same pack failing after one byte changes</title>
<style>
text{font:13px 'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre;opacity:0;animation:in .01s forwards}
@keyframes in{to{opacity:1}}
@media (prefers-reduced-motion:reduce){text{animation:none;opacity:1}}
.n,.v{fill:#F3EFE6}.p{fill:#A39E91}.hd{fill:#F3EFE6;font-weight:700}.ok,.v{fill:#C6F432}.bad{fill:#F0624D}
</style>
<rect width="${w}" height="${h}" rx="10" fill="#1C1C1C"/>
<circle cx="22" cy="20" r="6" fill="#3A3A36"/><circle cx="42" cy="20" r="6" fill="#3A3A36"/><circle cx="62" cy="20" r="6" fill="#3A3A36"/>
${rows}
</svg>
`;
writeFileSync(resolve(root, 'assets/demo.svg'), svg);
console.log(`wrote assets/demo.svg (${lines.length} lines)`);
