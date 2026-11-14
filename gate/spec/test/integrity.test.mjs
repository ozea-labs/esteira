// AC7: spec-integrity, one case per letter of the acceptance document.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { integrity, redAtLock } from '../integrity.mjs';
import { buildLock } from '../lock.mjs';
import { fsTree } from '../lib/repo.mjs';
import { ACCEPTANCE_TEST, FAKE_PHPUNIT, commit, fakeResults, initRepo, junitXml, listXml, sh, tempDir, validFiles, writeFiles } from './helpers.mjs';

const C = 'openspec/changes/add-demo';
const T = 'tests/Acceptance/AddDemo/DemoTest.php';

/** base -> spec commit -> lock commit (red tests) -> implementation commit. */
function lockedRepo() {
  const { root, base } = initRepo({ 'openspec/config.yaml': 'schema: spec-driven\n', 'openspec/changes/archive/.gitkeep': '' });
  commit(root, 'spec', validFiles());
  writeFiles(root, { [T]: ACCEPTANCE_TEST });
  const { lock } = buildLock(fsTree(root), 'add-demo');
  writeFiles(root, { [`${C}/.spec-lock.json`]: `${JSON.stringify(lock, null, 2)}\n` });
  const lockCommit = commit(root, 'lock');
  commit(root, 'implement', { 'src/Demo.php': '<?php\n', IMPLEMENTED: '', [`${C}/tasks.md`]: '## 1. Demo\n\n- [x] 1.1 Build the demo\n' });
  return { root, base, lockCommit };
}
const codes = (r) => r.violations.map((v) => v.code).sort();

test('an untouched lock passes', () => {
  const { root, base, lockCommit } = lockedRepo();
  const r = integrity({ root, base, head: 'HEAD', change: 'add-demo' });
  assert.equal(r.lockCommit, lockCommit);
  assert.deepEqual(r.violations, []);
});

test('(a) a delta spec edited after the lock', () => {
  const { root, base } = lockedRepo();
  writeFiles(root, { [`${C}/specs/demo/spec.md`]: 'tampered\n' });
  commit(root, 'edit spec');
  assert.deepEqual(codes(integrity({ root, base, head: 'HEAD', change: 'add-demo' })), ['LOCKED_HASH_HEAD', 'LOCKED_PATH_CHANGED']);
});

test('(a) a new spec file added after the lock', () => {
  const { root, base } = lockedRepo();
  commit(root, 'extra spec', { [`${C}/specs/extra/spec.md`]: 'more scope\n' });
  assert.deepEqual(codes(integrity({ root, base, head: 'HEAD', change: 'add-demo' })), ['LOCKED_PATH_CHANGED']);
});

test('(b) an acceptance test edited after the lock, then restored', () => {
  const { root, base } = lockedRepo();
  commit(root, 'weaken', { [T]: '<?php // weakened\n' });
  commit(root, 'restore', { [T]: ACCEPTANCE_TEST });
  // Content is back, but history shows the edit.
  assert.deepEqual(codes(integrity({ root, base, head: 'HEAD', change: 'add-demo' })), ['LOCKED_PATH_CHANGED', 'LOCKED_PATH_CHANGED']);
});

test('(c) the lock itself rewritten', () => {
  const { root, base } = lockedRepo();
  commit(root, 'relock', { [`${C}/.spec-lock.json`]: '{"version":1,"change":"add-demo","files":{}}\n' });
  assert.ok(codes(integrity({ root, base, head: 'HEAD', change: 'add-demo' })).includes('LOCKED_PATH_CHANGED'));
});

test('(d) HEAD content differs from the lock (e.g. via a merge commit)', () => {
  const { root, base } = lockedRepo();
  sh(root, 'git', ['checkout', '-q', '-b', 'side', 'HEAD~1']);
  commit(root, 'side edit', { [T]: '<?php // other\n' });
  sh(root, 'git', ['checkout', '-q', '-']);
  try {
    sh(root, 'git', ['merge', '-q', '--no-edit', '-X', 'theirs', 'side']);
  } catch {
    /* conflict-free with -X theirs */
  }
  assert.ok(codes(integrity({ root, base, head: 'HEAD', change: 'add-demo' })).includes('LOCKED_HASH_HEAD'));
});

test('a lock that misses a file, or has no tests', () => {
  const { root, base } = initRepo();
  commit(root, 'spec', validFiles());
  writeFiles(root, { [`${C}/.spec-lock.json`]: '{"version":1,"change":"add-demo","files":{}}\n' });
  commit(root, 'lock');
  const c = codes(integrity({ root, base, head: 'HEAD', change: 'add-demo' }));
  assert.ok(c.includes('LOCK_INCOMPLETE'));
  assert.ok(c.includes('LOCK_NO_TESTS'));
});

test('no lock commit at all', () => {
  const { root, base } = initRepo();
  commit(root, 'spec', validFiles());
  assert.deepEqual(codes(integrity({ root, base, head: 'HEAD', change: 'add-demo' })), ['LOCK_MISSING']);
});

test('(e) acceptance tests already green at the lock commit', () => {
  const { root, lockCommit } = lockedRepo();
  const tests = [
    { id: 'App\\Tests\\Acceptance\\AddDemo\\DemoTest::seesDemo', scenarios: ['RCV-DEMO-001'], status: 'passed' },
    { id: 'App\\Tests\\Acceptance\\AddDemo\\DemoTest::rejects', scenarios: ['RCV-DEMO-002'], status: 'failed' },
  ];
  process.env.FAKE_PHPUNIT_DIR = fakeResults(tempDir(), listXml(tests), junitXml(tests));
  const v = redAtLock({ root, lockCommit, change: 'add-demo', phpunit: FAKE_PHPUNIT });
  assert.deepEqual(v.map((x) => x.code), ['SCENARIO_NOT_RED_AT_LOCK']);
  assert.match(v[0].message, /RCV-DEMO-001/);
});

test('(e) red at the lock commit passes, and the temporary worktree is removed', () => {
  const { root, lockCommit } = lockedRepo();
  const tests = [
    { id: 'App\\Tests\\Acceptance\\AddDemo\\DemoTest::seesDemo', scenarios: ['RCV-DEMO-001'], status: 'error' },
    { id: 'App\\Tests\\Acceptance\\AddDemo\\DemoTest::rejects', scenarios: ['RCV-DEMO-002'], status: 'failed' },
  ];
  process.env.FAKE_PHPUNIT_DIR = fakeResults(tempDir(), listXml(tests), junitXml(tests));
  assert.deepEqual(redAtLock({ root, lockCommit, change: 'add-demo', phpunit: FAKE_PHPUNIT }), []);
  assert.equal(sh(root, 'git', ['worktree', 'list']).trim().split('\n').length, 1);
});

test('(f) the openspec archive move is allowed', () => {
  const { root, base } = lockedRepo();
  sh(root, 'git', ['mv', C, 'openspec/changes/archive/2026-11-13-add-demo']);
  commit(root, 'archive', { 'openspec/specs/demo/spec.md': 'living spec written by archive\n' });
  assert.deepEqual(integrity({ root, base, head: 'HEAD', change: 'add-demo' }).violations, []);
});

test('(f) editing the archived copy is still caught', () => {
  const { root, base } = lockedRepo();
  sh(root, 'git', ['mv', C, 'openspec/changes/archive/2026-11-13-add-demo']);
  commit(root, 'archive');
  writeFileSync(join(root, 'openspec/changes/archive/2026-11-13-add-demo/proposal.md'), 'changed\n');
  commit(root, 'edit archived');
  assert.deepEqual(codes(integrity({ root, base, head: 'HEAD', change: 'add-demo' })), ['LOCKED_HASH_HEAD', 'LOCKED_PATH_CHANGED']);
});

test('(g) tasks.md and design.md stay editable after the lock', () => {
  const { root, base } = lockedRepo();
  commit(root, 'design', { [`${C}/design.md`]: '## Security\n- **Applies**: yes\n- refined\n' });
  assert.deepEqual(integrity({ root, base, head: 'HEAD', change: 'add-demo' }).violations, []);
});

test('(e) skipped or not-run tests at the lock commit do not count as red', () => {
  const { root, lockCommit } = lockedRepo();
  const tests = [
    { id: 'App\\Tests\\Acceptance\\AddDemo\\DemoTest::seesDemo', scenarios: ['RCV-DEMO-001'], status: 'skipped' },
    { id: 'App\\Tests\\Acceptance\\AddDemo\\DemoTest::rejects', scenarios: ['RCV-DEMO-002'], status: 'failed' },
  ];
  process.env.FAKE_PHPUNIT_DIR = fakeResults(tempDir(), listXml(tests), junitXml(tests));
  const v = redAtLock({ root, lockCommit, change: 'add-demo', phpunit: FAKE_PHPUNIT });
  assert.deepEqual(v.map((x) => x.code), ['SCENARIO_NOT_RED_AT_LOCK']);
  assert.match(v[0].message, /RCV-DEMO-001.*skipped/);
});

test('(e) prepare runs inside the lock worktree, also with a relative root', () => {
  const { root, lockCommit } = lockedRepo();
  const tests = [
    { id: 'App\\Tests\\Acceptance\\AddDemo\\DemoTest::seesDemo', scenarios: ['RCV-DEMO-001'], status: 'failed' },
    { id: 'App\\Tests\\Acceptance\\AddDemo\\DemoTest::rejects', scenarios: ['RCV-DEMO-002'], status: 'failed' },
  ];
  process.env.FAKE_PHPUNIT_DIR = fakeResults(tempDir(), listXml(tests), junitXml(tests));
  const mark = join(tempDir(), 'prepared');
  const previous = process.cwd();
  process.chdir(root);
  try {
    const prepare = `node -e "require('fs').writeFileSync('${mark}', process.cwd() + '|' + require('fs').existsSync('IMPLEMENTED'))"`;
    assert.deepEqual(redAtLock({ root: '.', lockCommit, change: 'add-demo', phpunit: FAKE_PHPUNIT, prepare }), []);
  } finally {
    process.chdir(previous);
  }
  const [cwd, implemented] = readFileSync(mark, 'utf8').split('|');
  assert.notEqual(cwd, root, 'prepare must not run in the HEAD checkout');
  assert.equal(implemented, 'false', 'the lock worktree has no implementation');
});

test('(e) a failing prepare is an environment error, not a pass', () => {
  const { root, lockCommit } = lockedRepo();
  assert.throws(() => redAtLock({ root, lockCommit, change: 'add-demo', phpunit: FAKE_PHPUNIT, prepare: 'exit 3' }), /prepare command failed/);
});
