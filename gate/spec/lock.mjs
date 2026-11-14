#!/usr/bin/env node
// Writes openspec/changes/<change>/.spec-lock.json (OPS-67). The acceptance-test
// agent runs this right before the lock commit. Usage:
//   node scripts/spec/lock.mjs <change> [--root .] [--include docs/adr/0018-x.md]...

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANGES_DIR, LOCK_FILE, acceptanceDirFor, fsTree, sha256 } from './lib/repo.mjs';
import { UsageError, parseArgs, runCli, violation } from './lib/report.mjs';

/** Files a lock must cover for `change` in `tree`. */
export function lockedFiles(tree, change, include = []) {
  const dir = `${CHANGES_DIR}/${change}`;
  return [
    `${dir}/proposal.md`,
    ...tree.files(`${dir}/specs`),
    ...tree.files(acceptanceDirFor(change)),
    ...include,
  ].filter((f, i, all) => all.indexOf(f) === i);
}

export function buildLock(tree, change, include = []) {
  const files = {};
  const missing = [];
  for (const f of lockedFiles(tree, change, include)) {
    const content = tree.read(f);
    if (content === null) missing.push(f);
    else files[f] = sha256(content);
  }
  return { lock: { version: 1, change, files }, missing };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli('spec-lock', (argv) => {
    const args = parseArgs(argv, { root: { default: '.' }, include: { multiple: true } });
    const [change] = args._;
    if (!change) throw new UsageError('usage: lock.mjs <change> [--include <path>]...');
    const tree = fsTree(args.root);
    const { lock, missing } = buildLock(tree, change, args.include);
    const problems = missing.map((f) => violation('LOCK_FILE_MISSING', `${f} does not exist`, f));
    if (!Object.keys(lock.files).some((f) => f.startsWith(`${acceptanceDirFor(change)}/`))) {
      problems.push(violation('LOCK_NO_TESTS', `no acceptance tests in ${acceptanceDirFor(change)}/`));
    }
    if (problems.length === 0) {
      writeFileSync(join(args.root, CHANGES_DIR, change, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
      process.stdout.write(`wrote ${CHANGES_DIR}/${change}/${LOCK_FILE} (${Object.keys(lock.files).length} files)\n`);
    } else {
      for (const p of problems) process.stderr.write(`${p.code}: ${p.message}\n`);
    }
    return problems;
  });
}
