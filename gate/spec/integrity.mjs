#!/usr/bin/env node
// spec-integrity (OPS-67, AC7). After the lock commit, the change's proposal,
// delta specs, acceptance tests and the lock itself must not change, except
// for the identical move that `openspec archive` makes. Optionally checks
// that the acceptance tests were red at the lock commit. Usage:
//   node scripts/spec/integrity.mjs --change <name> --base <rev> --head <rev>
//        [--root .] [--phpunit "<cmd>"] [--prepare "<cmd>"] [--json]

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockedFiles } from './lock.mjs';
import { runAcceptance } from './lib/phpunit.mjs';
import { CHANGES_DIR, LOCK_FILE, acceptanceDirFor, deltaScenarios, git, gitTree, loadChange, locateChange, sha256 } from './lib/repo.mjs';
import { UsageError, parseArgs, printViolations, runCli, violation } from './lib/report.mjs';

/** Archived counterpart of an active-change path, or null. */
function archivedPath(path, change) {
  const prefix = `${CHANGES_DIR}/${change}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

function isArchiveMove(from, to, change) {
  const rest = archivedPath(from, change);
  if (rest === null) return false;
  const m = to.match(/^openspec\/changes\/archive\/(\d{4}-\d{2}-\d{2})-(.+?)\/(.+)$/);
  return Boolean(m && m[2] === change && m[3] === rest);
}

/** True when `path` is something the lock protects (active or archived location). */
function protectedPath(path, change, extra) {
  const acceptance = `${acceptanceDirFor(change)}/`;
  if (path.startsWith(acceptance) || extra.has(path)) return true;
  const rel =
    archivedPath(path, change) ??
    (() => {
      const m = path.match(/^openspec\/changes\/archive\/\d{4}-\d{2}-\d{2}-(.+?)\/(.+)$/);
      return m && m[1] === change ? m[2] : null;
    })();
  if (rel === null) return false;
  return rel === 'proposal.md' || rel === LOCK_FILE || rel.startsWith('specs/');
}

export function findLockCommit(root, base, head, change) {
  const out = git(root, ['log', '--reverse', '--diff-filter=A', '--format=%H', `${base}..${head}`, '--', `${CHANGES_DIR}/${change}/${LOCK_FILE}`]);
  return out.split('\n').filter(Boolean)[0] ?? null;
}

export function integrity({ root = '.', base, head, change }) {
  const out = [];
  const lockPath = `${CHANGES_DIR}/${change}/${LOCK_FILE}`;
  const lockCommit = findLockCommit(root, base, head, change);
  if (!lockCommit) {
    return { lockCommit: null, violations: [violation('LOCK_MISSING', `no commit in ${base}..${head} adds ${lockPath}`, lockPath)] };
  }

  const atLock = gitTree(root, lockCommit);
  let lock;
  try {
    lock = JSON.parse(atLock.read(lockPath).toString('utf8'));
  } catch (error) {
    return { lockCommit, violations: [violation('LOCK_INVALID', `cannot parse ${lockPath}: ${error.message}`, lockPath)] };
  }
  const locked = lock.files ?? {};
  const extra = new Set(Object.keys(locked).filter((f) => !protectedPath(f, change, new Set())));

  // 1. The lock covers everything it must, and matches the lock commit.
  for (const f of lockedFiles(atLock, change)) {
    if (!(f in locked)) out.push(violation('LOCK_INCOMPLETE', `${f} exists at the lock commit but is not in the lock`, f));
  }
  if (!Object.keys(locked).some((f) => f.startsWith(`${acceptanceDirFor(change)}/`))) {
    out.push(violation('LOCK_NO_TESTS', `the lock has no file under ${acceptanceDirFor(change)}/`, lockPath));
  }
  for (const [f, hash] of Object.entries(locked)) {
    const content = atLock.read(f);
    if (content === null || sha256(content) !== hash) out.push(violation('LOCK_HASH_MISMATCH', `${f} does not match its hash at the lock commit ${lockCommit.slice(0, 8)}`, f));
  }

  // 2. Nothing protected changes after the lock commit, except the archive move.
  const commits = git(root, ['rev-list', '--reverse', `${lockCommit}..${head}`]).split('\n').filter(Boolean);
  for (const c of commits) {
    const diff = git(root, ['diff-tree', '-r', '-M', '--name-status', '--no-commit-id', c]).split('\n').filter(Boolean);
    for (const line of diff) {
      const [status, from, to] = line.split('\t');
      if (status === 'R100' && isArchiveMove(from, to, change)) continue;
      const touched = [from, to].filter(Boolean).filter((p) => protectedPath(p, change, extra));
      for (const p of touched) {
        out.push(violation('LOCKED_PATH_CHANGED', `commit ${c.slice(0, 8)} changes locked path ${p} (${status})`, p));
      }
    }
  }

  // 3. HEAD still has exactly the locked content (at its active or archived path).
  const atHead = gitTree(root, head);
  const located = locateChange(atHead, change);
  for (const [f, hash] of Object.entries(locked)) {
    const rel = archivedPath(f, change);
    const path = rel !== null && located?.archived ? `${located.dir}/${rel}` : f;
    const content = atHead.read(path);
    if (content === null) out.push(violation('LOCKED_FILE_MISSING', `${path} is locked but missing at HEAD`, path));
    else if (sha256(content) !== hash) out.push(violation('LOCKED_HASH_HEAD', `${path} differs from the lock at HEAD`, path));
  }
  return { lockCommit, violations: out };
}

/**
 * Red-first check: at the lock commit, every scenario of the change has at
 * least one acceptance test that failed or errored (skipped and not-run do
 * not count). The lock commit is checked out in a temporary worktree and
 * `prepare` (e.g. `composer install`) runs there first, so dependencies and
 * the Composer autoloader resolve to the lock commit, never to HEAD.
 */
export function redAtLock({ root = '.', lockCommit, change, phpunit, prepare = null }) {
  const out = [];
  const repo = resolve(root);
  const work = mkdtempSync(join(tmpdir(), 'spec-lock-'));
  try {
    git(repo, ['worktree', 'add', '--detach', work, lockCommit], { stdio: 'ignore' });
    if (prepare) {
      const r = spawnSync(prepare, { cwd: work, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) throw new Error(`prepare command failed at the lock commit (exit ${r.status}): ${`${r.stdout}${r.stderr}`.trim().split('\n').slice(-5).join(' | ')}`);
    }
    const changeAtLock = loadChange(gitTree(repo, lockCommit), change);
    const { tests } = runAcceptance({ cwd: work, phpunit, dir: acceptanceDirFor(change) });
    for (const s of deltaScenarios(changeAtLock).filter((x) => x.id)) {
      const mine = tests.filter((t) => t.scenarios.includes(s.id));
      if (mine.length === 0) out.push(violation('SCENARIO_UNTESTED_AT_LOCK', `${s.id} has no acceptance test at the lock commit`, s.file, s.line));
      else if (!mine.some((t) => t.status === 'failed' || t.status === 'error')) {
        out.push(violation('SCENARIO_NOT_RED_AT_LOCK', `${s.id}: no acceptance test failed before the implementation (${mine.map((t) => t.status).join(', ')})`, s.file, s.line));
      }
    }
  } finally {
    try {
      git(repo, ['worktree', 'remove', '--force', work], { stdio: 'ignore' });
    } catch {
      rmSync(work, { recursive: true, force: true });
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli('spec-integrity', (argv) => {
    const args = parseArgs(argv, {
      root: { default: '.' }, change: {}, base: {}, head: { default: 'HEAD' }, phpunit: {}, prepare: {}, json: { flag: true },
    });
    if (!args.change || !args.base) throw new UsageError('--change and --base are required');
    const { lockCommit, violations } = integrity(args);
    if (lockCommit && args.phpunit) violations.push(...redAtLock({ root: args.root, lockCommit, change: args.change, phpunit: args.phpunit, prepare: args.prepare }));
    printViolations('spec-integrity', violations, { json: args.json });
    return violations;
  });
}
