// BinLab build: concatenate src/ modules into one classic script, inline the
// stylesheet, and write dist/index.html (openable straight from file://).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');

// Dependency order matters: later modules call into earlier ones.
const MODULES = ['geometry.js', 'layout.js', 'viewer.js', 'app.js'];

// The modules only ever use two ESM forms, both rewritten to plain script:
//   import { a, b } from './mod.js';  -> dropped (same scope after concat)
//   export function/const/let/class   -> declaration without the keyword
function stripESM(code, file) {
  code = code.replace(/^import[\s\S]*?from\s*['"][^'"]+['"];[^\S\n]*$/gm, '');
  code = code.replace(/^export[ \t]+(?=(?:async[ \t]+)?(?:function|const|let|var|class)\b)/gm, '');
  const leftover = code.match(/^\s*(import|export)\b/m);
  if (leftover) throw new Error(`${file}: unsupported ${leftover[1]} form for this build`);
  return code;
}

const banner = [
  '// BinLab — built from src/ by scripts/build.js. Do not edit directly.',
  '// Module order: ' + MODULES.join(' -> ')
].join('\n');

const bundle = MODULES
  .map((f) => `/* ---- src/${f} ---- */\n${stripESM(src(f), f).trim()}`)
  .join('\n\n');

const script = `<script>\n${banner}\n(function () {\n'use strict';\n${bundle}\n})();\n</script>`;
const style = `<style>\n${src('styles.css').trim()}\n</style>`;

let html = src('index.template.html');
for (const [marker, text] of [['<!-- STYLES -->', style], ['<!-- SCRIPTS -->', script]]) {
  if (!html.includes(marker)) throw new Error(`template is missing the ${marker} marker`);
  html = html.replace(marker, text);
}

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'index.html'), html);
console.log(`dist/index.html written (${(html.length / 1024).toFixed(1)} KB)`);
