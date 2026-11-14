#!/usr/bin/env node
// spec-config: as regras do openspec/config.yaml do CONSUMIDOR chegam às instruções do OpenSpec fixado,
// sem aviso de configuração. Substitui, de forma genérica, o teste AC3 que o Receivables rodava contra a
// própria configuração antes da mudança para a esteira (OPS-67 → OPS-89).
//
// Monta uma change de exemplo num diretório temporário com a configuração do consumidor e pede ao OpenSpec as
// instruções de cada artefato. Falha quando o OpenSpec avisa que ignorou a configuração, quando um artefato com
// regras na configuração volta sem regras, ou quando o contexto da configuração não chega.
// Uso: node config-check.mjs [--root .] [--openspec <bin>] [--json]

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError, parseArgs, printViolations, runCli, violation } from './lib/report.mjs';
import { tempDir, validFiles, writeFiles } from './test/helpers.mjs';

export const ARTIFACTS = ['proposal', 'specs', 'design', 'tasks'];
const CONFIG = 'openspec/config.yaml';
const WARNING = /ignoring|must be an array|invalid|unknown key|warn/i;

/** Artefatos com regras na configuração: chaves de dois espaços dentro do bloco `rules:`. */
export function configuredRules(yaml) {
  const out = new Set();
  let inRules = false;
  for (const line of yaml.split('\n')) {
    if (/^rules:\s*$/.test(line)) { inRules = true; continue; }
    if (inRules && /^\S/.test(line)) inRules = false;
    const m = inRules && line.match(/^ {2}([a-z]+):\s*$/);
    if (m) out.add(m[1]);
  }
  return out;
}

export function configCheck({ root = '.', openspec }) {
  // A change de exemplo roda num diretório temporário: um caminho relativo do CLI deixaria de valer lá.
  const bin = isAbsolute(openspec) || !openspec.includes('/') ? openspec : resolve(openspec);
  const configPath = join(root, CONFIG);
  if (!existsSync(configPath)) return [];
  const yaml = readFileSync(configPath, 'utf8');
  const withRules = configuredRules(yaml);
  const hasContext = /^context:/m.test(yaml);
  const work = tempDir('spec-config-');
  const out = [];
  try {
    writeFiles(work, validFiles());
    copyFileSync(configPath, join(work, CONFIG));
    for (const artifact of ARTIFACTS) {
      const r = spawnSync(bin, ['instructions', artifact, '--change', 'add-demo', '--json'], {
        cwd: work, encoding: 'utf8', env: { ...process.env, OPENSPEC_TELEMETRY: '0' },
      });
      if (r.error || r.status !== 0) {
        out.push(violation('CONFIG_INSTRUCTIONS_FAILED', `openspec instructions ${artifact} saiu com ${r.status}: ${(r.stderr || r.error?.message || '').trim()}`, CONFIG));
        continue;
      }
      if (WARNING.test(r.stderr)) {
        out.push(violation('CONFIG_WARNING', `openspec avisou sobre ${CONFIG} em ${artifact}: ${r.stderr.trim()}`, CONFIG));
      }
      let json;
      try { json = JSON.parse(r.stdout); } catch { out.push(violation('CONFIG_INSTRUCTIONS_FAILED', `instructions ${artifact} sem JSON`, CONFIG)); continue; }
      if (withRules.has(artifact) && !(json.rules ?? []).length) {
        out.push(violation('CONFIG_RULES_DROPPED', `${CONFIG} tem regras para ${artifact}, mas elas não chegam às instruções`, CONFIG));
      }
      if (hasContext && !String(json.context ?? '').trim()) {
        out.push(violation('CONFIG_CONTEXT_DROPPED', `${CONFIG} tem context, mas ele não chega às instruções de ${artifact}`, CONFIG));
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli('spec-config', (argv) => {
    const args = parseArgs(argv, { root: { default: '.' }, openspec: {}, json: { flag: true } });
    if (!args.openspec) throw new UsageError('--openspec is required');
    const violations = configCheck(args);
    printViolations('spec-config', violations, { json: args.json });
    return violations;
  });
}
