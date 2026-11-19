#!/usr/bin/env node
// Jev router: picks a model tier and relevant skills for each prompt via TypeSafe's Jev model.
// Usage:  node jev.mjs hook            (UserPromptSubmit hook; reads hook JSON on stdin)
//         node jev.mjs on|off|status|refresh|log
// Key: set TYPESAFE_API_KEY in your environment (never stored in files).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const DIR = path.join(HOME, '.claude', 'jev');
const FLAG = path.join(DIR, 'enabled');
const CATALOG = path.join(DIR, 'catalog.json');
const LOG = path.join(DIR, 'log.jsonl');
// The flag file holds "on" or "off" (the desktop toggle mod can write but not delete files).
const isOn = () => { try { return fs.readFileSync(FLAG, 'utf8').trim() === 'on'; } catch { return false; } };
const URL_ = 'https://api.typesafe.ai/v1/systemone';
const MAX_SKILLS = 250; // Choice supports up to 255 options
const SKILL_THRESHOLD = 0.25;
const TIMEOUT_MS = 4000;

const TIERS = {
  haiku: 'Simple, mechanical or lookup work: find a file, read or reformat text, check a signature, short factual answers, trivial one-line edits.',
  sonnet: 'Typical everyday engineering: implement a well-specified feature, fix a clear bug, write tests, modest refactors, summarise or explain code.',
  opus: 'Hard work: ambiguous or architectural design, deep debugging across many files, security-sensitive changes, large refactors, subtle reasoning, long multi-step planning.',
};

// ---------- catalog ----------
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(name|description):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v)) {
      const buf = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) buf.push(lines[++i].trim());
      v = buf.join(' ');
    }
    out[kv[1]] = v.replace(/^["']|["']$/g, '');
  }
  return out.name ? out : null;
}

function walkSkills(root, depth, found) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory() && depth > 0) walkSkills(p, depth - 1, found);
    else if (e.isFile() && e.name === 'SKILL.md') found.push(p);
  }
}

function buildCatalog() {
  const files = [];
  walkSkills(path.join(HOME, '.claude', 'skills'), 2, files);
  walkSkills(path.join(HOME, '.claude', 'plugins', 'cache'), 6, files);
  const seen = new Map();
  for (const f of files) {
    let fm;
    try { fm = parseFrontmatter(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (!fm || seen.has(fm.name)) continue;
    seen.set(fm.name, (fm.description || fm.name).slice(0, 220));
  }
  const skills = [...seen].slice(0, MAX_SKILLS).map(([name, description]) => ({ name, description }));
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CATALOG, JSON.stringify({ built: new Date().toISOString(), skills }, null, 1));
  return skills;
}

function loadCatalog() {
  try { return JSON.parse(fs.readFileSync(CATALOG, 'utf8')).skills; } catch { return buildCatalog(); }
}

// ---------- Jev call ----------
async function askJev(prompt, skills) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return { error: 'TYPESAFE_API_KEY not set' };
  const skillCriteria = { none: 'No listed skill is clearly needed for this request.' };
  for (const s of skills) skillCriteria[s.name] = s.description;
  const body = {
    state: prompt.slice(0, 6000),
    model: 'jev-latest',
    questions: {
      tier: {
        type: 'choice',
        instructions: 'The state is a request a user sent to a coding assistant. Which model tier is the cheapest one that can handle this request well?',
        criteria: TIERS,
      },
      skill: {
        type: 'choice',
        instructions: 'The state is a request a user sent to a coding assistant. Which one skill, if any, would be most useful to load for this request?',
        criteria: skillCriteria,
      },
    },
  };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (e) {
    return { error: String(e.name === 'AbortError' ? 'timeout' : e.message) };
  } finally { clearTimeout(t); }
}

// ---------- hook ----------
async function hook() {
  if (!isOn()) return;
  let input = '';
  for await (const c of process.stdin) input += c;
  let prompt = '';
  try { prompt = JSON.parse(input).prompt || ''; } catch { return; }
  prompt = prompt.trim();
  if (prompt.length < 4 || prompt.startsWith('/jev')) return;

  const t0 = Date.now();
  const skills = loadCatalog();
  const r = await askJev(prompt, skills);
  const ms = Date.now() - t0;
  if (r.error) {
    try { fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), error: r.error, ms }) + '\n'); } catch {}
    return; // fail open: never block the user's prompt
  }
  const a = r.data.answers;
  const tier = a.tier.choice;
  const tierConf = a.tier.confidence;
  const picks = Object.entries(a.skill.probabilities)
    .filter(([n, p]) => n !== 'none' && p >= SKILL_THRESHOLD)
    .sort((x, y) => y[1] - x[1]).slice(0, 3).map(([n]) => n);

  try {
    fs.appendFileSync(LOG, JSON.stringify({
      ts: new Date().toISOString(), ms, tier, tierConf, picks,
      usage: r.data.usage, promptChars: prompt.length, prompt: prompt.replace(/\s+/g, ' ').slice(0, 60),
    }) + '\n');
  } catch {}

  const lines = [`[Jev router] Cheapest adequate model tier for this prompt: ${tier} (confidence ${tierConf.toFixed(2)}).`];
  if (tier !== 'opus' && tierConf >= 0.6) {
    lines.push(`If the current session model is more expensive than ${tier} and the work is separable, delegate the execution to a subagent with model "${tier}" instead of doing it directly; otherwise proceed normally.`);
  } else {
    lines.push('Do the work directly on the current model.');
  }
  if (picks.length) lines.push(`Skills Jev judged relevant (load via the Skill tool only if they fit): ${picks.join(', ')}.`);
  else lines.push('Jev found no clearly relevant skill; do not load one speculatively.');
  lines.push('This is advisory; your own judgment overrides it.');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: lines.join('\n') },
  }));
}

// ---------- commands ----------
const cmd = process.argv[2] || 'status';
if (cmd === 'hook') await hook();
else if (cmd === 'on') {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FLAG, 'on');
  const n = buildCatalog().length;
  console.log(`Jev router ON. Catalog: ${n} skills.` + (process.env.TYPESAFE_API_KEY ? '' : ' WARNING: TYPESAFE_API_KEY is not set in this environment, so the hook will do nothing.'));
} else if (cmd === 'off') {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FLAG, 'off');
  console.log('Jev router OFF. Claude Code behaves as normal.');
} else if (cmd === 'refresh') console.log(`Catalog rebuilt: ${buildCatalog().length} skills.`);
else if (cmd === 'log') {
  let rows = [];
  try { rows = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse); } catch {}
  const ok = rows.filter(r => r.tier);
  const by = {}; ok.forEach(r => by[r.tier] = (by[r.tier] || 0) + 1);
  const avg = ok.length ? Math.round(ok.reduce((s, r) => s + r.ms, 0) / ok.length) : 0;
  const inTok = ok.reduce((s, r) => s + (r.usage?.input_tokens || 0), 0);
  console.log(`calls: ${ok.length}, errors: ${rows.length - ok.length}, avg latency: ${avg}ms, jev input tokens: ${inTok}\ntier mix: ${JSON.stringify(by)}`);
  rows.slice(-5).forEach(r => console.log(JSON.stringify(r)));
} else {
  console.log(`Jev router: ${isOn() ? 'ON' : 'OFF'}; key ${process.env.TYPESAFE_API_KEY ? 'set' : 'NOT set'}; catalog ${fs.existsSync(CATALOG) ? loadCatalog().length + ' skills' : 'not built'}`);
}
