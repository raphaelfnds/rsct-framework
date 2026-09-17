import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { commentBody, scanFile, type ScanOptions, type ScanResult } from '../../src/lib/comment-sweep/index.js'
import { classifyPath } from '../../src/lib/comment-sweep/language.js'
import { lexSqlComments } from '../../src/lib/comment-sweep/sql-lexer.js'
import { locateGrammarsDir, resetTreeEngineForTests } from '../../src/lib/comment-sweep/tree-engine.js'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

async function scan(path: string, source: string, options: ScanOptions = {}): Promise<ScanResult> {
  return scanFile(path, enc(source), options)
}

async function bodies(path: string, source: string, options: ScanOptions = {}): Promise<string[]> {
  const result = await scan(path, source, options)
  if (result.kind !== 'scanned') throw new Error(`expected scanned, got ${JSON.stringify(result)}`)
  return result.comments.map((c) => c.body)
}

describe('comment-sweep language table', () => {
  it('matches extensions case-insensitively and maps variants', () => {
    expect(classifyPath('src/A.TS', null)).toEqual({ bucket: 'supported', language: 'typescript' })
    expect(classifyPath('x.mts', null)).toEqual({ bucket: 'supported', language: 'typescript' })
    expect(classifyPath('types/x.d.ts', null)).toEqual({ bucket: 'supported', language: 'typescript' })
    expect(classifyPath('a.jsx', null)).toEqual({ bucket: 'supported', language: 'javascript' })
    expect(classifyPath('db/001.pgsql', null)).toEqual({ bucket: 'supported', language: 'sql' })
  })

  it('sends unknown extensions to the developer, never to not_code', () => {
    expect(classifyPath('payload.weird', null)).toEqual({ bucket: 'unknown' })
    expect(classifyPath('bin/tool', 'no shebang here')).toEqual({ bucket: 'unknown' })
  })

  it('keeps the closed not_code list', () => {
    expect(classifyPath('README.md', null)).toEqual({ bucket: 'not_code' })
    expect(classifyPath('LICENSE', null)).toEqual({ bucket: 'not_code' })
    expect(classifyPath('config.yaml', null)).toEqual({ bucket: 'not_code' })
  })

  it('reads a CRLF shebang with a BOM on an extension-less file', () => {
    expect(classifyPath('bin/run', '﻿#!/usr/bin/env python3\r')).toEqual({ bucket: 'supported', language: 'python' })
    expect(classifyPath('bin/run', '#!/bin/bash')).toEqual({ bucket: 'unsupported', language: 'shell' })
  })
})

describe('comment-sweep byte checks', () => {
  it('rejects NUL, UTF-16 BOM and invalid UTF-8 before any engine', async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x61, 0x00])
    expect(await scanFile('a.py', utf16)).toMatchObject({ kind: 'unverified', reason: 'binary_or_encoding' })
    expect(await scanFile('a.sql', enc('select 1;\0'), { sqlDialect: 'mysql' })).toMatchObject({
      reason: 'binary_or_encoding',
    })
    expect(await scanFile('a.ts', new Uint8Array([0x63, 0xc3, 0x28]))).toMatchObject({ reason: 'binary_or_encoding' })
  })

  it('strips a UTF-8 BOM and still finds comments', async () => {
    expect(await bodies('a.ts', '﻿const a = 1 // note\n')).toEqual(['note'])
  })
})

describe('comment-sweep tree-sitter engines', () => {
  it('does not read comment markers inside strings, templates or regex', async () => {
    const src = [
      "const u = 'https://example.com/a//b'",
      'const t = `see http://x.y/z // not a comment`',
      'const r = /a\\/\\/b/g',
      'const s = "/* not a block */"',
      'const d = 10 / 2 / 1',
      'const real = 1 // real',
    ].join('\n')
    expect(await bodies('a.ts', src)).toEqual(['real'])
  })

  it('finds # comments in Python but not inside strings', async () => {
    expect(await bodies('a.py', 's = "# no"\nx = 1  # yes\n')).toEqual(['yes'])
  })

  it('finds Java line and block comments', async () => {
    expect(await bodies('A.java', 'class A { /* b */ int x; // l\n}\n')).toEqual(['b', 'l'])
  })

  it('finds PHP comments and inline HTML comments', async () => {
    const src = '<!-- h -->\n<?php\n$a = "# no"; # yes\n// two\n?>\n<p>x</p>\n'
    expect(await bodies('a.php', src)).toEqual(['h', 'yes', 'two'])
  })

  it('finds CSS comments but not inside strings', async () => {
    expect(await bodies('a.css', 'a { content: "/* no */"; } /* yes */\n')).toEqual(['yes'])
  })

  it('turns a parse error into unverified in every grammar', async () => {
    expect(await scan('a.py', 'def (:\n')).toMatchObject({ kind: 'unverified', reason: 'parse_error' })
    expect(await scan('a.css', 'a { color: }}} \n')).toMatchObject({ reason: 'parse_error' })
    expect(await scan('A.java', 'class {{{ \n')).toMatchObject({ reason: 'parse_error' })
    expect(await scan('a.ts', 'const = ;\n')).toMatchObject({ reason: 'parse_error' })
  })

  it('reports line numbers and whitespace-collapsed bodies', async () => {
    const result = await scan('a.ts', 'const a = 1\r\n/*  two\r\n   lines */\r\nconst b = 2\r\n')
    expect(result).toMatchObject({ kind: 'scanned', comments: [{ line: 2, body: 'two lines' }] })
  })
})

describe('comment-sweep HTML', () => {
  it('ignores comment markers inside attributes and textarea', async () => {
    const src = '<a title="<!-- no -->">x</a>\n<textarea><!-- rc --></textarea>\n<div><!-- yes --></div>\n'
    expect(await bodies('a.html', src)).toEqual(['yes'])
  })

  it('finds a comment inside an svg style element', async () => {
    expect(await bodies('a.html', '<svg><style>a{fill:red}<!-- svg-note --></style></svg>\n')).toEqual(['svg-note'])
  })

  it('scans inline script and style with the JS and CSS grammars', async () => {
    const src = '<script>// js\nlet a = "<!-- no -->"</script>\n<style>/* c */</style>\n<!-- h -->\n'
    const result = await scan('a.html', src)
    expect(result).toMatchObject({ kind: 'scanned' })
    if (result.kind !== 'scanned') return
    expect(result.comments.map((c) => [c.body, c.line])).toEqual([
      ['js', 1],
      ['c', 3],
      ['h', 4],
    ])
  })

  it('treats <?xml ?> as an instruction and JSON script as data', async () => {
    expect(await bodies('a.xhtml', '<?xml version="1.0"?>\n<script type="application/ld+json">{"a":1}</script>\n')).toEqual([])
  })

  it('sends an unknown script type to the developer', async () => {
    expect(await scan('a.html', '<script type="text/x-template"><!-- t --></script>')).toMatchObject({
      kind: 'unverified',
      reason: 'unsupported_language',
    })
  })

  it('counts a processing-instruction-shaped note as a comment, and sends CDATA to the developer', async () => {
    expect(await bodies('a.html', '<div><? retry budget is 3 ?></div>\n')).toHaveLength(1)
    expect(await bodies('a.html', '<div><?php echo 1; ?></div>\n')).toEqual([])
    expect(await bodies('a.xhtml', '<?xml-stylesheet href="x.css"?>\n<div>x</div>\n')).toEqual([])
    expect(await scan('a.html', '<div><![CDATA[ x ]]></div>\n')).toMatchObject({ kind: 'unverified', reason: 'parse_error' })
  })
})

describe('comment-sweep SQL lexer', () => {
  const text = (src: string, dialect: 'mysql' | 'postgresql'): string[] => {
    const r = lexSqlComments(src, dialect)
    if (!r.ok) throw new Error('parse error')
    return r.comments.map((c) => src.slice(c.start, c.end))
  }

  it('mysql: -- needs whitespace, # is a comment, backslash escapes', () => {
    expect(text('SELECT 1--1;\nSELECT 2 -- c\n', 'mysql')).toEqual(['-- c'])
    expect(text("SELECT 'it\\'s -- x'; # h\n", 'mysql')).toEqual(['# h'])
    expect(text('SELECT `a--b` FROM t;', 'mysql')).toEqual([])
  })

  it('mysql: /*! */ is executable code, /*+ */ is a comment', () => {
    expect(text('/*!40101 SET NAMES utf8 */; SELECT /*+ BKA(t) */ 1;', 'mysql')).toEqual(['/*+ BKA(t) */'])
  })

  it('postgresql: nested block, # is code, E strings, identifiers with $', () => {
    expect(text('/* a /* b */ c */ SELECT 1;', 'postgresql')).toEqual(['/* a /* b */ c */'])
    expect(text("SELECT a#b, E'x\\' -- no', a$b$ FROM t;", 'postgresql')).toEqual([])
  })

  it('postgresql: lexes plpgsql bodies, refuses other languages with delimiters', () => {
    const plpgsql = 'CREATE FUNCTION f() RETURNS int AS $$\nBEGIN -- inside\nRETURN 1;\nEND $$ LANGUAGE plpgsql;\n'
    expect(text(plpgsql, 'postgresql')).toEqual(['-- inside'])
    const python = 'CREATE FUNCTION f() RETURNS int AS $$\nx = 1 -- 1\n$$ LANGUAGE plpython3u;\n'
    expect(lexSqlComments(python, 'postgresql')).toEqual({ ok: false })
    const quotedLang = "CREATE FUNCTION f() RETURNS int AS $$\nBEGIN -- inside\nEND $$ LANGUAGE 'plpgsql';\n"
    expect(text(quotedLang, 'postgresql')).toEqual(['-- inside'])
    const spoof = "CREATE FUNCTION f(a text DEFAULT 'LANGUAGE sql') RETURNS int AS $$\n# note\n$$ LANGUAGE plpython3u;\n"
    expect(lexSqlComments(spoof, 'postgresql')).toEqual({ ok: false })
    const pythonHash = 'CREATE FUNCTION f() RETURNS int AS $$\nx = 1  # retry budget\nreturn x\n$$ LANGUAGE plpython3u;\n'
    expect(lexSqlComments(pythonHash, 'postgresql')).toEqual({ ok: false })
    const v8 = 'CREATE FUNCTION f() RETURNS int AS $$\nreturn 1 // note\n$$ LANGUAGE plv8;\n'
    expect(lexSqlComments(v8, 'postgresql')).toEqual({ ok: false })
    expect(text("SELECT $q$ plain $q$;", 'postgresql')).toEqual([])
    expect(text("INSERT INTO t VALUES ($$https://example.com/a$$);", 'postgresql')).toEqual([])
    expect(text('SELECT $$#ffffff$$;', 'postgresql')).toEqual([])
  })

  it('unterminated constructs are parse errors', () => {
    expect(lexSqlComments("SELECT 'x", 'postgresql')).toEqual({ ok: false })
    expect(lexSqlComments('/* x', 'mysql')).toEqual({ ok: false })
    expect(lexSqlComments('SELECT $$ x', 'postgresql')).toEqual({ ok: false })
  })

  it('requires a declared dialect', async () => {
    expect(await scan('a.sql', 'select 1; -- c\n')).toMatchObject({ reason: 'sql_dialect_missing' })
    expect(await scan('a.sql', 'select 1; -- c\n', { sqlDialect: 'none' })).toMatchObject({
      reason: 'sql_dialect_missing',
    })
    expect(await bodies('a.sql', 'select 1; -- c\n', { sqlDialect: 'postgresql' })).toEqual(['c'])
  })
})

describe('comment-sweep allowlist', () => {
  it('keeps exact directives and rejects the same directive carrying prose', async () => {
    const ok = await scan('a.ts', '// @ts-expect-error\nconst a: number = "x"\n// eslint-disable-next-line no-console -- debug only\nconsole.log(a)\n')
    expect(ok).toMatchObject({ kind: 'scanned', comments: [] })
    const prose = await scan('a.ts', '// @ts-expect-error the API returns a string here because of legacy\nconst a: number = "x"\n')
    expect(prose).toMatchObject({ kind: 'scanned', comments: [{ line: 1 }] })
  })

  it('keeps a shebang and a short licence header, not a long one', async () => {
    const header = '#!/usr/bin/env node\n// Copyright (c) 2026 Example\n// SPDX-License-Identifier: MIT\nconst a = 1\n'
    expect(await bodies('a.js', header)).toEqual([])
    const long = ['/*', ' * Copyright (c) 2026 Example', ...Array.from({ length: 35 }, () => ' * line'), ' */', 'const a = 1'].join('\n')
    expect((await bodies('a.js', long)).length).toBe(1)
  })

  it('does not treat a comment after code as a licence header', async () => {
    expect(await bodies('a.ts', 'const a = 1\n// Copyright (c) 2026 X\n')).toEqual(['Copyright (c) 2026 X'])
  })

  it('knows the Python, Java, CSS and SQL directives', async () => {
    expect(await bodies('a.py', 'import os  # noqa: F401\nx = 1  # pragma: no cover\n')).toEqual([])
    expect(await bodies('A.java', 'class A { int x; // NOSONAR\n}\n')).toEqual([])
    expect(await bodies('a.css', '/* stylelint-disable color-no-hex */\na { color: #fff; }\n')).toEqual([])
    expect(await bodies('a.sql', 'SELECT /*+ BKA(t) */ 1;', { sqlDialect: 'mysql' })).toEqual([])
  })

  it('does not let prose ride on a directive-shaped comment', async () => {
    expect(await bodies('a.py', 'x = 1  # type: we retry three times because the upstream API throttles\n')).toHaveLength(1)
    expect(await bodies('a.py', 'x: List[int] = []  # type: List[int]\n')).toEqual([])
    expect(await bodies('a.php', '<?php\n// @phpstan-note the retry budget is 3 because upstream throttles\n$a = 1;\n')).toHaveLength(1)
    expect(await bodies('a.php', '<?php\n/** @phpstan-var array<int, string> $a */\n$a = [];\n')).toEqual([])
    expect(await bodies('a.js', 'import(/* webpackChunkName: "retry budget is 3 because" */ "./x")\n')).toHaveLength(1)
    expect(await bodies('a.sql', 'SELECT /*+ NOTE(retry budget is 3) */ 1;', { sqlDialect: 'mysql' })).toHaveLength(1)
    const manyRules = Array.from({ length: 140 }, (_, i) => `rule-${i}`).join(', ')
    expect(await bodies('a.ts', `// eslint-disable-next-line ${manyRules}\nconsole.log(1)\n`)).toHaveLength(1)
    expect(await bodies('a.ts', '// eslint-disable-next-line no-console, no-alert\nconsole.log(1)\n')).toEqual([])
  })

  it('keeps a real licence header, in either comment style', async () => {
    const apache = ['# Copyright (c) Meta Platforms, Inc. and affiliates.', '#', '# Licensed under the Apache License, Version 2.0 (the "License");', '# you may not use this file except in compliance with the License.', 'x = 1'].join('\n')
    expect(await bodies('a.py', apache)).toEqual([])
    const mit = '// Copyright (c) Microsoft Corporation.\n// Licensed under the MIT License.\nconst a = 1\n'
    expect(await bodies('a.ts', mit)).toEqual([])
    const spdx = '// SPDX-FileCopyrightText: 2026 Example\n// SPDX-License-Identifier: MIT\nconst a = 1\n'
    expect(await bodies('a.ts', spdx)).toEqual([])
  })

  it('keeps the PHP and Python directives the analysers actually write', async () => {
    const php = ['<?php', '/** @psalm-suppress MixedAssignment */', '/** @phpstan-var array{id: int, name: string} $row */', '/** @phpstan-param callable(int): bool $cb */', '// @phpstan-ignore argument.type (legacy API)', '$a = 1;'].join('\n')
    expect(await bodies('a.php', php)).toEqual([])
    expect(await bodies('a.py', "x = 1  # type: Literal['r', 'w']\n")).toEqual([])
    expect(await bodies('a.py', 'x = 1  # type: ignore[attr-defined]\n')).toEqual([])
  })

  it('checks a directive-shaped body in bounded time', async () => {
    const started = Date.now()
    const src = `x = 1  # type: ${'a[]|'.repeat(30)}!\n`
    expect(await bodies('a.py', src)).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe('comment-sweep ids', () => {
  it('are stable across line moves and distinguish repeated bodies', async () => {
    const a = await scan('a.ts', '// x\nconst a = 1\n// x\n')
    const b = await scan('a.ts', '\n\n// x\nconst a = 1\n// x\n')
    if (a.kind !== 'scanned' || b.kind !== 'scanned') throw new Error('expected scanned')
    expect(a.comments.map((c) => c.id)).toEqual(b.comments.map((c) => c.id))
    expect(new Set(a.comments.map((c) => c.id)).size).toBe(2)
    expect(commentBody('/** a\n * b */')).toBe('a * b')
  })
})

describe('comment-sweep engine loading', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    resetTreeEngineForTests()
  })

  it('pins the vendored WASM bytes to the manifest', () => {
    const dir = locateGrammarsDir()
    expect(dir).not.toBeNull()
    const manifest = JSON.parse(readFileSync(join(dir!, 'manifest.json'), 'utf8')) as Record<string, { sha256: string }>
    const wasms = readdirSync(dir!).filter((f) => f.endsWith('.wasm')).sort()
    expect(wasms).toEqual(Object.keys(manifest).sort())
    for (const file of wasms) {
      const digest = createHash('sha256').update(readFileSync(join(dir!, file))).digest('hex')
      expect(digest, file).toBe(manifest[file]!.sha256)
    }
  })

  it('degrades to engine_unavailable on a corrupt runtime without killing the process', async () => {
    resetTreeEngineForTests()
    const source = locateGrammarsDir()!
    const dir = mkdtempSync(join(tmpdir(), 'rsct-grammars-'))
    dirs.push(dir)
    for (const f of readdirSync(source)) copyFileSync(join(source, f), join(dir, f))
    writeFileSync(join(dir, 'tree-sitter.wasm'), Buffer.from('not wasm'))
    expect(await scanFile('a.ts', enc('// x\n'), { grammarsDir: dir })).toMatchObject({
      kind: 'unverified',
      reason: 'engine_unavailable',
    })
    expect(await scanFile('a.ts', enc('// x\n'), { grammarsDir: null })).toMatchObject({
      reason: 'engine_unavailable',
    })
  })

  it('does not remember a failed grammar load: a later scan with good grammars works', async () => {
    const source = locateGrammarsDir()!
    const dir = mkdtempSync(join(tmpdir(), 'rsct-grammars-'))
    dirs.push(dir)
    for (const f of readdirSync(source)) copyFileSync(join(source, f), join(dir, f))
    writeFileSync(join(dir, 'tree-sitter-java.wasm'), Buffer.from('not wasm'))
    expect(await scanFile('A.java', enc('class A { int x; // j\n}\n'), { grammarsDir: dir })).toMatchObject({
      reason: 'engine_unavailable',
    })
    expect(await scanFile('A.java', enc('class A { int x; // j\n}\n'), { grammarsDir: source })).toMatchObject({
      kind: 'scanned',
    })
  })

  it('does not remember a grammar that failed to instantiate', async () => {
    const source = locateGrammarsDir()!
    const dir = mkdtempSync(join(tmpdir(), 'rsct-grammars-'))
    dirs.push(dir)
    for (const f of readdirSync(source)) copyFileSync(join(source, f), join(dir, f))
    copyFileSync(join(source, 'tree-sitter.wasm'), join(dir, 'tree-sitter-css.wasm'))
    expect(await scanFile('a.css', enc('a { color: red; } /* c */\n'), { grammarsDir: dir })).toMatchObject({
      reason: 'engine_unavailable',
    })
    expect(await scanFile('a.css', enc('a { color: red; } /* c */\n'), { grammarsDir: source })).toMatchObject({
      kind: 'scanned',
    })
  })
})
