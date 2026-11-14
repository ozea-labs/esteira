#!/usr/bin/env node
// Ozea scenario lint (OPS-67, AC5-AC6). Usage:
//   node scripts/spec/lint.mjs [--root .] [--change <name>]... [--json]
// Without --change it checks every active change. Living specs are always checked.

import { fileURLToPath } from 'node:url';
import { activeChangeNames, fsTree, loadChange, loadLivingSpecs } from './lib/repo.mjs';
import { parseArgs, printViolations, runCli, violation } from './lib/report.mjs';

const PREFIX = /^RCV-/;

function checkScenarioName(s, file, out) {
  if (s.id) return true;
  if (PREFIX.test(s.name)) {
    out.push(violation('SCN_BAD_ID', `scenario "${s.name}" must start with RCV-<CAPABILITY>-<NNN> (2-12 uppercase letters/digits, three digits)`, file, s.line));
  } else {
    out.push(violation('SCN_NO_ID', `scenario "${s.name}" has no RCV-<CAPABILITY>-<NNN> identifier`, file, s.line));
  }
  return false;
}

function lintLivingSpecs(specs, out) {
  const owners = new Map(); // id -> "capability/requirement"
  for (const spec of specs) {
    for (const r of spec.parsed.requirements) {
      if (r.scenarios.length === 0) out.push(violation('REQ_NO_SCENARIO', `requirement "${r.name}" has no scenario`, spec.file, r.line));
      for (const s of r.scenarios) {
        if (!checkScenarioName(s, spec.file, out)) continue;
        const owner = `${spec.capability}/${r.name}`;
        const seen = owners.get(s.id);
        if (seen && seen.owner !== owner) {
          out.push(violation('SCN_DUP_ID', `${s.id} is already used by "${seen.owner}"`, spec.file, s.line));
        } else if (seen && seen.owner === owner) {
          out.push(violation('SCN_DUP_ID', `${s.id} appears twice in "${owner}"`, spec.file, s.line));
        } else {
          owners.set(s.id, { owner });
        }
      }
    }
  }
  return owners;
}

function lintChange(change, livingOwners, otherActiveIds, out) {
  if (!change.proposal) {
    out.push(violation('PROPOSAL_MISSING', 'proposal.md is missing', `${change.dir}/proposal.md`));
  } else if (!change.proposal.hasExamplesSection || change.proposal.examples.length === 0) {
    out.push(violation('PROPOSAL_NO_EXAMPLES', 'proposal.md needs a "## Examples" section with the approved "- EX-n: ..." items', change.proposal.file));
  }
  if (!change.design) {
    out.push(violation('DESIGN_MISSING', 'design.md is required by the Ozea rules (it carries the Security section)', `${change.dir}/design.md`));
  } else if (!change.design.hasSecurity || change.design.applies === null) {
    out.push(violation('DESIGN_NO_SECURITY', 'design.md needs "## Security" with "- **Applies**: yes" or "- **Applies**: no - <reason>"', change.design.file, change.design.line));
  }

  const examples = new Set((change.proposal?.examples ?? []).map((e) => e.id));
  const covered = new Set();
  const ids = new Map();
  let negatives = 0;

  for (const spec of change.specs) {
    for (const r of spec.parsed.requirements) {
      if (r.op !== 'ADDED' && r.op !== 'MODIFIED') continue;
      if (r.scenarios.length === 0) out.push(violation('REQ_NO_SCENARIO', `requirement "${r.name}" has no scenario`, spec.file, r.line));
      for (const s of r.scenarios) {
        if (s.securityNegative) negatives += 1;
        if (!s.hasOrigin || s.origins.length === 0) {
          out.push(violation('SCN_NO_ORIGIN', `scenario "${s.name}" needs "- **Origin**: EX-n"`, spec.file, s.line));
        }
        for (const ex of s.origins) {
          if (examples.has(ex)) covered.add(ex);
          else out.push(violation('SCN_UNKNOWN_EX', `scenario "${s.name}" cites ${ex}, which is not in proposal.md Examples`, spec.file, s.line));
        }
        if (!checkScenarioName(s, spec.file, out)) continue;
        if (ids.has(s.id)) {
          out.push(violation('SCN_DUP_ID', `${s.id} appears twice in change ${change.name}`, spec.file, s.line));
          continue;
        }
        ids.set(s.id, true);
        const owner = `${spec.capability}/${r.name}`;
        const living = livingOwners.get(s.id);
        // After archive the change's scenarios are part of the living specs, so
        // only active changes are compared against them.
        if (!change.archived && living) {
          if (r.op === 'ADDED') out.push(violation('SCN_DUP_ID', `${s.id} already exists in the living spec "${living.owner}"`, spec.file, s.line));
          else if (living.owner !== owner) out.push(violation('SCN_DUP_ID', `${s.id} belongs to "${living.owner}" in the living spec, not "${owner}"`, spec.file, s.line));
        }
        const other = otherActiveIds.get(s.id);
        if (other && other !== change.name) out.push(violation('SCN_DUP_ID', `${s.id} is also used by active change ${other}`, spec.file, s.line));
      }
    }
  }

  for (const e of change.proposal?.examples ?? []) {
    if (!covered.has(e.id)) out.push(violation('EX_NO_SCENARIO', `${e.id} has no scenario`, change.proposal.file, e.line));
  }
  if (change.design?.applies === true && negatives === 0) {
    out.push(violation('SECURITY_NO_NEGATIVE', 'design.md says security applies but no scenario is marked "- **Security**: negative"', change.design.file, change.design.line));
  }
}

export function lint({ root = '.', tree = fsTree(root), changes = null } = {}) {
  const out = [];
  const livingOwners = lintLivingSpecs(loadLivingSpecs(tree), out);
  const active = activeChangeNames(tree);
  const names = changes ?? active;

  const activeIds = new Map();
  for (const name of active) {
    const change = loadChange(tree, name);
    for (const spec of change?.specs ?? []) {
      for (const r of spec.parsed.requirements) {
        for (const s of r.scenarios) if (s.id && !activeIds.has(s.id)) activeIds.set(s.id, name);
      }
    }
  }

  for (const name of names) {
    const change = loadChange(tree, name);
    if (!change) {
      out.push(violation('CHANGE_NOT_FOUND', `change ${name} not found (active or archived)`));
      continue;
    }
    lintChange(change, livingOwners, activeIds, out);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli('spec-lint', (argv) => {
    const args = parseArgs(argv, { root: { default: '.' }, change: { multiple: true }, json: { flag: true } });
    const violations = lint({ root: args.root, changes: args.change.length ? args.change : null });
    printViolations('spec-lint', violations, { json: args.json });
    return violations;
  });
}
