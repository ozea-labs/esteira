// Reads OpenSpec changes and living specs either from the working tree or
// from a Git revision, through the same small "tree" interface.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseDesign, parseProposal, parseSpec, parseTasks } from './markdown.mjs';

export const CHANGES_DIR = 'openspec/changes';
export const ARCHIVE_DIR = 'openspec/changes/archive';
export const SPECS_DIR = 'openspec/specs';
export const ACCEPTANCE_DIR = 'tests/Acceptance';
export const LOCK_FILE = '.spec-lock.json';
const ARCHIVED_NAME = /^\d{4}-\d{2}-\d{2}-(.+)$/;

export function git(root, args, options = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/** Working-tree reader. Paths are repo-relative with forward slashes. */
export function fsTree(root) {
  const walk = (dir) => {
    const abs = join(root, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return [];
    return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) return walk(p);
      return e.isFile() ? [p] : [];
    });
  };
  return {
    files: (dir) => walk(dir).sort(),
    dirs: (dir) => {
      const abs = join(root, dir);
      if (!existsSync(abs)) return [];
      return readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    },
    read: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path)) : null),
  };
}

/** Reader over a Git revision. */
export function gitTree(root, rev) {
  const lsFiles = (dir) =>
    git(root, ['ls-tree', '-r', '--name-only', rev, '--', `${dir}/`]).split('\n').filter(Boolean);
  return {
    files: (dir) => lsFiles(dir).sort(),
    dirs: (dir) => {
      const prefix = `${dir}/`;
      const names = new Set();
      for (const f of lsFiles(dir)) {
        const rest = f.slice(prefix.length);
        if (rest.includes('/')) names.add(rest.split('/')[0]);
      }
      return [...names].sort();
    },
    read: (path) => {
      try {
        return execFileSync('git', ['show', `${rev}:${path}`], { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        return null;
      }
    },
  };
}

export function pascalCase(changeName) {
  return changeName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
}

export function acceptanceDirFor(changeName) {
  return `${ACCEPTANCE_DIR}/${pascalCase(changeName)}`;
}

/** Name of the change a path belongs to, active or archived, or null. */
export function changeOfPath(path) {
  const archived = path.match(/^openspec\/changes\/archive\/([^/]+)\//);
  if (archived) {
    const m = archived[1].match(ARCHIVED_NAME);
    return m ? m[1] : null;
  }
  const active = path.match(/^openspec\/changes\/([^/]+)\//);
  return active && active[1] !== 'archive' ? active[1] : null;
}

/** Directory of a change in the given tree: active first, then archived. */
export function locateChange(tree, name) {
  if (tree.dirs(CHANGES_DIR).includes(name)) return { dir: `${CHANGES_DIR}/${name}`, archived: false };
  const archived = tree.dirs(ARCHIVE_DIR).filter((d) => d.match(ARCHIVED_NAME)?.[1] === name).sort();
  if (archived.length > 0) return { dir: `${ARCHIVE_DIR}/${archived.at(-1)}`, archived: true };
  return null;
}

export function activeChangeNames(tree) {
  return tree.dirs(CHANGES_DIR).filter((d) => d !== 'archive');
}

const text = (buf) => (buf === null ? null : buf.toString('utf8'));

export function loadChange(tree, name) {
  const located = locateChange(tree, name);
  if (!located) return null;
  const { dir, archived } = located;
  const proposalText = text(tree.read(`${dir}/proposal.md`));
  const designText = text(tree.read(`${dir}/design.md`));
  const tasksText = text(tree.read(`${dir}/tasks.md`));
  const specs = tree
    .files(`${dir}/specs`)
    .filter((f) => f.endsWith('.md'))
    .map((file) => ({
      file,
      capability: file.slice(`${dir}/specs/`.length).replace(/\/spec\.md$/, '').replace(/\.md$/, ''),
      parsed: parseSpec(text(tree.read(file))),
    }));
  return {
    name,
    dir,
    archived,
    proposal: proposalText === null ? null : { file: `${dir}/proposal.md`, ...parseProposal(proposalText) },
    design: designText === null ? null : { file: `${dir}/design.md`, ...parseDesign(designText) },
    tasks: tasksText === null ? { total: 0, done: 0 } : parseTasks(tasksText),
    specs,
  };
}

export function loadLivingSpecs(tree) {
  return tree
    .files(SPECS_DIR)
    .filter((f) => f.endsWith('/spec.md'))
    .map((file) => ({
      file,
      capability: file.slice(`${SPECS_DIR}/`.length).replace(/\/spec\.md$/, ''),
      parsed: parseSpec(text(tree.read(file))),
    }));
}

/** Scenarios a change adds or modifies: what conformance must cover. */
export function deltaScenarios(change) {
  return change.specs.flatMap((spec) =>
    spec.parsed.requirements
      .filter((r) => r.op === 'ADDED' || r.op === 'MODIFIED')
      .flatMap((r) => r.scenarios.map((s) => ({ ...s, requirement: r.name, capability: spec.capability, file: spec.file }))),
  );
}

export function toPosix(path) {
  return path.split(sep).join('/');
}

export function repoRelative(root, abs) {
  return toPosix(relative(root, abs));
}
