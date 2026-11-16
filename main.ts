// Entry driver for the make.fun markdown-render-speed-02 harness.
// It loads every case from cases.json, renders each one with parse(),
// and stores the HTML strings in html.json, in the cases' order.
// The input and output folders come from MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR when set, otherwise the sandbox paths /input
// and /output are used.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8'));
const html = [];
for (let i = 0; i < cases.length; i++) {
  html.push(parse(cases[i].markdown));
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(html));
