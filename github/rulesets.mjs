#!/usr/bin/env node
// Ajudante JSON do apply-rulesets.sh e do liberar-portao.sh (sem depender de jq).
//   render <ruleset.json> <protected-paths.txt> [enforcement]   imprime o corpo da API
//   same <desejado.json> <atual.json>                           sai com 0 se o atual já contém o desejado
//   diff <desejado.json> <atual.json>                           imprime as diferenças
import { readFileSync } from 'node:fs';
import { loadPatterns } from '../gate/checks/gate-integrity.mjs';

const KEYS = ['name', 'target', 'enforcement', 'bypass_actors', 'conditions', 'rules'];

export function render(file, pathsFile, enforcement) {
  const ruleset = JSON.parse(readFileSync(file, 'utf8'));
  const paths = loadPatterns(pathsFile);
  const walk = (x) => {
    if (x === '@protected-paths') return paths;
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)]));
    return x;
  };
  const out = walk(ruleset);
  if (enforcement) out.enforcement = enforcement;
  return out;
}

/**
 * O GitHub devolve campos com valor padrão que o JSON versionado não declara. O atual "contém" o desejado
 * quando todo campo declarado tem o mesmo valor; listas precisam ter o mesmo tamanho e a mesma ordem.
 * Exceção: bypass_actors é comparado por inteiro, porque um bypass a mais é exatamente o que importa.
 */
export function differences(desired, current, path = '') {
  const out = [];
  if (path === '.bypass_actors') {
    const norm = (l) => JSON.stringify((l ?? []).map((a) => [a.actor_id ?? null, a.actor_type, a.bypass_mode]).sort());
    if (norm(desired) !== norm(current)) out.push(`${path}: ${norm(current)} → ${norm(desired)}`);
    return out;
  }
  if (Array.isArray(desired)) {
    if (!Array.isArray(current) || current.length !== desired.length) {
      out.push(`${path}: ${JSON.stringify(current)} → ${JSON.stringify(desired)}`);
      return out;
    }
    desired.forEach((d, i) => out.push(...differences(d, current[i], `${path}[${i}]`)));
    return out;
  }
  if (desired && typeof desired === 'object') {
    if (!current || typeof current !== 'object') return [`${path}: ${JSON.stringify(current)} → ${JSON.stringify(desired)}`];
    for (const k of Object.keys(desired)) out.push(...differences(desired[k], current[k], `${path}.${k}`));
    return out;
  }
  if (desired !== current) out.push(`${path}: ${JSON.stringify(current)} → ${JSON.stringify(desired)}`);
  return out;
}

function pick(obj) {
  return Object.fromEntries(KEYS.filter((k) => k in obj).map((k) => [k, obj[k]]));
}

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === 'render') {
  process.stdout.write(`${JSON.stringify(render(a, b, c), null, 2)}\n`);
} else if (cmd === 'same' || cmd === 'diff') {
  const desired = pick(JSON.parse(readFileSync(a, 'utf8')));
  const current = JSON.parse(readFileSync(b, 'utf8'));
  const diffs = differences(desired, current);
  if (cmd === 'diff') for (const d of diffs) console.log(`  ${d}`);
  process.exitCode = diffs.length === 0 ? 0 : 1;
} else if (cmd) {
  console.error(`rulesets.mjs: comando desconhecido ${cmd}`);
  process.exitCode = 2;
}
