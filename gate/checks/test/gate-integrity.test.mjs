// Testes do gate-integrity (OPS-65). Cada caso monta um repositório git temporário com uma base e um PR.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEPENDABOT, globToRegex, integrity, loadPatterns, main } from '../gate-integrity.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const TEST_SRC = `<?php
final class GreeterTest extends TestCase
{
    public function testGreets(): void { self::assertSame('oi', (new Greeter())->greet()); }

    #[Test]
    public function itGreetsAgain(): void { self::assertTrue(true); }
}
`;

const BASE = {
  'src/Greeter.php': "<?php\nfinal class Greeter { public function greet(): string { return 'oi'; } }\n",
  'tests/GreeterTest.php': TEST_SRC,
  'tests/OtherTest.php': "<?php\nfinal class OtherTest extends TestCase { public function testOther(): void {} }\n",
  'phpstan.neon': 'parameters:\n    level: 6\n',
  'phpstan-baseline.neon': "parameters:\n\tignoreErrors:\n\t\t-\n\t\t\tmessage: '#a#'\n\t\t\tcount: 1\n\t\t\tpath: src/Greeter.php\n",
  'composer.json': JSON.stringify({ require: { php: '>=8.4' }, scripts: { test: 'phpunit' } }, null, 2),
  '.github/workflows/gate.yml': [
    'name: gate',
    'on: [pull_request]',
    'permissions: {}',
    'jobs:',
    '  gate:',
    `    uses: ozea-labs/esteira/.github/workflows/php-app.yml@${'1'.repeat(40)} # v0.1.0`,
    '',
  ].join('\n'),
  '.github/workflows/actions.lock': 'version: 1\n',
  '.github/esteira.env': 'PHP_VERSION=8.4\n',
  'CLAUDE.md': '# regras\n',
};

function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    if (content === null) { rmSync(full); continue; }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** Repositório com a base em `main` e o PR (mudanças) num commit em `pr`. Devolve { root, base, head }. */
function repo(changes) {
  const root = mkdtempSync(join(tmpdir(), 'gate-integrity-'));
  dirs.push(root);
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 't@example.invalid');
  sh(root, 'config', 'user.name', 't');
  sh(root, 'config', 'commit.gpgsign', 'false');
  write(root, BASE);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  const base = sh(root, 'rev-parse', 'HEAD');
  sh(root, 'checkout', '-qb', 'pr');
  write(root, changes);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'pr', '--allow-empty');
  return { root, base, head: sh(root, 'rev-parse', 'HEAD') };
}

const rules = (r) => r.violations.map((x) => x.rule).sort();

describe('padrões', () => {
  test('glob no estilo do GitHub', () => {
    assert.ok(globToRegex('.github/**').test('.github/workflows/gate.yml'));
    assert.ok(!globToRegex('phpstan*.neon*').test('config/phpstan.neon'));
    assert.ok(globToRegex('phpstan*.neon*').test('phpstan-baseline.neon'));
    assert.ok(globToRegex('**/CLAUDE.md').test('CLAUDE.md'));
    assert.ok(globToRegex('**/CLAUDE.md').test('src/CLAUDE.md'));
    assert.ok(!globToRegex('*.md').test('docs/a.md'));
  });

  test('a lista oficial cobre os caminhos do ticket', () => {
    const p = loadPatterns().map(globToRegex);
    const hit = (path) => p.some((r) => r.test(path));
    for (const path of ['.github/workflows/gate.yml', '.github/esteira.env', 'CLAUDE.md', 'AGENTS.md', '.claude/settings.json',
      '.agents/x.md', 'phpstan.neon', 'phpstan-baseline.neon', '.php-cs-fixer.dist.php', 'phpunit.xml.dist',
      '.gitleaks.toml', 'openspec/config.yaml', 'scripts/quality/image-checks.sh']) {
      assert.ok(hit(path), path);
    }
    for (const path of ['src/Greeter.php', 'tests/GreeterTest.php', 'composer.json', 'docs/x.md']) assert.ok(!hit(path), path);
  });
});

describe('PRs envenenados (reprovados)', () => {
  test('limiar afrouxado', () => {
    const r = integrity(repo({ 'phpstan.neon': 'parameters:\n    level: 1\n' }));
    assert.deepEqual(rules(r), ['PROTECTED_PATH']);
  });

  test('teste apagado', () => {
    const r = integrity(repo({ 'tests/OtherTest.php': null }));
    assert.deepEqual(rules(r), ['TEST_REMOVED']);
    assert.match(r.violations[0].message, /de 3 para 2/);
  });

  test('método de teste apagado dentro do arquivo', () => {
    const r = integrity(repo({ 'tests/GreeterTest.php': TEST_SRC.replace(/\n    #\[Test\][^\n]*\n[^\n]*\n/, '\n') }));
    assert.deepEqual(rules(r), ['TEST_REMOVED']);
  });

  test('baseline aumentada', () => {
    const r = integrity(repo({ 'phpstan-baseline.neon': BASE['phpstan-baseline.neon'].replace('count: 1', 'count: 4') }));
    assert.deepEqual(rules(r), ['BASELINE_GROWN', 'PROTECTED_PATH']);
  });

  test('workflow esvaziado', () => {
    const r = integrity(repo({ '.github/workflows/gate.yml': 'name: gate\non: [pull_request]\npermissions: {}\njobs: {}\n' }));
    assert.deepEqual(rules(r), ['PROTECTED_PATH']);
  });

  test('teste pulado', () => {
    const r = integrity(repo({ 'tests/GreeterTest.php': TEST_SRC.replace("self::assertSame('oi'", "self::markTestSkipped('depois'); self::assertSame('oi'") }));
    assert.deepEqual(rules(r), ['TEST_SKIPPED']);
  });

  test('supressão nova', () => {
    const r = integrity(repo({ 'src/Greeter.php': "<?php\n/** @phpstan-ignore-next-line */\nfinal class Greeter {}\n" }));
    assert.deepEqual(rules(r), ['SUPPRESSION_ADDED']);
  });

  test('scripts do Composer', () => {
    const r = integrity(repo({ 'composer.json': JSON.stringify({ require: { php: '>=8.4' }, scripts: { test: 'true' } }, null, 2) }));
    assert.deepEqual(rules(r), ['COMPOSER_SCRIPTS']);
  });

  test('configuração de agente', () => {
    const r = integrity(repo({ 'CLAUDE.md': '# regras\nPode apagar teste.\n', '.claude/settings.json': '{}' }));
    assert.deepEqual(rules(r), ['PROTECTED_PATH', 'PROTECTED_PATH']);
  });

  test('workflow novo no PR (forjar check)', () => {
    const r = integrity(repo({ '.github/workflows/fake.yml': 'name: gate\non: [pull_request]\npermissions: {}\njobs:\n  ci-ok:\n    runs-on: ubuntu-24.04\n    steps: [{run: "true"}]\n' }));
    assert.deepEqual(rules(r), ['PROTECTED_PATH']);
  });
});

describe('PRs válidos (aprovados)', () => {
  test('mudança de produto com teste novo', () => {
    const r = integrity(repo({
      'src/Greeter.php': "<?php\nfinal class Greeter { public function greet(): string { return 'olá'; } }\n",
      'tests/NewTest.php': "<?php\nfinal class NewTest extends TestCase { public function testNew(): void {} }\n",
    }));
    assert.deepEqual(r.violations, []);
  });

  test('teste movido de arquivo', () => {
    const r = integrity(repo({ 'tests/OtherTest.php': null, 'tests/Unit/OtherTest.php': BASE['tests/OtherTest.php'] }));
    assert.deepEqual(r.violations, []);
  });

  test('baseline que encolhe ainda é caminho protegido, mas não cresce', () => {
    const r = integrity(repo({ 'phpstan-baseline.neon': 'parameters:\n\tignoreErrors: []\n' }));
    assert.deepEqual(rules(r), ['PROTECTED_PATH']);
  });

  test('a base andou depois do PR: compara com o merge-base', () => {
    const { root, base, head } = repo({ 'src/Greeter.php': "<?php\nfinal class Greeter {}\n" });
    sh(root, 'checkout', '-q', 'main');
    write(root, { 'tests/Later1Test.php': "<?php\nfinal class Later1Test extends TestCase { public function testA(): void {} }\n" });
    sh(root, 'add', '-A');
    sh(root, 'commit', '-qm', 'main andou');
    const r = integrity({ root, base: sh(root, 'rev-parse', 'HEAD'), head });
    assert.deepEqual(r.violations, [], `base ${base}`);
  });
});

describe('Dependabot', () => {
  const bump = BASE['.github/workflows/gate.yml'].replace('1'.repeat(40), '2'.repeat(40)).replace('v0.1.0', 'v0.2.0');

  test('troca só o SHA da esteira e o lockfile', () => {
    const r = integrity({ ...repo({ '.github/workflows/gate.yml': bump, '.github/workflows/actions.lock': 'version: 1\n# novo\n' }), author: DEPENDABOT });
    assert.deepEqual(r.violations, []);
  });

  test('a mesma troca vinda de outra conta é reprovada', () => {
    const r = integrity({ ...repo({ '.github/workflows/gate.yml': bump }), author: 'moacirjun' });
    assert.deepEqual(rules(r), ['PROTECTED_PATH']);
  });

  test('Dependabot mudando outra linha do workflow é reprovado', () => {
    const r = integrity({ ...repo({ '.github/workflows/gate.yml': bump.replace('permissions: {}', 'permissions: write-all') }), author: DEPENDABOT });
    assert.deepEqual(rules(r), ['PROTECTED_PATH']);
  });

  test('Dependabot mudando a configuração da esteira é reprovado', () => {
    const r = integrity({ ...repo({ '.github/esteira.env': 'PHP_VERSION=8.3\n' }), author: DEPENDABOT });
    assert.deepEqual(rules(r), ['PROTECTED_PATH']);
  });
});

describe('liberação autorizada', () => {
  test('o SHA liberado vira aviso e passa', () => {
    const r = repo({ 'phpstan.neon': 'parameters:\n    level: 7\n' });
    assert.equal(main(['--root', r.root, '--base', r.base, '--head', r.head, '--released-sha', r.head]), 0);
  });

  test('um SHA diferente do liberado continua reprovado', () => {
    const r = repo({ 'phpstan.neon': 'parameters:\n    level: 7\n' });
    assert.equal(main(['--root', r.root, '--base', r.base, '--head', r.head, '--released-sha', 'f'.repeat(40)]), 1);
  });

  test('--list-protected lista só os caminhos do portão', () => {
    const r = repo({ 'phpstan.neon': 'x\n', 'src/Greeter.php': '<?php\n' });
    const out = execFileSync('node', [new URL('../gate-integrity.mjs', import.meta.url).pathname, '--root', r.root, '--base', r.base, '--head', r.head, '--list-protected'], { encoding: 'utf8' });
    assert.equal(out.trim(), 'phpstan.neon');
  });
});
