#!/usr/bin/env node
// gate-integrity (OPS-65). Um PR de produto não afrouxa o portão que o julga. Falha quando o diff
// merge-base(base, head)..head:
//   - toca um caminho do portão (gate/protected-paths.txt);
//   - tem menos métodos de teste que a base;
//   - adiciona marcador de teste pulado;
//   - adiciona supressão de analisador ou scanner;
//   - muda a seção `scripts` de um composer.json;
//   - aumenta uma baseline.
// Spec e testes de aceite travados ficam com o gate/spec/integrity.mjs (OPS-67).
//
// Exceções, ambas fora do alcance do PR:
//   - autor `dependabot[bot]` mudando só linhas `uses:` em .github/workflows/*.yml e o actions.lock;
//   - --released-sha igual ao head: o dono liberou esse commit (variável PORTAO_LIBERADO_SHA, que só
//     administrador grava). Todas as regras viram aviso.
//
// Uso:
//   node gate-integrity.mjs --base <rev> --head <rev> [--root .] [--author <login>]
//        [--released-sha <sha>] [--paths <arquivo>] [--list-protected]

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PATHS_FILE = resolve(HERE, '../protected-paths.txt');
export const DEPENDABOT = 'dependabot[bot]';

// Testes. Conta uma linha por ocorrência, igual na base e no head.
const TEST_FILE = /Test\.php$/;
const TEST_DECL = /(\bfunction\s+test\w*\s*\()|(#\[\s*(\\?PHPUnit\\Framework\\Attributes\\)?Test\s*[\](])|(@test\b)/;

export const SKIP_MARKERS = [
  /\bmarkTestSkipped\s*\(/,
  /\bmarkTestIncomplete\s*\(/,
  /@group\s+skip\b/,
  /#\[\s*(\\?PHPUnit\\Framework\\Attributes\\)?Group\s*\(\s*['"]skip/,
  /->skip\s*\(/,
];

export const SUPPRESSIONS = [
  /@phpstan-ignore/,
  /\bphpcs:(ignore|disable)\b/,
  /@codeCoverageIgnore/,
  /#\[\s*(\\?PHPUnit\\Framework\\Attributes\\)?CodeCoverageIgnore/,
  /@psalm-suppress/,
  /@SuppressWarnings/,
  /\bnosemgrep\b/,
  /gitleaks:allow/,
  /\bNOSONAR\b/,
  /trivy:ignore/,
  /eslint-disable/,
  /@ts-(ignore|nocheck|expect-error)/,
  /#\s*noqa\b/,
  /#\s*type:\s*ignore/,
];

const BASELINE_FILE = /(^|\/)[^/]*baseline[^/]*\.(neon|php|json|xml|ya?ml|txt)$/i;
const USES_LINE = /^\s*-?\s*uses:\s*\S+/;
const DEPENDABOT_FILES = /^\.github\/workflows\/([^/]+\.ya?ml|actions\.lock)$/;

// ---------- padrões ----------

export function loadPatterns(file = DEFAULT_PATHS_FILE) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** fnmatch no estilo do GitHub: `*` e `?` não atravessam `/`; `**` atravessa; `**\/` aceita zero diretórios. */
export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function protectedMatcher(patterns) {
  const regexes = patterns.map(globToRegex);
  return (path) => regexes.some((r) => r.test(path));
}

// ---------- git ----------

function git(root, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(' ')}: ${error.stderr || error.message}`);
  }
}

function show(root, rev, path) {
  return git(root, ['show', `${rev}:${path}`], { allowFail: true });
}

/** Arquivos mudados (sem detecção de rename: um move aparece como D + A, e os dois lados contam). */
export function changedFiles(root, from, head) {
  const out = git(root, ['diff', '--no-renames', '--name-status', '-z', from, head]);
  const parts = out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; i += 2) files.push({ status: parts[i], path: parts[i + 1] });
  return files;
}

/** Linhas adicionadas e removidas por arquivo (diff sem contexto). */
export function diffLines(root, from, head) {
  const out = git(root, ['diff', '--no-renames', '--no-color', '--no-ext-diff', '-U0', from, head]);
  const byFile = new Map();
  let current = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) { current = null; continue; }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      current = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (current && !byFile.has(current)) byFile.set(current, { added: [], removed: [] });
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') {
        const old = p.replace(/^a\//, '');
        if (!byFile.has(old)) byFile.set(old, { added: [], removed: [] });
        current = old;
      }
      continue;
    }
    if (!current) continue;
    const entry = byFile.get(current);
    if (line.startsWith('+')) entry.added.push(line.slice(1));
    else if (line.startsWith('-')) entry.removed.push(line.slice(1));
  }
  return byFile;
}

export function countTestsInSource(source) {
  let n = 0;
  for (const line of source.split('\n')) if (TEST_DECL.test(line)) n++;
  return n;
}

function listTestFiles(root, rev) {
  const out = git(root, ['ls-tree', '-r', '--name-only', rev]);
  return out.split('\n').filter((p) => TEST_FILE.test(p));
}

export function countTestsAt(root, rev) {
  let total = 0;
  for (const p of listTestFiles(root, rev)) total += countTestsInSource(show(root, rev, p) ?? '');
  return total;
}

export function baselineEntries(source, path = '') {
  if (source === null || source === undefined) return 0;
  let counted = 0;
  let sawCount = false;
  for (const m of source.matchAll(/\bcount['"]?\s*(?:=>|:)\s*(\d+)/g)) { counted += Number(m[1]); sawCount = true; }
  if (sawCount) return counted;
  const messages = source.match(/\bmessage['"]?\s*(?:=>|:)/g);
  if (messages) return messages.length;
  // Baseline em texto puro (uma entrada por linha). Nos formatos estruturados, sem count nem message é vazia.
  if (!path.endsWith('.txt')) return 0;
  return source.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length;
}

// ---------- regras ----------

const v = (rule, path, message) => ({ rule, path, message });

export function integrity({ root = '.', base, head, author = '', releasedSha = '', patterns = loadPatterns() }) {
  const headSha = git(root, ['rev-parse', head]).trim();
  const from = git(root, ['merge-base', base, headSha]).trim();
  const isProtected = protectedMatcher(patterns);
  const files = changedFiles(root, from, headSha);
  const lines = diffLines(root, from, headSha);
  const violations = [];

  // 1. Caminhos do portão.
  const protectedChanged = files.filter((f) => isProtected(f.path));
  for (const f of protectedChanged) {
    if (author === DEPENDABOT && dependabotChangeAllowed(f, lines.get(f.path))) continue;
    violations.push(v('PROTECTED_PATH', f.path, `o PR muda um caminho do portão (${f.status})`));
  }

  // 2. Testes apagados.
  const before = countTestsAt(root, from);
  const after = countTestsAt(root, headSha);
  if (after < before) {
    const gone = files.filter((f) => f.status === 'D' && TEST_FILE.test(f.path)).map((f) => f.path);
    violations.push(v('TEST_REMOVED', gone[0] ?? '', `métodos de teste caíram de ${before} para ${after}${gone.length ? ` (apagados: ${gone.join(', ')})` : ''}`));
  }

  // 3 e 4. Teste pulado e supressão nova, só em linhas adicionadas.
  for (const [path, { added }] of lines) {
    for (const line of added) {
      if (path.endsWith('.php') && SKIP_MARKERS.some((r) => r.test(line))) {
        violations.push(v('TEST_SKIPPED', path, `marcador de teste pulado: ${line.trim()}`));
      }
      const sup = SUPPRESSIONS.find((r) => r.test(line));
      if (sup) violations.push(v('SUPPRESSION_ADDED', path, `supressão nova: ${line.trim()}`));
    }
  }

  // 5. Scripts do Composer.
  for (const f of files.filter((f) => /(^|\/)composer\.json$/.test(f.path))) {
    const a = composerScripts(show(root, from, f.path));
    const b = composerScripts(show(root, headSha, f.path));
    if (a !== b) violations.push(v('COMPOSER_SCRIPTS', f.path, 'a seção "scripts" do composer.json mudou'));
  }

  // 6. Baselines só encolhem.
  for (const f of files.filter((f) => BASELINE_FILE.test(f.path))) {
    const a = baselineEntries(show(root, from, f.path), f.path);
    const b = baselineEntries(show(root, headSha, f.path), f.path);
    if (b > a) violations.push(v('BASELINE_GROWN', f.path, `a baseline cresceu de ${a} para ${b} entradas`));
  }

  const released = Boolean(releasedSha) && releasedSha === headSha;
  return { from, head: headSha, released, protectedChanged: protectedChanged.map((f) => f.path), violations };
}

function composerScripts(source) {
  if (source === null) return 'null';
  try {
    return JSON.stringify(JSON.parse(source).scripts ?? null);
  } catch {
    return `invalid:${source.length}`;
  }
}

/** Dependabot só troca SHA: todo .yml mudado só tem linhas `uses:` trocadas; o actions.lock pode mudar inteiro. */
export function dependabotChangeAllowed(file, diff) {
  if (file.status !== 'M' || !DEPENDABOT_FILES.test(file.path)) return false;
  if (file.path.endsWith('actions.lock')) return true;
  if (!diff) return false;
  return [...diff.added, ...diff.removed].every((l) => USES_LINE.test(l));
}

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = { root: '.', author: '', releasedSha: '', paths: DEFAULT_PATHS_FILE, listProtected: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`falta valor para ${a}`); return argv[++i]; };
    if (a === '--root') opts.root = next();
    else if (a === '--base') opts.base = next();
    else if (a === '--head') opts.head = next();
    else if (a === '--author') opts.author = next();
    else if (a === '--released-sha') opts.releasedSha = next();
    else if (a === '--paths') opts.paths = next();
    else if (a === '--list-protected') opts.listProtected = true;
    else throw new Error(`argumento desconhecido: ${a}`);
  }
  if (!opts.base || !opts.head) throw new Error('uso: gate-integrity.mjs --base <rev> --head <rev> [--root .] [--author <login>] [--released-sha <sha>] [--paths <arquivo>] [--list-protected]');
  return opts;
}

function annotate(level, { rule, path, message }) {
  const where = path ? ` file=${path}` : '';
  // O runner consome o `file=` da anotação; o caminho vai também no texto, para o log e para quem lê o PR.
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::${level}${where}::${rule}${path ? ` ${path}` : ''}: ${message}`);
  else console.log(`${level === 'error' ? 'ERRO' : 'aviso'} ${rule}${path ? ` ${path}` : ''}: ${message}`);
}

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

export function main(argv) {
  const opts = parseArgs(argv);
  const result = integrity({ root: join(opts.root), base: opts.base, head: opts.head, author: opts.author, releasedSha: opts.releasedSha, patterns: loadPatterns(opts.paths) });

  if (opts.listProtected) {
    for (const p of result.protectedChanged) console.log(p);
    return 0;
  }

  const { violations } = result;
  if (violations.length === 0) {
    console.log(`integrity: verde (${result.from.slice(0, 8)}..${result.head.slice(0, 8)})`);
    return 0;
  }
  if (result.released) {
    for (const x of violations) annotate('notice', x);
    const msg = `integrity: commit ${result.head} LIBERADO pelo dono (PORTAO_LIBERADO_SHA). ${violations.length} regra(s) viraram aviso.`;
    console.log(msg);
    summary(`### Portão liberado\n\n${msg}\n\n${violations.map((x) => `- \`${x.rule}\` ${x.path}: ${x.message}`).join('\n')}`);
    return 0;
  }
  for (const x of violations) annotate('error', x);
  console.log(`integrity: ${violations.length} violação(ões). Mudança legítima num caminho do portão passa pela liberação autorizada (docs/runbooks/liberar-portao.md da esteira).`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`gate-integrity: ${error.message}`);
    process.exitCode = 2;
  }
}
