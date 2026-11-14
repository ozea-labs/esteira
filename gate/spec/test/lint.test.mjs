// AC5-AC6: Ozea scenario lint.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lint } from '../lint.mjs';
import { DESIGN, PROPOSAL, SPEC, tempDir, validFiles, writeFiles } from './helpers.mjs';

const C = 'openspec/changes/add-demo';

function run(overrides = {}) {
  const root = tempDir();
  writeFiles(root, validFiles(overrides));
  return lint({ root });
}
const codes = (violations) => violations.map((v) => v.code).sort();

test('a valid change passes', () => {
  assert.deepEqual(run(), []);
});

test('requirement without scenario', () => {
  const spec = SPEC.replace('### Requirement: Demo access', '### Requirement: Empty\nThe system SHALL do nothing.\n\n### Requirement: Demo access');
  assert.deepEqual(codes(run({ [`${C}/specs/demo/spec.md`]: spec })), ['REQ_NO_SCENARIO']);
});

test('scenario without an ID', () => {
  const v = run({ [`${C}/specs/demo/spec.md`]: SPEC.replace('RCV-DEMO-001 authenticated', 'authenticated') });
  assert.deepEqual(codes(v), ['SCN_NO_ID']);
  assert.equal(v[0].line, 9);
});

test('ID outside the format', () => {
  assert.deepEqual(codes(run({ [`${C}/specs/demo/spec.md`]: SPEC.replace('RCV-DEMO-001', 'RCV-demo-1') })), ['SCN_BAD_ID']);
});

test('ID repeated inside the change', () => {
  assert.deepEqual(codes(run({ [`${C}/specs/demo/spec.md`]: SPEC.replace('RCV-DEMO-002', 'RCV-DEMO-001') })), ['SCN_DUP_ID']);
});

test('ADDED ID that already exists in the living spec', () => {
  const living = `## Purpose\nLiving demo spec used by the duplicate-ID test.\n\n## Requirements\n\n### Requirement: Old\nThe system SHALL keep the old behaviour.\n\n#### Scenario: RCV-DEMO-001 old\n- **Origin**: EX-9\n- **WHEN** x\n- **THEN** y\n`;
  assert.deepEqual(codes(run({ 'openspec/specs/demo/spec.md': living })), ['SCN_DUP_ID']);
});

test('MODIFIED keeps the ID of the same requirement', () => {
  const living = `## Purpose\nLiving demo spec used by the MODIFIED test.\n\n## Requirements\n\n### Requirement: Demo access\nThe system SHALL show the demo.\n\n#### Scenario: RCV-DEMO-001 old\n- **WHEN** x\n- **THEN** y\n`;
  const delta = SPEC.replace('## ADDED Requirements', '## MODIFIED Requirements').replace(/## Purpose\n.*\n\n/, '');
  assert.deepEqual(run({ 'openspec/specs/demo/spec.md': living, [`${C}/specs/demo/spec.md`]: delta }), []);
});

test('same ID in two active changes', () => {
  const other = 'openspec/changes/add-other';
  const v = run({
    [`${other}/proposal.md`]: PROPOSAL,
    [`${other}/design.md`]: DESIGN,
    [`${other}/specs/other/spec.md`]: SPEC,
  });
  assert.ok(codes(v).includes('SCN_DUP_ID'));
});

test('scenario without Origin', () => {
  assert.deepEqual(codes(run({ [`${C}/specs/demo/spec.md`]: SPEC.replace('- **Origin**: EX-1\n', '') })), ['EX_NO_SCENARIO', 'SCN_NO_ORIGIN']);
});

test('Origin citing an EX that is not in the proposal', () => {
  assert.deepEqual(codes(run({ [`${C}/specs/demo/spec.md`]: SPEC.replace('- **Origin**: EX-1', '- **Origin**: EX-1, EX-7') })), ['SCN_UNKNOWN_EX']);
});

test('EX in the proposal without scenario', () => {
  const proposal = PROPOSAL.replace('- EX-2:', '- EX-3: an extra example.\n- EX-2:');
  assert.deepEqual(codes(run({ [`${C}/proposal.md`]: proposal })), ['EX_NO_SCENARIO']);
});

test('proposal without Examples', () => {
  const proposal = PROPOSAL.replace(/## Examples\n(- .*\n)+\n/, '');
  assert.ok(codes(run({ [`${C}/proposal.md`]: proposal })).includes('PROPOSAL_NO_EXAMPLES'));
});

test('AC6: design without Security section', () => {
  assert.deepEqual(codes(run({ [`${C}/design.md`]: '## Context\nDemo.\n' })), ['DESIGN_NO_SECURITY']);
});

test('AC6: design missing', () => {
  assert.deepEqual(codes(run({ [`${C}/design.md`]: null })), ['DESIGN_MISSING']);
});

test('AC6: security applies but no negative scenario', () => {
  assert.deepEqual(codes(run({ [`${C}/specs/demo/spec.md`]: SPEC.replace('- **Security**: negative\n', '') })), ['SECURITY_NO_NEGATIVE']);
});

test('AC6: security does not apply, no negative scenario needed', () => {
  const design = DESIGN.replace('- **Applies**: yes', '- **Applies**: no - internal batch job');
  assert.deepEqual(run({ [`${C}/design.md`]: design, [`${C}/specs/demo/spec.md`]: SPEC.replace('- **Security**: negative\n', '') }), []);
});

test('headers inside code fences are ignored', () => {
  const spec = SPEC.replace('### Requirement: Demo access', '```\n### Requirement: fenced\n#### Scenario: no id\n```\n\n### Requirement: Demo access');
  assert.deepEqual(run({ [`${C}/specs/demo/spec.md`]: spec }), []);
});
