// Test helpers: a valid change, temporary repositories and a fake PHPUnit.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// gate/spec: os checks de spec da esteira (OPS-67, movidos para a esteira no OPS-88).
export const SPEC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OPENSPEC = join(SPEC_ROOT, 'bin/openspec');
export const FAKE_PHPUNIT = `node ${join(dirname(fileURLToPath(import.meta.url)), 'fake-phpunit.mjs')}`;
export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const PROPOSAL = `## Why
Jira: FP-999. Demo change for the spec checks.

## Examples
- EX-1: a seller with a valid token sees the demo.
- EX-2: a request without a token is rejected.

## What Changes
- Adds the demo capability.

## Capabilities
### New Capabilities
- \`demo\`: demo capability.

## Impact
None.
`;

export const SPEC = `## Purpose
Demo capability used by the tests of the Ozea spec checks.

## ADDED Requirements

### Requirement: Demo access
The system SHALL show the demo only to authenticated sellers.

#### Scenario: RCV-DEMO-001 authenticated seller sees the demo
- **Origin**: EX-1
- **WHEN** a seller with a valid token requests the demo
- **THEN** the demo is returned

#### Scenario: RCV-DEMO-002 request without token is rejected
- **Origin**: EX-2
- **Security**: negative
- **WHEN** a request without a token asks for the demo
- **THEN** the request is rejected with 401
`;

export const DESIGN = `## Context
Demo.

## Security
- **Applies**: yes
- Authentication: RCV-DEMO-002.
`;

export const TASKS = `## 1. Demo

- [ ] 1.1 Build the demo
`;

export const ACCEPTANCE_TEST = `<?php
// acceptance test for RCV-DEMO-001 and RCV-DEMO-002
`;

/** Files of a valid repository with one active change "add-demo". */
export function validFiles(overrides = {}) {
  return {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'openspec/specs/.gitkeep': '',
    'openspec/changes/archive/.gitkeep': '',
    'openspec/changes/add-demo/.openspec.yaml': 'schema: spec-driven\n',
    'openspec/changes/add-demo/proposal.md': PROPOSAL,
    'openspec/changes/add-demo/design.md': DESIGN,
    'openspec/changes/add-demo/tasks.md': TASKS,
    'openspec/changes/add-demo/specs/demo/spec.md': SPEC,
    ...overrides,
  };
}

export function tempDir(prefix = 'spec-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    if (content === null) {
      rmSync(abs, { force: true });
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

export function sh(root, cmd, args) {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A Git repository whose first commit is the "main" base. */
export function initRepo(files = {}) {
  const root = tempDir('spec-repo-');
  sh(root, 'git', ['init', '-q', '-b', 'main']);
  sh(root, 'git', ['config', 'user.email', 'test@example.invalid']);
  sh(root, 'git', ['config', 'user.name', 'spec-test']);
  sh(root, 'git', ['config', 'commit.gpgsign', 'false']);
  writeFiles(root, { 'README.md': 'base\n', ...files });
  commit(root, 'base');
  return { root, base: rev(root) };
}

export function commit(root, message, files = null) {
  if (files) writeFiles(root, files);
  sh(root, 'git', ['add', '-A']);
  sh(root, 'git', ['commit', '-q', '--allow-empty', '-m', message]);
  return rev(root);
}

export function rev(root, ref = 'HEAD') {
  return sh(root, 'git', ['rev-parse', ref]).trim();
}

/** Writes a fake PHPUnit result pair for `fake-phpunit.mjs`. */
export function fakeResults(dir, listXml, junitXml) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'list.xml'), listXml);
  writeFileSync(join(dir, 'junit.xml'), junitXml);
  return dir;
}

export function listXml(tests) {
  const groups = new Map();
  for (const t of tests) for (const g of t.scenarios) groups.set(g, [...(groups.get(g) ?? []), t.id]);
  return `<?xml version="1.0"?>
<testSuite xmlns="https://xml.phpunit.de/testSuite">
 <tests>
${tests.map((t) => `  <testClass name="${t.id.split('::')[0]}" file="x.php"><testMethod id="${t.id}" name="${t.id.split('::')[1]}"/></testClass>`).join('\n')}
 </tests>
 <groups>
${[...groups].map(([g, ids]) => `  <group name="scenario:${g}">${ids.map((id) => `<test id="${id}"/>`).join('')}</group>`).join('\n')}
 </groups>
</testSuite>
`;
}

export function junitXml(tests) {
  const body = tests
    .map((t) => {
      const [cls, name] = t.id.split('::');
      const inner = { failed: '<failure type="x">boom</failure>', error: '<error type="x">boom</error>', skipped: '<skipped/>' }[t.status] ?? '';
      return `<testcase name="${name}" class="${cls}" classname="${cls.replace(/\\/g, '.')}" assertions="1" time="0">${inner}</testcase>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="acceptance">\n${body}\n</testsuite></testsuites>\n`;
}

export function copyFixture(name, to) {
  copyFileSync(join(FIXTURES, name), to);
}
