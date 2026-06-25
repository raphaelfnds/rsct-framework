# CLAUDE.md — RSCT Framework

> Operational notes for contributors and AI agents working **on** this
> repository. For end-user / installer documentation, see
> **[README.md](README.md)**.

---

## Sobre este projeto

Este projeto é a implementação operacional do **RSCT Workflow Framework**,
conforme descrito no artigo de referência:
<https://medium.com/@raphael.fnds/rsct-workflow-framework-turning-ai-into-a-real-engineering-copilot-2f4a44bd7117>.

A proposta é manipular a **memória de projeto do Claude Code** em
conjunto com **preferências do usuário** para conduzir o agente de IA
por roteiros com padrões rígidos — reduzindo retrabalho e maximizando
produtividade em engenharia de software assistida por IA.

A implementação inclui um servidor MCP companion (`rsct-mcp`) cuja
função é **bloquear mecanicamente** as brechas comportamentais que a
IA possa explorar para burlar os padrões estabelecidos ou estender
indevidamente autorizações concedidas para tarefas anteriores
(comportamentos como "já tive OK para commit há 5 minutos, vou commitar
de novo agora", ou "vou pular o plano porque é só um ajuste pequeno").

## Portabilidade cross-OS (Windows / Linux / macOS)

**Toda alteração no projeto — prompts bash, scripts, código do
`rsct-mcp`, templates — deve funcionar sem regressão nos três
sistemas operacionais alvo: Windows (Git Bash / MSYS2), Linux
(qualquer distro com GNU coreutils) e macOS (BSD coreutils, sem
GNU pré-instalado).**

Não é aceitável "funciona no meu Windows" como prova de pronto. As
diferenças que historicamente quebraram o projeto:

| Categoria | Windows (Git Bash) | Linux (GNU) | macOS (BSD) |
|---|---|---|---|
| `grep` alternation | `\|` (BRE GNU ext) | `\|` (BRE GNU ext) | **falha silenciosa** — usar `-E "(a\|b)"` |
| `grep -iF` (case-insens + fixed) | **SIGABRT / core dump** (grep 3.0) — usar `tr`+`case` | OK | OK |
| `sed -i` flag | sem sufixo | sem sufixo | exige `sed -i '' ...` ou Perl |
| CRLF line endings | git autocrlf adiciona `\r` | LF nativo | LF nativo |
| `\b` em `node -e '...'` | MSYS colapsa `\\b` → `\b` (backspace) | shell preserva | shell preserva |
| Tools default | `sha256sum`, `awk` GNU | `sha256sum`, `awk` GNU | `shasum -a 256`, BSD awk |

Pelo menos um dos sistemas é a primeira vez que cada bug
aparece — Windows quase sempre é onde o dev roda primeiro, mas a
falha silenciosa em macOS BSD `grep` (anti-pattern #2 abaixo) é a
classe de bug mais perigosa porque não há mensagem de erro: o
comando "funciona" mas devolve resultado vazio.

**Como aplicar na prática:**

1. **Prefira POSIX puro** sobre extensões GNU. ERE (`-E`) > BRE em
   `grep`/`sed`/`awk`. Char classes (`[|]`) ao invés de escapes (`\|`).
2. **Para SHA / regex `$`-anchored**, sempre `tr -d '\r'` antes do
   pipe (CRLF tolerance — anti-pattern #4 abaixo).
3. **Para `sha256` portable**, usar o helper `sha256_compute()` que
   detecta `sha256sum` / `shasum` / `openssl dgst` (já presente em
   `prompts/01-setup.md` e `prompts/03-uninstall.md`).
4. **Para `\b` em `node -e`**, sempre `String.fromCharCode(92)` para
   construir backslashes em vez de literal `"\\"` (MED-16 / CAP-20).
5. **Antes do ship**, mentalmente (ou via smoke test em sandbox)
   verifique cada um dos três OS — especialmente os patterns que
   acabaram de mudar.

Histórico de quebras cross-OS que motivaram esta regra:
CAP-10/16 (CRLF), CAP-17 (sed delimiter BSD), CAP-18 (BRE `\|`),
CAP-20 (escape level em `node -e`), CAP-21 (BRE `\|` Phase 1.8).

## Acréscimo ao ciclo original — fase V (Verification)

O ciclo original do artigo é **R → S → C → T**
(Research → Specification → Code → Test).

Esta implementação introduz uma fase intermediária **V (Verification)**
entre Specification e Code:

```
R → S → V → C → T
```

Após a aprovação da especificação pelo desenvolvedor, a IA deve
**perguntar explicitamente** se ele deseja uma varredura em nível de
auditoria contra a especificação aprovada — buscando brechas, possíveis
bugs, detalhes que passaram batido, redundâncias, inconsistências ou
gaps.

Se o desenvolvedor aprovar a varredura e ela encontrar itens
relevantes, a especificação (ou plano) deve ser **ajustada** antes do
início da fase Code. A fase V é parte da camada mecânica via
`rsct_phase_verification_start` / `_complete` no `rsct-mcp`.

## Acréscimo ao ciclo — fase REVIEW (code review)

Após a fase Code, esta implementação introduz uma fase **REVIEW** (revisão
do código produzido) entre Code e Test:

```
R → S → V → C → REVIEW → T
```

A distinção em relação à fase V: a **V audita a especificação/plano**
(antes de escrever código); a **REVIEW audita o código/diff já escrito**
(antes dos testes) — buscando bugs de correção, brechas de segurança,
regressões e quebras cross-OS no que foi efetivamente implementado.

A decisão é **perguntada uma única vez**, no fechamento da especificação:
a IA recomenda **fortemente** incluir um code review antes dos testes e o
desenvolvedor escolhe sim/não (parâmetro `include_review` em
`rsct_phase_spec_complete`). A escolha é gravada e **não é re-perguntada**;
se recusada, a REVIEW **não é executada**. Para tarefas `standard` e
`complex`, a fase Test não inicia até a decisão ser honrada — a revisão é
mecânica via `rsct_phase_review_start` / `_complete`, com um gate em
`rsct_phase_test_start` (tarefas `trivial`/`small` dispensam a REVIEW). Não
confundir a fase REVIEW com `rsct_persona_review` (uma lente consultiva,
sem estado).

## Regra de edição deste arquivo

Este `CLAUDE.md` é mantido por **desenvolvedores e contribuidores** do
projeto e recebe entradas progressivas sobre o que funciona, o que não
funciona, decisões de design, armadilhas conhecidas e contexto
acumulado.

**A IA não pode adicionar, modificar ou remover qualquer conteúdo
deste arquivo sem solicitação ou aprovação explícita** de um
desenvolvedor ou contribuidor identificado. A IA pode propor sugestões
de edição em chat para revisão, mas a escrita só deve ocorrer após
autorização explícita por ação — autorizações genéricas ("você pode
mexer no CLAUDE.md") não cobrem mudanças futuras; cada edição requer
um OK específico.

## Leitura recomendada

Para detalhes operacionais completos do framework — instalação,
comandos slash (`/rsct-setup`, `/rsct-init-universe`,
`/rsct-canonical-source`, `/rsct-uninstall`), estrutura do repositório,
catálogo das ferramentas do `rsct-mcp`, fluxo de uso e estado de
versão — consulte o **[README.md](README.md)** na raiz do projeto.

---

## Padrões a evitar nos prompts bash (anti-regressões)

Erros recorrentes em ciclos de fix anteriores são listados aqui para
não voltar a ocorrer. Qualquer agente / contribuidor escrevendo bash
nos prompts (`prompts/*.md`) deve revisar esta seção antes de propor
mudanças que envolvem loops, regex, ou substituição de placeholders.

### 1. `| while` com contadores ou variáveis externas — PROIBIDO

```bash
# ❌ NÃO usar — variáveis modificadas dentro do loop são perdidas
cmd | while read x; do COUNT=$((COUNT + 1)); done
echo "$COUNT"   # imprime 0 mesmo se o loop processou N linhas

# ✅ Forma correta — process substitution mantém o while no shell pai
while read x; do COUNT=$((COUNT + 1)); done < <(cmd)
echo "$COUNT"   # imprime N
```

Razão: `| while` executa o lado direito do pipe em um **subshell**;
qualquer variável modificada dentro morre quando o subshell termina.
Histórico:
- CAP-13 (v0.6.7) caiu nisso na Phase 4.6 additive-merge.
- CAP-19 (v0.7.4) reintroduziu na Phase 4.5/4.5b/4.6 OUT_OF_SCOPE
  scan e foi pego em auditoria antes do ship.

### 2. Alternation `\|` em BRE — usar ERE `-E`

```bash
# ❌ GNU BRE extension — falha silenciosa em BSD grep (macOS)
grep -q '\[\(APP_NAME\|ORG_SLUG\)\]' file

# ✅ POSIX ERE — portable
grep -qE '\[(APP_NAME|ORG_SLUG)\]' file
```

Histórico: CAP-18 AUDIT-C (v0.7.3).

### 3. `|` como delimiter de sed quando o pattern contém `|` literal

```bash
# ❌ Pattern com `\|` é interpretado como ERE alternation
sed -E 's|<!-- foo \| updated: ...|<!-- foo | updated: NEW|' file
# Match adjacente (qualquer linha com " | updated:") foi mutada!

# ✅ Trocar para `#` delimiter + char class `[|]`
sed -E "s#<!-- foo [|] updated: [0-9-]+( -->)#<!-- foo | updated: NEW\\1#" file
```

Histórico: CAP-17 (v0.7.3) — bug pego na Phase 4.2 Step D do prompt
`01-setup.md` em run real no acme-api.

### 4. CRLF — sempre normalizar antes de regex `$`-anchored ou SHA

```bash
# ❌ Em Windows com autocrlf, $ não casa (resíduo \r)
awk '/^foo$/{ ... }' file

# ✅ Strip CRLF antes
tr -d '\r' < file | awk '/^foo$/{ ... }'
```

Histórico: CAP-10 (SHA pipelines), CAP-16 v0.7.2 (Phase 4.4b backfill).

### 5. JSON.parse → JSON.stringify em arquivos managed — PROIBIDO

`JSON.parse` + `JSON.stringify(json, null, 2)` reformata o arquivo
inteiro (whitespace, key order). Histórico CAP-9 → CAP-15:
acme-app install reformatou `.rsct.json` colateralmente,
introduzindo diff cosmético que escondeu mudanças reais.

Exceção documentada: `.claude/settings.json` install/scrub
(`01-setup.md` Phase 4.V.c e `03-uninstall.md` Phase 4.V.a) **e
`.mcp.json` project-scope** (`01-setup.md` Phase 4.V.c2 e
`03-uninstall.md` Phase 4.V.a2 — CAP-48/49/50) onde o merge
estruturado é obrigatório porque a entrada aninha em
`mcpServers.<nome>` — esses blocos carregam o comentário
`EXCEPTION: structured merge required`. No `.mcp.json` a própria chave
do servidor (`"rsct"` sob `"mcpServers"`) é o marcador; o uninstall
limpa por chave, nunca por padrão de nome.

Para `.rsct.json`: sempre `sed -i in-place` ou Node text-splice
(sem JSON.parse global). Histórico: CAP-15 P0 #1 e P0 #4.

### 6. Variáveis fantasma — sempre definir antes do uso

Antes de referenciar uma variável dentro de um bloco bash, garantir
que ela é populada pela Phase anterior ou fornecer fallback seguro
(`${VAR:-default}`). Variável não-definida vira string vazia silenciosa
e quebra loops/comparações sem mensagem de erro útil.

Histórico: CAP-18 AUDIT-A (v0.7.3) — primeira versão do loop
introduzia `SECTIONS_TO_REMOVE` sem fallback; loop rodaria vazio
em silêncio e o uninstall ficaria broken sem aviso.

### 7. `grep -iF` (case-insensitive + fixed-string) — CRASHA no Git Bash

A combinação das flags `-i` **e** `-F` no **GNU grep 3.0** que
acompanha o Git Bash (MSYS2/MinGW) provoca **SIGABRT / core dump**
(`Aborted — core dumped`, rc=134) — de forma **determinística, com
qualquer entrada** — e ainda deixa um `grep.exe.stackdump` no
diretório.

```bash
# ❌ CRASHA no Git Bash (grep 3.0) — qualquer ordem: -iF, -Fi, -qiF
ls "$DIR" | grep -iF "$NEEDLE"

# ✅ POSIX puro, case-insensitive, sem grep — tr (case-fold) + case glob
NEEDLE_LC=$(printf '%s' "$NEEDLE" | tr 'A-Z' 'a-z')
for c in "$DIR"/*/; do
  [ -d "$c" ] || continue
  c_lc=$(printf '%s' "$(basename "$c")" | tr 'A-Z' 'a-z')
  case "$c_lc" in *"$NEEDLE_LC"*) echo "$c" ;; esac
done
```

Só a **combinação** `-i`+`-F` quebra; `-iE`, `-qiE`, `-qF`, `-qxF`
e `-F`/`-i` isolados funcionam normalmente. Quando precisar de
case-insensitive + fixed-string, normalize o case com `tr` e use
`-F` (sem `-i`), ou `tr` + `case` glob (zero dependência de grep).

Histórico: CAP-41 (v0.7.13) — a linha `ls | grep -iF "$BASENAME"`
da Phase 1.7 crashava em **todo** run Windows, silenciosamente (era
o tail de um bloco diagnostic-only, então o core-dump passava
despercebido). Pego ao validar o fix de UNC `PROJECT_ENCODED` (B2 do
field-report WSL2-from-Windows). Trocada por `tr`+`case`.

### Regra-mãe

**Toda mudança em bash dentro de prompts/*.md** deve incluir:
1. Smoke test que exercita contadores / variáveis externas após o
   bloco.
2. Verificação cross-OS quando aplicável (GNU vs BSD: sed, grep,
   awk).
3. Sanity check pós-mutação (`if grep -q ... ; then echo OK; else
   echo ERROR >&2; exit 1; fi`).

Se a mudança não cabe em smoke test, ela provavelmente está
violando algum dos padrões acima.
