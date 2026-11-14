#!/usr/bin/env node
// Entry point of the `spec` CI job (OPS-67, AC9-AC11). Usage:
//   node scripts/spec/check.mjs --base <rev> [--head HEAD] [--root .]
//        [--event $GITHUB_EVENT_PATH] [--phpunit "<cmd>"] [--prepare "<cmd>"]
//        [--openspec bin/openspec]
// --prepare runs inside the lock-commit worktree before PHPUnit (CI: composer install).
//
// Always: `openspec validate --all --strict` and the Ozea lint.
// When the PR touches a change: exactly one change, archived, integrity
// (with the red-at-lock run when --phpunit is given) and conformance.
// A PR labelled `fabrica` must touch exactly one change.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { conformance } from './conformance.mjs';
import { integrity, redAtLock } from './integrity.mjs';
import { lint } from './lint.mjs';
import { runAcceptance } from './lib/phpunit.mjs';
import { acceptanceDirFor, activeChangeNames, changeOfPath, fsTree, git, loadChange } from './lib/repo.mjs';
import { UsageError, parseArgs, printViolations, runCli, violation } from './lib/report.mjs';

export const FACTORY_LABEL = 'fabrica';

export function touchedChanges(root, base, head) {
  const files = git(root, ['diff', '--name-only', `${base}...${head}`]).split('\n').filter(Boolean);
  return [...new Set(files.map(changeOfPath).filter(Boolean))].sort();
}

export function prLabels(eventPath) {
  if (!eventPath) return [];
  try {
    const event = JSON.parse(readFileSync(eventPath, 'utf8'));
    return (event.pull_request?.labels ?? []).map((l) => l.name);
  } catch {
    return [];
  }
}

/** Scope rules: which change (if any) the PR delivers. */
export function scope({ touched, labels }) {
  const out = [];
  if (touched.length > 1) out.push(violation('MULTIPLE_CHANGES', `the PR touches ${touched.length} OpenSpec changes (${touched.join(', ')}); deliver one per PR`));
  if (labels.includes(FACTORY_LABEL) && touched.length === 0) out.push(violation('FACTORY_PR_WITHOUT_CHANGE', `a PR labelled "${FACTORY_LABEL}" must contain one OpenSpec change`));
  return out;
}

/** The delivered change must be complete and archived by the end of the PR. */
export function archiveState(change) {
  const out = [];
  if (change.tasks.total === 0 || change.tasks.done < change.tasks.total) {
    out.push(violation('CHANGE_INCOMPLETE', `${change.name} has ${change.tasks.done}/${change.tasks.total} tasks done`, `${change.dir}/tasks.md`));
  }
  if (!change.archived) {
    out.push(violation('CHANGE_NOT_ARCHIVED', `${change.name} is not archived; run make spec-archive CHANGE=${change.name} as the last commit`, `${change.dir}/tasks.md`));
  }
  return out;
}

function validateStrict(root, openspec) {
  const r = spawnSync(openspec, ['validate', '--all', '--strict', '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, OPENSPEC_TELEMETRY: '0' } });
  if (r.error || r.status === null) throw new Error(`cannot run ${openspec}: ${r.error?.message ?? 'killed'}`);
  if (r.status === 0) return [];
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    throw new Error(`openspec validate exited ${r.status} without JSON: ${r.stderr.trim()}`);
  }
  return (report.items ?? [])
    .filter((i) => !i.valid)
    .flatMap((i) => i.issues.map((x) => violation('OPENSPEC_INVALID', `${i.type} ${i.id}: ${x.path ? `${x.path}: ` : ''}${x.message}`)));
}

export function check({ root = '.', base, head = 'HEAD', event = null, phpunit = null, prepare = null, openspec = 'bin/openspec', out = 'build/spec/conformance.json' }) {
  const results = {};
  results['openspec-validate'] = validateStrict(root, openspec);

  const touched = touchedChanges(root, base, head);
  const tree = fsTree(root);
  // Active changes plus the change this PR archived: an archived change is no
  // longer listed as active, but its proposal and delta must still pass.
  const archivedTouched = touched.filter((name) => loadChange(tree, name)?.archived);
  results['spec-lint'] = lint({ root, tree, changes: [...activeChangeNames(tree), ...archivedTouched] });
  results['spec-scope'] = scope({ touched, labels: prLabels(event) });

  if (touched.length !== 1) {
    if (touched.length === 0) process.stdout.write('spec-check: no OpenSpec change in this PR; integrity and conformance do not apply.\n');
    return results;
  }

  const [name] = touched;
  const change = loadChange(tree, name);
  if (!change) {
    results['spec-scope'].push(violation('CHANGE_REMOVED', `the PR deletes change ${name}`));
    return results;
  }
  results['spec-archive'] = archiveState(change);

  const { lockCommit, violations } = integrity({ root, base, head, change: name });
  results['spec-integrity'] = violations;
  if (phpunit && lockCommit) results['spec-integrity'].push(...redAtLock({ root, lockCommit, change: name, phpunit, prepare }));

  if (phpunit) {
    const { tests } = runAcceptance({ cwd: root, phpunit, dir: acceptanceDirFor(name) });
    const conf = conformance({ change, tests });
    results['spec-conformance'] = conf.violations;
    const outPath = join(root, out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(conf.report, null, 2)}\n`);
  } else {
    results['spec-conformance'] = [violation('CONFORMANCE_NOT_RUN', 'a change is delivered but --phpunit was not given')];
  }
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli('spec-check', (argv) => {
    const args = parseArgs(argv, {
      root: { default: '.' }, base: {}, head: { default: 'HEAD' }, event: { default: process.env.GITHUB_EVENT_PATH ?? null },
      phpunit: {}, prepare: {}, openspec: { default: 'bin/openspec' }, out: { default: 'build/spec/conformance.json' },
    });
    if (!args.base) throw new UsageError('--base is required');
    const results = check(args);
    const all = [];
    for (const [name, violations] of Object.entries(results)) {
      printViolations(name, violations);
      all.push(...violations);
    }
    return all;
  });
}
