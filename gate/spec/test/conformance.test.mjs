// AC8: spec-conformance and the PHPUnit 13 output formats.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { conformance } from '../conformance.mjs';
import { joinResults, parseJunit, parseListTests } from '../lib/phpunit.mjs';
import { fsTree, loadChange } from '../lib/repo.mjs';
import { FIXTURES, tempDir, validFiles, writeFiles } from './helpers.mjs';

const T = 'App\\Tests\\Acceptance\\AddDemo\\DemoTest';
function change() {
  const root = tempDir();
  writeFiles(root, validFiles());
  return loadChange(fsTree(root), 'add-demo');
}
const codes = (r) => r.violations.map((v) => v.code).sort();

test('real PHPUnit 13 output: groups, data providers and statuses', () => {
  const list = readFileSync(join(FIXTURES, 'phpunit13-list-tests.xml'), 'utf8');
  const junit = readFileSync(join(FIXTURES, 'phpunit13-junit.xml'), 'utf8');
  const P = 'App\\Tests\\Acceptance\\Probe\\ProbeTest';
  assert.deepEqual([...parseListTests(list).groups.get(`${P}::provided`)], ['RCV-DEMO-004']);
  const status = parseJunit(junit);
  assert.equal(status.get(`${P}::passes`), 'passed');
  assert.equal(status.get(`${P}::fails`), 'failed');
  assert.equal(status.get(`${P}::skips`), 'skipped');
  assert.equal(status.get(`${P}::provided`), 'failed', 'one failing data set fails the method');
  const joined = Object.fromEntries(joinResults(list, junit).map((t) => [t.id.split('::')[1], t]));
  assert.deepEqual(joined.passes.scenarios, ['RCV-DEMO-001']);
  assert.equal(Object.keys(joined).length, 4);
});

test('every scenario and EX green passes, and the report links EX -> scenarios -> tests', () => {
  const r = conformance({
    change: change(),
    tests: [
      { id: `${T}::seesDemo`, scenarios: ['RCV-DEMO-001'], status: 'passed' },
      { id: `${T}::rejects`, scenarios: ['RCV-DEMO-002'], status: 'passed' },
    ],
  });
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.report.examples, [
    { id: 'EX-1', scenarios: ['RCV-DEMO-001'], green: true },
    { id: 'EX-2', scenarios: ['RCV-DEMO-002'], green: true },
  ]);
  assert.equal(r.report.scenarios[1].securityNegative, true);
  assert.equal(r.report.ok, true);
});

test('a scenario without test', () => {
  const r = conformance({ change: change(), tests: [{ id: `${T}::seesDemo`, scenarios: ['RCV-DEMO-001'], status: 'passed' }] });
  assert.deepEqual(codes(r), ['EX_NOT_COVERED', 'SCENARIO_UNTESTED']);
});

for (const status of ['failed', 'error', 'skipped', 'not-run']) {
  test(`a scenario whose test is ${status}`, () => {
    const r = conformance({
      change: change(),
      tests: [
        { id: `${T}::seesDemo`, scenarios: ['RCV-DEMO-001'], status: 'passed' },
        { id: `${T}::rejects`, scenarios: ['RCV-DEMO-002'], status },
      ],
    });
    assert.deepEqual(codes(r), ['EX_NOT_COVERED', 'SCENARIO_NOT_GREEN']);
  });
}

test('one red test among several fails the scenario', () => {
  const r = conformance({
    change: change(),
    tests: [
      { id: `${T}::seesDemo`, scenarios: ['RCV-DEMO-001'], status: 'passed' },
      { id: `${T}::rejects`, scenarios: ['RCV-DEMO-002'], status: 'passed' },
      { id: `${T}::rejectsToo`, scenarios: ['RCV-DEMO-002'], status: 'failed' },
    ],
  });
  assert.deepEqual(codes(r), ['EX_NOT_COVERED', 'SCENARIO_NOT_GREEN']);
});
