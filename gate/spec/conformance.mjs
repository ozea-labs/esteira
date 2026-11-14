#!/usr/bin/env node
// spec-conformance (OPS-67, AC8). Every scenario the change adds or modifies
// has at least one acceptance test that ran and passed, and every approved
// example (EX-n) reaches a green test through its scenarios. Writes
// build/spec/conformance.json as evidence. Usage:
//   node scripts/spec/conformance.mjs --change <name> [--root .]
//        (--phpunit "<cmd>" | --list-xml <file> --junit <file>)
//        [--out build/spec/conformance.json] [--json]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinResults, runAcceptance } from './lib/phpunit.mjs';
import { acceptanceDirFor, deltaScenarios, fsTree, loadChange } from './lib/repo.mjs';
import { UsageError, parseArgs, printViolations, runCli, violation } from './lib/report.mjs';

export function conformance({ change, tests }) {
  const out = [];
  const scenarios = deltaScenarios(change).filter((s) => s.id);
  const report = { change: change.name, examples: [], scenarios: [] };

  const byScenario = new Map();
  for (const s of scenarios) {
    const mine = tests.filter((t) => t.scenarios.includes(s.id));
    const green = mine.length > 0 && mine.every((t) => t.status === 'passed');
    byScenario.set(s.id, green);
    report.scenarios.push({ id: s.id, name: s.name, origins: s.origins, securityNegative: s.securityNegative, green, tests: mine.map((t) => ({ id: t.id, status: t.status })) });
    if (mine.length === 0) {
      out.push(violation('SCENARIO_UNTESTED', `${s.id} has no acceptance test (#[Group('scenario:${s.id}')])`, s.file, s.line));
    } else {
      for (const t of mine.filter((x) => x.status !== 'passed')) {
        out.push(violation('SCENARIO_NOT_GREEN', `${s.id}: ${t.id} is ${t.status}`, s.file, s.line));
      }
    }
  }

  for (const e of change.proposal?.examples ?? []) {
    const linked = scenarios.filter((s) => s.origins.includes(e.id));
    const green = linked.some((s) => byScenario.get(s.id));
    report.examples.push({ id: e.id, scenarios: linked.map((s) => s.id), green });
    if (!green) out.push(violation('EX_NOT_COVERED', `${e.id} has no scenario with a green acceptance test`, change.proposal.file, e.line));
  }

  const known = new Set(scenarios.map((s) => s.id));
  const prefix = acceptanceDirFor(change.name).replace('tests/Acceptance/', '');
  report.unknownScenarioGroups = [...new Set(tests.flatMap((t) => t.scenarios).filter((id) => !known.has(id)))];
  report.ok = out.length === 0;
  report.acceptanceNamespace = `App\\Tests\\Acceptance\\${prefix}`;
  return { violations: out, report };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli('spec-conformance', (argv) => {
    const args = parseArgs(argv, {
      root: { default: '.' }, change: {}, phpunit: {}, 'list-xml': {}, junit: {},
      out: { default: 'build/spec/conformance.json' }, json: { flag: true },
    });
    if (!args.change) throw new UsageError('--change is required');
    const change = loadChange(fsTree(args.root), args.change);
    if (!change) throw new UsageError(`change ${args.change} not found`);
    let tests;
    if (args['list-xml'] && args.junit) {
      tests = joinResults(readFileSync(args['list-xml'], 'utf8'), readFileSync(args.junit, 'utf8'));
    } else if (args.phpunit) {
      tests = runAcceptance({ cwd: args.root, phpunit: args.phpunit, dir: acceptanceDirFor(args.change) }).tests;
    } else {
      throw new UsageError('pass --phpunit "<cmd>" or both --list-xml and --junit');
    }
    const { violations, report } = conformance({ change, tests });
    const outPath = join(args.root, args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    printViolations('spec-conformance', violations, { json: args.json });
    return violations;
  });
}
