export type AllowlistFamily = 'script' | 'python' | 'php' | 'java' | 'css' | 'sql_mysql' | 'sql_postgresql' | 'html'

const MAX_DIRECTIVE_BODY = 400

const RULE_LIST = String.raw`[@\w/.-]+(?:\s*,\s*[@\w/.-]+)*`
const WEBPACK_VALUE = String.raw`(?:"[\w./\[\]-]{1,100}"|'[\w./\[\]-]{1,100}'|true|false|\d+)`
const PY_TYPE = String.raw`[\w.]+(?:\[[\w., \[\]|]*\])?`
const PHP_TYPE = String.raw`[\w\\\[\]<>|()?:{}.-]+(?:, [\w\\\[\]<>|()?:{}.-]+)*`

const MYSQL_HINTS = [
  'BKA', 'NO_BKA', 'BNL', 'NO_BNL', 'HASH_JOIN', 'NO_HASH_JOIN', 'INDEX', 'NO_INDEX', 'INDEX_MERGE',
  'NO_INDEX_MERGE', 'JOIN_ORDER', 'JOIN_PREFIX', 'JOIN_SUFFIX', 'JOIN_FIXED_ORDER', 'MAX_EXECUTION_TIME',
  'MRR', 'NO_MRR', 'NO_ICP', 'NO_RANGE_OPTIMIZATION', 'QB_NAME', 'RESOURCE_GROUP', 'SEMIJOIN',
  'NO_SEMIJOIN', 'SET_VAR', 'SKIP_SCAN', 'NO_SKIP_SCAN', 'SUBQUERY', 'MERGE', 'NO_MERGE',
  'DERIVED_CONDITION_PUSHDOWN', 'NO_DERIVED_CONDITION_PUSHDOWN', 'GROUP_INDEX', 'NO_GROUP_INDEX',
  'JOIN_INDEX', 'NO_JOIN_INDEX', 'ORDER_INDEX', 'NO_ORDER_INDEX',
].join('|')
const MYSQL_HINT = String.raw`(?:${MYSQL_HINTS})\([\w@.,= \`'-]{0,120}\)`

const SCRIPT: readonly RegExp[] = [
  /^@ts-expect-error$/,
  /^@ts-ignore$/,
  /^@ts-nocheck$/,
  /^@ts-check$/,
  /^<reference\s+(?:path|types|lib|no-default-lib)=(?:"[^"]*"|'[^']*')\s*\/>$/,
  new RegExp(String.raw`^eslint-disable(?:-next-line|-line)?(?:\s+${RULE_LIST})?(?:\s+--\s.{1,120})?$`),
  new RegExp(String.raw`^eslint-enable(?:\s+${RULE_LIST})?$`),
  /^prettier-ignore$/,
  /^istanbul ignore (?:next|if|else|file)$/,
  /^c8 ignore (?:next(?: \d+)?|start|stop)$/,
  /^@vitest-environment [\w-]+$/,
  /^@jsx [\w.]+$/,
  /^@jsxImportSource [@\w/.-]+$/,
  /^[@#]__PURE__$/,
  new RegExp(String.raw`^webpack[A-Za-z]+:\s*${WEBPACK_VALUE}(?:\s*,\s*webpack[A-Za-z]+:\s*${WEBPACK_VALUE})*$`),
  /^@vite-ignore$/,
  /^# sourceMappingURL=\S+$/,
]

const PYTHON: readonly RegExp[] = [
  /^-\*- coding: [\w.-]+ -\*-$/,
  new RegExp(String.raw`^type: (?:ignore(?:\[[\w-]+(?:, ?[\w-]+)*\])?|${PY_TYPE}(?: ?\| ?${PY_TYPE})*)$`),
  /^noqa(?:: ?[A-Z]+\d+(?:, ?[A-Z]+\d+)*)?$/,
  /^pylint: (?:disable|enable)=[\w-]+(?:, ?[\w-]+)*$/,
  /^pyright: (?:ignore(?:\[[\w, ]+\])?|basic|strict|standard|\w+=\w+(?:, ?\w+=\w+)*)$/,
  /^mypy: [\w-]+(?:=(?:"[\w ,.-]{0,100}"|[\w-]+))?(?:, ?[\w-]+(?:=(?:"[\w ,.-]{0,100}"|[\w-]+))?)*$/,
  /^fmt: (?:off|on|skip)$/,
  /^pragma: no cover$/,
  /^isort: (?:skip|skip_file|off|on)$/,
]

const PHP: readonly RegExp[] = [
  /^@(?:phpstan|psalm)-ignore(?:-next-line|-line)?(?: [\w.-]+(?:, ?[\w.-]+)*)?$/,
  new RegExp(
    String.raw`^@(?:phpstan|psalm)-(?:var|param|return|type|import-type|template|extends|implements|use|property|property-read|property-write|method|assert|assert-if-true|assert-if-false|pure|impure|require-extends|require-implements|sealed) ${PHP_TYPE}(?: \$\w+)?$`,
  ),
  /^@(?:phpstan|psalm)-(?:pure|impure|immutable|internal|mutation-free)$/,
  /^phpcs:(?:disable|enable|ignore|ignoreFile)(?:\s+[\w.,]+)?$/,
]

const JAVA: readonly RegExp[] = [
  /^CHECKSTYLE:(?:OFF|ON)(?:: ?\w+)?$/,
  /^NOSONAR$/,
  /^@formatter:(?:off|on)$/,
]

const CSS: readonly RegExp[] = [
  new RegExp(String.raw`^stylelint-disable(?:-next-line|-line)?(?:\s+${RULE_LIST})?$`),
  new RegExp(String.raw`^stylelint-enable(?:\s+${RULE_LIST})?$`),
]

const SQL_MYSQL: readonly RegExp[] = [
  new RegExp(String.raw`^\+\s*${MYSQL_HINT}(?:\s+${MYSQL_HINT})*$`),
]

const HTML: readonly RegExp[] = [
  /^\[if [^\]]{1,60}\]>(?:[\s\S]*<!\[endif\])?(?:<!)?$/,
  /^<!\[endif\]$/,
]

const FAMILIES: Readonly<Record<AllowlistFamily, readonly RegExp[]>> = {
  script: SCRIPT,
  python: PYTHON,
  php: PHP,
  java: JAVA,
  css: CSS,
  sql_mysql: SQL_MYSQL,
  sql_postgresql: [],
  html: HTML,
}

export function isAllowlistedBody(family: AllowlistFamily, body: string): boolean {
  if (body.length > MAX_DIRECTIVE_BODY) return false
  return FAMILIES[family].some((pattern) => pattern.test(body))
}

const LICENCE_MARKER = /SPDX-License-Identifier|Copyright (?:\(c\)|©|\d{4})/i
const LICENCE_LINE = /^(?:SPDX-License-Identifier: [\w.+() -]{1,80}|Copyright (?:\(c\) |© )?\d{4}(?:[-–]\d{4})?[^\n]{0,100}|All rights reserved\.?)$/i
export const LICENCE_MAX_LINES = 30

export function isLicenceText(text: string): boolean {
  return LICENCE_MARKER.test(text)
}

export function isLicenceLine(body: string): boolean {
  return LICENCE_LINE.test(body)
}
