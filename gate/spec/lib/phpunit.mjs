// Runs the PHPUnit acceptance tests of one change and maps each test to its
// scenario groups ("scenario:<ID>") and its result, using two PHPUnit 13
// outputs: --list-tests-xml (test -> groups) and --log-junit (test -> result).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decode(m[1]) : null;
};
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Data-provider cases are listed as "Class::method#0" (or "@name") and logged
// in junit as "method with data set #0"; both are folded into "Class::method",
// whose status is the worst of its cases.
const methodId = (id) => id.match(/^(.*::[A-Za-z_\x80-￿][A-Za-z0-9_\x80-￿]*)/)?.[1] ?? id;

/** Map test id ("Class::method") -> scenario ids, from --list-tests-xml. */
export function parseListTests(xml) {
  const groups = new Map();
  const tests = new Set();
  for (const m of xml.matchAll(/<testMethod\b[^>]*>/g)) tests.add(methodId(attr(m[0], 'id')));
  for (const g of xml.matchAll(/<group\b[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/group>/g)) {
    const name = decode(g[1]);
    if (!name.startsWith('scenario:')) continue;
    const scenario = name.slice('scenario:'.length);
    for (const t of g[2].matchAll(/<test\b[^>]*>/g)) {
      const id = methodId(attr(t[0], 'id'));
      if (!groups.has(id)) groups.set(id, new Set());
      groups.get(id).add(scenario);
    }
  }
  return { tests, groups };
}

/** Map test id -> "passed" | "failed" | "error" | "skipped", from --log-junit. */
export function parseJunit(xml) {
  const results = new Map();
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const tag = `<testcase${m[1]}>`;
    const cls = attr(tag, 'class');
    const name = attr(tag, 'name');
    if (!cls || !name) continue;
    const method = name.replace(/ with data set .*$/s, '');
    const body = m[3] ?? '';
    let status = 'passed';
    if (/<error\b/.test(body)) status = 'error';
    else if (/<failure\b/.test(body)) status = 'failed';
    else if (/<skipped\b/.test(body)) status = 'skipped';
    const id = `${cls}::${method}`;
    const prev = results.get(id);
    const rank = { passed: 0, skipped: 1, failed: 2, error: 3 };
    if (!prev || rank[status] > rank[prev]) results.set(id, status);
  }
  return results;
}

/** Joins both outputs: [{ id, scenarios: [...], status }]. Tests absent from junit did not run. */
export function joinResults(listXml, junitXml) {
  const { tests, groups } = parseListTests(listXml);
  const results = parseJunit(junitXml);
  return [...tests].map((id) => ({
    id,
    scenarios: [...(groups.get(id) ?? [])].sort(),
    status: results.get(id) ?? 'not-run',
  }));
}

/**
 * Runs `<phpunit> <dir> --list-tests-xml` and `<phpunit> <dir> --log-junit`
 * in `cwd`. `phpunit` is a shell command prefix, for example
 * "php vendor/bin/phpunit -c phpunit.dist.xml". The test run may exit non-zero
 * (red tests); only missing output files are environment errors.
 */
export function runAcceptance({ cwd, phpunit, dir, env = process.env }) {
  const work = mkdtempSync(join(tmpdir(), 'spec-phpunit-'));
  try {
    const list = join(work, 'list.xml');
    const junit = join(work, 'junit.xml');
    const run = (args) =>
      spawnSync(`${phpunit} ${args}`, { cwd, env, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const listed = run(`${quote(dir)} --list-tests-xml ${quote(list)}`);
    const listXml = safeRead(list);
    if (listXml === null) throw new Error(`phpunit --list-tests-xml produced no output (exit ${listed.status}): ${tail(listed)}`);
    const ran = run(`${quote(dir)} --log-junit ${quote(junit)}`);
    const junitXml = safeRead(junit);
    if (junitXml === null) throw new Error(`phpunit --log-junit produced no output (exit ${ran.status}): ${tail(ran)}`);
    return { tests: joinResults(listXml, junitXml), exitCode: ran.status, listXml, junitXml };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const tail = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-5).join(' | ');
function safeRead(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
