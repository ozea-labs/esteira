# esteira

Esteira de qualidade central da Ozea Labs ([OPS-64](https://ozealabs.atlassian.net/browse/OPS-64)).
Uma só definição dos portões para todos os sistemas: cada repositório de produto chama os workflows
daqui fixados por SHA e mantém só a configuração própria.

## O que tem aqui

| Caminho | O que faz |
|---|---|
| `.github/workflows/php-app.yml` | Portão de uma aplicação PHP: `config`, `security`, `integrity`, `php`, `spec`, `image` e o agregador `ci-ok` |
| `.github/workflows/publish.yml` | Publica no GHCR o arquivo OCI que o `php-app.yml` construiu e escaneou, e confere o digest |
| `gate/*.sh` | Os passos do portão. O CI e o `make gate` rodam os mesmos scripts |
| `gate/versions.env` | Ferramentas fixadas por digest (actionlint, zizmor, Gitleaks, Semgrep, OSV, Hadolint, Trivy, skopeo) |
| `gate/spec/` | Checks de spec do OpenSpec (OPS-67) e o OpenSpec fixado |
| `gate/protected-paths.txt` | Caminhos do portão que um PR de produto não muda (OPS-65). Fonte do check `integrity` e da regra de push |
| `gate/checks/gate-integrity.mjs` | Check `integrity`: o PR não afrouxa o portão que o julga |
| `github/` | Rulesets versionados por repositório, `apply-rulesets.sh` e `liberar-portao.sh` (liberação autorizada) |
| `docs/runbooks/liberar-portao.md` | Como um agente libera, com autorização do dono, uma mudança legítima no portão |
| `Makefile.include` | Alvo `gate` para o Makefile do consumidor |
| `fixtures/` | Consumidor de exemplo e casos envenenados do self-test (fora do tarball) |

## Portões

- **security** (raiz do repositório): artefatos de agente versionados; política de workflows (toda `uses:` por SHA
  de 40 caracteres, `permissions` no topo, nenhum `continue-on-error`, nenhum `pull_request_target`, esteira chamada
  por um só SHA); actionlint; zizmor bloqueante; `actions.lock` verificado (`gh actions-lock --verify`); Gitleaks;
  Semgrep `p/ci`; OSV.
- **integrity** (só em PR de consumidor): reprova o PR que toca um caminho de `gate/protected-paths.txt`, tem menos
  métodos de teste que a base, adiciona teste pulado ou supressão (`@phpstan-ignore`, `nosemgrep`, `gitleaks:allow`
  e afins), muda os `scripts` do `composer.json` ou aumenta uma baseline. Exceções fora do alcance do PR: o
  Dependabot trocando só linhas `uses:` e o `actions.lock`, e o commit liberado pelo dono na variável
  `PORTAO_LIBERADO_SHA` ([runbook](docs/runbooks/liberar-portao.md)).
- **php**: `composer validate --strict`, `composer audit`, estilo, análise estática, banco de teste, PHPUnit com
  cobertura. Postgres de serviço quando `POSTGRES_VERSION` existe.
- **spec** (quando `SPEC_ENABLED=true`): OpenSpec fixado, skills sem edição manual, regras do `openspec/config.yaml`
  do consumidor chegando às instruções, `validate --strict`, lint da Ozea,
  integridade e conformidade da change entregue no PR.
- **image** (quando `IMAGE_TARGET` existe): Hadolint; **um build** do stage em arquivo OCI; smoke do consumidor;
  Trivy (CRITICAL/HIGH com correção bloqueiam) e SBOM, sobre o mesmo arquivo.
- **ci-ok**: falha se qualquer portão aplicável não terminou em `success`. É o check exigido no consumidor.
- **publish** (só push na branch padrão, depois do `gate`): empurra o mesmo arquivo com `skopeo --preserve-digests`
  nas tags `sha-<40>`, `sha-<7>` e `main`, e falha se o digest publicado for diferente do escaneado.

Nada roda só como aviso. Os limiares moram aqui, não no consumidor.

## Como consumir

`.github/workflows/gate.yml` no consumidor:

```yaml
name: gate
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
permissions: {}
concurrency:
  group: gate-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
jobs:
  gate:
    permissions:
      contents: read
    uses: ozea-labs/esteira/.github/workflows/php-app.yml@<sha> # v0.1.2
  publish:
    needs: gate
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    permissions:
      contents: read
      packages: write
    uses: ozea-labs/esteira/.github/workflows/publish.yml@<sha> # v0.1.2
    with:
      image-name: ${{ needs.gate.outputs.image-name }}
      image-digest: ${{ needs.gate.outputs.image-digest }}
```

Check exigido na `main`: `gate / ci-ok`. A esteira descobre o próprio SHA lendo a linha `uses:` do arquivo de
chamada, então a atualização só troca essa linha (é o que o Dependabot faz). A política exige que todas as chamadas
da esteira usem o mesmo SHA.

O `concurrency` só cancela run de PR. Na branch padrão cada commit roda e publica a própria `sha-<40>`; a tag `main`
só avança se o commit ainda for a cabeça da branch quando o `publish` roda.

`.github/esteira.env` (lido sem `source`; só as chaves conhecidas são aceitas):

```sh
PHP_VERSION=8.4
PHP_EXTENSIONS=pdo_pgsql, intl, bcmath, opcache, redis
POSTGRES_VERSION=16
PHP_DB_PREPARE=bin/console doctrine:database:create --if-not-exists && bin/console doctrine:migrations:migrate --no-interaction --allow-no-migration
PHP_TEST_ENV=APP_ENV=test MESSENGER_TRANSPORT_DSN=doctrine://default?auto_setup=1
SPEC_ENABLED=true
SPEC_PHPUNIT_CMD=php vendor/bin/phpunit -c phpunit.dist.xml
IMAGE_NAME=ghcr.io/ozea-labs/<app>
IMAGE_TARGET=runtime
IMAGE_SMOKE=scripts/quality/image-smoke.sh
```

Chaves: `PHP_VERSION`, `PHP_EXTENSIONS`, `PHP_COVERAGE` (`pcov`, `xdebug`, `none`), `POSTGRES_VERSION`,
`PHP_CS_CMD`, `PHP_STAN_CMD`, `PHP_TEST_CMD`, `PHP_DB_PREPARE`, `PHP_TEST_ENV`, `SPEC_ENABLED`, `SPEC_PHPUNIT_CMD`,
`SPEC_PREPARE_CMD`, `IMAGE_NAME`, `IMAGE_DOCKERFILE`, `IMAGE_CONTEXT`, `IMAGE_TARGET`, `IMAGE_SMOKE`, `IMAGE_SMOKE_REPORT` (diretório
publicado como artefato `smoke-report`, mesmo quando o smoke falha),
`GITLEAKS_CONFIG`, `SEMGREP_EXCLUDES`. No CI, `DATABASE_URL` aponta para o Postgres de serviço.

### Lockfile de actions

O consumidor mantém `.github/workflows/actions.lock`, gerado com SHA nas `uses:`:

```sh
gh extension install github/gh-actions-lock --pin v0.4.1
gh actions-lock --no-narrow
```

`--no-narrow` mantém o SHA na linha `uses:` (com o comentário de versão) e registra o mesmo SHA no lockfile.

Limite: o `gh-actions-lock` v0.4.1 não trava chamadas de workflow reutilizável entre repositórios
(`jobs.<id>.uses`); a entrada do arquivo de chamada no lockfile fica vazia. Essas chamadas são protegidas pelo SHA
de 40 caracteres na linha `uses:` (política de workflows e "Require SHA pinning") e as actions de dentro da esteira
pelo `actions.lock` deste repositório.
O repositório liga "Require actions to be pinned to a full-length commit SHA" e "Require lockfile".

### make gate

No `Makefile` do consumidor (o SHA vem do `gate.yml`, então máquina e CI rodam a mesma versão):

```make
ESTEIRA_SHA := $(shell sed -nE 's|.*ozea-labs/esteira/\.github/workflows/php-app\.yml@([0-9a-f]{40}).*|\1|p' .github/workflows/gate.yml | head -1)
ESTEIRA_DIR := .cache/esteira/$(ESTEIRA_SHA)
ESTEIRA_PHP_RUNNER := docker compose run --rm -T app
$(ESTEIRA_DIR)/Makefile.include:
	mkdir -p $(ESTEIRA_DIR) && curl -fsSL https://codeload.github.com/ozea-labs/esteira/tar.gz/$(ESTEIRA_SHA) | tar -xz --strip-components=1 -C $(ESTEIRA_DIR)
include $(ESTEIRA_DIR)/Makefile.include
```

`.cache/` vai no `.gitignore`. Precisa de Docker, `gh` com a extensão `gh-actions-lock` e, para a etapa de spec,
Node 22 onde o PHP roda.

## Atualizar a esteira

1. PR aqui, com o `self-test` verde (consumidor de exemplo, testes dos checks de spec e casos envenenados).
2. Merge e tag `vX.Y.Z`.
3. O Dependabot de cada consumidor abre o PR que troca o SHA no `gate.yml` e regenera o `actions.lock`. O PR abre
   primeiro no piloto (Receivables); os outros sobem depois que ele fica verde.

Ferramentas: só versões com pelo menos 7 dias. Digest com `docker buildx imagetools inspect <imagem:tag>`.
