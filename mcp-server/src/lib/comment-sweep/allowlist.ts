export type AllowlistFamily = 'script' | 'python' | 'php' | 'java' | 'css' | 'sql_mysql' | 'sql_postgresql' | 'html'

const RULE_LIST = String.raw`[@\w/.-]+(?:\s*,\s*[@\w/.-]+)*`

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
  /^webpack[A-Za-z]+:\s*(?:"[^"]{0,100}"|'[^']{0,100}'|true|false|\d+)(?:\s*,\s*webpack[A-Za-z]+:\s*(?:"[^"]{0,100}"|'[^']{0,100}'|true|false|\d+))*$/,
  /^@vite-ignore$/,
  /^# sourceMappingURL=\S+$/,
]

const PYTHON: readonly RegExp[] = [
  /^-\*- coding: [\w.-]+ -\*-$/,
  /^type: [\w[\], .|()*'"-]{1,120}$/,
  /^noqa(?:: ?[A-Z]+\d+(?:, ?[A-Z]+\d+)*)?$/,
  /^pylint: (?:disable|enable)=[\w-]+(?:, ?[\w-]+)*$/,
  /^pyright: (?:ignore(?:\[[\w, ]+\])?|basic|strict|standard|\w+=\w+(?:, ?\w+=\w+)*)$/,
  /^mypy: [\w-]+(?:=(?:"[^"]{0,100}"|[\w,-]+))?(?:, ?[\w-]+(?:=(?:"[^"]{0,100}"|[\w,-]+))?)*$/,
  /^fmt: (?:off|on|skip)$/,
  /^pragma: no cover$/,
  /^isort: (?:skip|skip_file|off|on)$/,
]

const PHP: readonly RegExp[] = [
  /^@(?:phpstan|psalm)-[\w-]+(?: [^\n]{1,120})?$/,
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
  /^\+\s*[A-Za-z_]+\s*\([^()]*\)(?:\s+[A-Za-z_]+\s*\([^()]*\))*$/,
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
  return FAMILIES[family].some((pattern) => pattern.test(body))
}

const LICENCE_MARKER = /SPDX-License-Identifier|Copyright (?:\(c\)|©|\d{4})/i
export const LICENCE_MAX_LINES = 30

export function isLicenceText(text: string): boolean {
  return LICENCE_MARKER.test(text)
}
