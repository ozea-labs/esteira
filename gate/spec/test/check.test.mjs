// AC9 (when the checks apply) and AC11 (archive), end to end through check().
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { archiveState, check, scope } from '../check.mjs';
import { buildLock } from '../lock.mjs';
import { fsTree, loadChange } from '../lib/repo.mjs';
import { ACCEPTANCE_TEST, FAKE_PHPUNIT, OPENSPEC, commit, fakeResults, initRepo, junitXml, listXml, sh, tempDir, validFiles, writeFiles } from './helpers.mjs';

const C = 'openspec/changes/add-demo';
const T = 'App\\Tests\\Acceptance\\AddDemo\\DemoTest';
const flat = (results) => Object.values(results).flat().map((v) => v.code).sort();

function event(labels) {
  const path = join(tempDir(), 'event.json');
  writeFileSync(path, JSON.stringify({ pull_request: { labels: labels.map((name) => ({ name })) } }));
  return path;
}

function fakes() {
  const tests = (status) => [
    { id: `${T}::seesDemo`, scenarios: ['RCV-DEMO-001'], status },
    { id: `${T}::rejects`, scenarios: ['RCV-DEMO-002'], status },
  ];
  const dir = tempDir();
  fakeResults(join(dir, 'red'), listXml(tests('failed')), junitXml(tests('failed')));
  fakeResults(join(dir, 'green'), listXml(tests('passed')), junitXml(tests('passed')));
  process.env.FAKE_PHPUNIT_DIR = dir;
}

/** The whole factory flow in a temporary repository, archive included. */
function factoryRepo({ archive = true } = {}) {
  const { root, base } = initRepo({ 'openspec/config.yaml': 'schema: spec-driven\n', 'openspec/specs/.gitkeep': '', 'openspec/changes/archive/.gitkeep': '' });
  sh(root, 'git', ['checkout', '-q', '-b', 'factory/fp-999']);
  commit(root, 'propose', validFiles());
  writeFiles(root, { 'tests/Acceptance/AddDemo/DemoTest.php': ACCEPTANCE_TEST });
  const { lock } = buildLock(fsTree(root), 'add-demo');
  commit(root, 'lock', { [`${C}/.spec-lock.json`]: `${JSON.stringify(lock, null, 2)}\n` });
  commit(root, 'apply', { 'src/Demo.php': '<?php\n', IMPLEMENTED: '', [`${C}/tasks.md`]: '## 1. Demo\n\n- [x] 1.1 Build the demo\n' });
  if (archive) {
    const r = spawnSync(OPENSPEC, ['archive', 'add-demo', '--yes', '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, OPENSPEC_TELEMETRY: '0' } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).archive.specsUpdated, true);
    commit(root, 'archive');
  }
  return { root, base };
}

test('AC9: two changes in one PR', () => {
  assert.deepEqual(scope({ touched: ['a', 'b'], labels: [] }).map((v) => v.code), ['MULTIPLE_CHANGES']);
});

test('AC9: a factory PR without a change', () => {
  assert.deepEqual(scope({ touched: [], labels: ['fabrica'] }).map((v) => v.code), ['FACTORY_PR_WITHOUT_CHANGE']);
});

test('AC9: a supervised PR without a change passes, and only validate + lint run', () => {
  const { root, base } = initRepo({ 'openspec/config.yaml': 'schema: spec-driven\n', 'openspec/specs/.gitkeep': '' });
  commit(root, 'feature', { 'src/Other.php': '<?php\n' });
  const results = check({ root, base, head: 'HEAD', event: event([]), openspec: OPENSPEC });
  assert.deepEqual(Object.keys(results).sort(), ['openspec-validate', 'spec-lint', 'spec-scope']);
  assert.deepEqual(flat(results), []);
});

test('AC11: archive is non-interactive and the full factory flow passes every check', () => {
  fakes();
  const { root, base } = factoryRepo();
  assert.ok(existsSync(join(root, 'openspec/specs/demo/spec.md')), 'archive writes the living spec');
  assert.match(readFileSync(join(root, 'openspec/specs/demo/spec.md'), 'utf8'), /RCV-DEMO-002/);
  const out = join('build', 'spec', 'conformance.json');
  const results = check({ root, base, head: 'HEAD', event: event(['fabrica']), phpunit: FAKE_PHPUNIT, openspec: OPENSPEC, out });
  assert.deepEqual(flat(results), []);
  const report = JSON.parse(readFileSync(join(root, out), 'utf8'));
  assert.equal(report.ok, true);
  assert.deepEqual(report.examples.map((e) => e.green), [true, true]);
});

test('AC11: all tasks done but not archived', () => {
  fakes();
  const { root, base } = factoryRepo({ archive: false });
  const results = check({ root, base, head: 'HEAD', event: event(['fabrica']), phpunit: FAKE_PHPUNIT, openspec: OPENSPEC });
  assert.deepEqual(flat(results), ['CHANGE_NOT_ARCHIVED']);
});

test('AC11: unfinished change', () => {
  const root = tempDir();
  writeFiles(root, validFiles());
  assert.deepEqual(archiveState(loadChange(fsTree(root), 'add-demo')).map((v) => v.code), ['CHANGE_INCOMPLETE', 'CHANGE_NOT_ARCHIVED']);
});

test('AC11: an archived change with open tasks is still incomplete', () => {
  const root = tempDir();
  const files = validFiles();
  const archived = Object.fromEntries(Object.entries(files).map(([k, v]) => [k.replace('openspec/changes/add-demo/', 'openspec/changes/archive/2026-11-13-add-demo/'), v]));
  writeFiles(root, archived);
  assert.deepEqual(archiveState(loadChange(fsTree(root), 'add-demo')).map((v) => v.code), ['CHANGE_INCOMPLETE']);
});

test('a delivered change needs the PHPUnit run', () => {
  fakes();
  const { root, base } = factoryRepo();
  assert.deepEqual(flat(check({ root, base, head: 'HEAD', event: event([]), openspec: OPENSPEC })), ['CONFORMANCE_NOT_RUN']);
});
