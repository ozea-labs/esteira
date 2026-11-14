// AC1-AC4: the pinned CLI, the Ozea rules reaching the agent, strict validation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXTURES, OPENSPEC, SPEC, SPEC_ROOT, tempDir, validFiles, writeFiles } from './helpers.mjs';

const C = 'openspec/changes/add-demo';
const cli = (cwd, args) => spawnSync(OPENSPEC, args, { cwd, encoding: 'utf8', env: { ...process.env, OPENSPEC_TELEMETRY: '0' } });

test('AC1: package.json pins the exact version and the lock has integrity', () => {
  const pkg = JSON.parse(readFileSync(join(SPEC_ROOT, 'openspec/package.json'), 'utf8'));
  assert.equal(pkg.dependencies['@fission-ai/openspec'], '2.0.0');
  const lock = JSON.parse(readFileSync(join(SPEC_ROOT, 'openspec/package-lock.json'), 'utf8'));
  const entry = lock.packages['node_modules/@fission-ai/openspec'];
  assert.equal(entry.version, '2.0.0');
  assert.match(entry.integrity, /^sha512-/);
  assert.equal(cli(SPEC_ROOT, ['--version']).stdout.trim(), '2.0.0');
});

test('AC3: the Ozea rules reach every artifact instruction, without config warnings', () => {
  const root = tempDir();
  writeFiles(root, validFiles());
  // As regras da Ozea moram no openspec/config.yaml de cada consumidor; aqui, a cópia do Receivables.
  copyFileSync(join(FIXTURES, 'openspec-config.yaml'), join(root, 'openspec/config.yaml'));
  const expected = {
    proposal: [/## Examples/, /EX-n/, /Open questions/],
    specs: [/RCV-<CAPABILITY>-<NNN>/, /\*\*Origin\*\*: EX-n/, /\*\*Security\*\*: negative/],
    design: [/## Security/, /\*\*Applies\*\*: yes/, /baseline/],
    tasks: [/tests\/Acceptance/, /\.spec-lock\.json/],
  };
  for (const [artifact, patterns] of Object.entries(expected)) {
    const r = cli(root, ['instructions', artifact, '--change', 'add-demo', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /ignoring|must be an array/i, `config warning for ${artifact}: ${r.stderr}`);
    const json = JSON.parse(r.stdout);
    const rules = (json.rules ?? []).join('\n');
    for (const p of patterns) assert.match(rules, p, `${artifact} rules miss ${p}`);
    assert.match(json.context, /SHALL\/MUST/);
  }
  const apply = JSON.parse(cli(root, ['instructions', 'apply', '--change', 'add-demo', '--json']).stdout);
  assert.match(apply.operationGuidance.join('\n'), /tests\/Acceptance/);
});

test('AC4: strict validation passes the valid change', () => {
  const root = tempDir();
  writeFiles(root, validFiles());
  assert.equal(cli(root, ['validate', '--all', '--strict']).status, 0);
});

test('AC4: strict validation fails a requirement without scenario', () => {
  const root = tempDir();
  const spec = SPEC.replace(/#### Scenario:[\s\S]*$/, '');
  writeFiles(root, validFiles({ [`${C}/specs/demo/spec.md`]: spec }));
  const r = cli(root, ['validate', '--all', '--strict', '--json']);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).summary.totals.failed, 1);
});

test('spec-config: as regras da configuração do consumidor chegam às instruções', async () => {
  const { configCheck } = await import('../config-check.mjs');
  const root = tempDir();
  writeFiles(root, validFiles());
  copyFileSync(join(FIXTURES, 'openspec-config.yaml'), join(root, 'openspec/config.yaml'));
  assert.deepEqual(configCheck({ root, openspec: OPENSPEC }), []);
});

test('spec-config: falha quando o OpenSpec ignora as regras da configuração', async () => {
  const { configCheck } = await import('../config-check.mjs');
  const root = tempDir();
  writeFiles(root, validFiles({ 'openspec/config.yaml': 'schema: spec-driven\ncontext: |\n  Demo.\nrules:\n  proposal: "deveria ser uma lista"\n' }));
  const codes = configCheck({ root, openspec: OPENSPEC }).map((v) => v.code);
  assert.ok(codes.includes('CONFIG_WARNING') || codes.includes('CONFIG_RULES_DROPPED'), `códigos: ${codes.join(', ')}`);
});
