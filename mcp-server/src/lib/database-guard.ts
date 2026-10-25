export type DbVerdict = { ok: true } | { ok: false; reason: string }

const OK: DbVerdict = { ok: true }
function refuse(reason: string): DbVerdict {
  return { ok: false, reason }
}

interface SqlDialectReading {
  backslashEscapes: boolean
  hashComments: boolean
  dashNeedsSpace: boolean
}

const READINGS: readonly SqlDialectReading[] = [true, false].flatMap((backslashEscapes) =>
  [true, false].flatMap((hashComments) => [false, true].map((dashNeedsSpace) => ({ backslashEscapes, hashComments, dashNeedsSpace }))),
)

export function stripSql(sql: string, reading: SqlDialectReading = READINGS[0]!): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]!
    const two = sql.slice(i, i + 2)
    if (two === '--' && (!reading.dashNeedsSpace || /^\s?$/.test(sql[i + 2] ?? ''))) {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl
      continue
    }
    if (c === '#' && reading.hashComments) {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl
      continue
    }
    if (two === '/*') {
      const bang = /^\/\*!(?:\d+)?/.exec(sql.slice(i))
      if (bang) {
        out += ' '
        i += bang[0].length
        continue
      }
      const end = sql.indexOf('*/', i + 2)
      out += ' '
      i = end === -1 ? sql.length : end + 2
      continue
    }
    if (c === '*' && sql[i + 1] === '/') {
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === '\\' && reading.backslashEscapes) {
          j += 2
          continue
        }
        if (sql[j] === c && sql[j + 1] === c) {
          j += 2
          continue
        }
        if (sql[j] === c) break
        j++
      }
      out += ' '
      i = j + 1
      continue
    }
    const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i))
    if (dollar) {
      const tag = dollar[0]
      const end = sql.indexOf(tag, i + tag.length)
      out += ' '
      i = end === -1 ? sql.length : end + tag.length
      continue
    }
    out += c
    i++
  }
  return out
}

const WRITE_ANYWHERE =
  /\b(insert|update|delete|merge|upsert|drop|truncate|alter|create|rename|grant|revoke|call|do|exec|execute|copy|import|vacuum|reindex|analyze|analyse|checkpoint|discard|lock|unlock|flush|reset|purge|kill|shutdown|restore|backup|attach|detach|reassign|setval|nextval|lo_import|lo_export|dblink|dbms_\w*|utl_\w*|xp_cmdshell|sp_executesql|bulk|outfile|dumpfile|load_file|pg_read_\w*|pg_ls_\w*|pg_write_\w*|writefile)\b/i
const READ_LEADERS =
  /^\s*(select|show|explain|describe|desc|with|values|table|pragma|use|begin|start|commit|rollback|end|savepoint|release|set|reset)\b/i
const PSQL_READ_META = /^(d\w*|l|z|sf|sv|conninfo|encoding|echo|echon|qecho|x|timing|pset|a|t|h|copyright|errverbose|watch|list|q|c|connect|\?)$/
const MYSQL_LINE_COMMAND = /^(system|source|tee|pager|edit|delimiter)\b/i
const PRAGMA_READ = /^pragma\s+(?:\w+\.)?(table_info|table_xinfo|table_list|index_list|index_info|index_xinfo|foreign_key_list|foreign_key_check|integrity_check|quick_check|compile_options|database_list|collation_list|function_list|module_list|pragma_list)\s*\(/i
const SET_SAFE =
  /^\s*set\s+(session\s+|local\s+|global\s+|@|@@session|@@global)?\s*(search_path|time\s*zone|timezone|statement_timeout|lock_timeout|idle_in_transaction_session_timeout|client_encoding|datestyle|names|autocommit|sql_safe_updates|role|session\s+authorization|application_name|work_mem|enable_\w+|transaction|standard_conforming_strings|bytea_output|foreign_key_checks|unique_checks)\b/i

function lineCommandVerdict(line: string): DbVerdict | null {
  if (line.startsWith('.')) {
    const dot = line.split(/\s+/)[0]!.toLowerCase()
    return SQLITE_READ_DOT.has(dot) ? OK : refuse(`the client command ${dot} is not a known read-only command`)
  }
  if (line.startsWith(':')) return refuse('an sqlcmd command (:r, :!!, :setvar …) reads a file or runs a shell')
  if (MYSQL_LINE_COMMAND.test(line)) return refuse(`the client command ${line.split(/\s+/)[0]} runs a shell, reads a file or changes how statements are read`)
  return null
}

function splitStatements(text: string): DbVerdict | string[] {
  const parts: string[] = []
  let current = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === ';') {
      parts.push(current)
      current = ''
      i++
      continue
    }
    if (c !== '\\') {
      current += c === '\n' ? ' ' : c
      i++
      continue
    }
    const meta = /^\\([A-Za-z]+|[!?\\.])/.exec(text.slice(i))
    if (!meta) {
      current += c
      i++
      continue
    }
    const name = meta[1]!
    parts.push(current)
    current = ''
    i += meta[0].length
    if (name === '\\' || name === 'g' || name === 'G' || name === 'gx') continue
    if (!PSQL_READ_META.test(name)) return refuse(`the client meta-command \\${name} runs a shell, reads or writes a file, or is not a known read-only command`)
    while (i < text.length && text[i] !== '\n' && !(text[i] === '\\' && text[i + 1] === '\\')) i++
  }
  parts.push(current)
  return parts
}

export function statementVerdict(sql: string): DbVerdict {
  for (const reading of READINGS) {
    const lines: string[] = []
    for (const raw of stripSql(sql, reading).split('\n')) {
      const line = raw.trim()
      if (/^go(?:\s+\d+)?$/i.test(line)) {
        lines.push(';')
        continue
      }
      const command = lineCommandVerdict(line)
      if (command === null) lines.push(line)
      else if (!command.ok) return command
    }
    const parts = splitStatements(lines.join('\n'))
    if (!Array.isArray(parts)) return parts
    for (const p of parts.map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x !== '')) {
      const v = oneStatement(p)
      if (!v.ok) return v
    }
  }
  return OK
}

function oneStatement(s: string): DbVerdict {
  if (/^set\b/i.test(s)) return SET_SAFE.test(s) ? OK : refuse('it changes a server or session setting')
  if (/^show\s+create\b/i.test(s)) return WRITE_ANYWHERE.test(s.replace(/^show\s+create\b/i, '')) ? refuse('it contains a data- or schema-changing keyword') : OK
  if (/^pragma\b/i.test(s) && (/=/.test(s) || (/\(/.test(s) && !PRAGMA_READ.test(s)))) return refuse('the PRAGMA changes a database setting')
  if (/^(select|with)\b[\s\S]*\binto\s+(?!@|:|strict\b|temp\w*\b)[`"\w]/i.test(s)) return refuse('SELECT … INTO creates a table or writes a file')
  if (/\bfor\s+(update|no\s+key\s+update|share|key\s+share)\b/i.test(s)) return refuse('it locks rows (FOR UPDATE/SHARE)')
  if (/^explain\b/i.test(s)) {
    const inner = s.replace(/^explain\s*(\([^)]*\)\s*)?/i, '')
    return WRITE_ANYWHERE.test(inner) ? refuse('EXPLAIN of a data-changing statement') : OK
  }
  if (!READ_LEADERS.test(s)) return refuse('the guard cannot confirm the statement only reads')
  if (WRITE_ANYWHERE.test(s)) return refuse('it contains a data- or schema-changing keyword')
  return OK
}

const REDIS_WRITE = new Set([
  'set', 'setex', 'setnx', 'psetex', 'getset', 'getdel', 'append', 'setrange', 'incr', 'incrby', 'incrbyfloat', 'decr',
  'decrby', 'del', 'unlink', 'expire', 'pexpire', 'expireat', 'pexpireat', 'persist', 'rename', 'renamenx', 'move', 'copy',
  'restore', 'migrate', 'flushall', 'flushdb', 'swapdb', 'hset', 'hsetnx', 'hmset', 'hincrby', 'hincrbyfloat', 'hdel',
  'lpush', 'rpush', 'lpushx', 'rpushx', 'lpop', 'rpop', 'lset', 'linsert', 'lrem', 'ltrim', 'rpoplpush', 'lmove', 'blpop',
  'brpop', 'sadd', 'srem', 'spop', 'smove', 'sinterstore', 'sunionstore', 'sdiffstore', 'zadd', 'zincrby', 'zrem',
  'zremrangebyscore', 'zremrangebyrank', 'zremrangebylex', 'zpopmin', 'zpopmax', 'xadd', 'xdel', 'xtrim', 'xsetid',
  'xgroup', 'geoadd', 'pfadd', 'pfmerge', 'setbit', 'bitop', 'bitfield', 'eval', 'evalsha', 'eval_ro', 'fcall',
  'function', 'script', 'config', 'shutdown', 'bgrewriteaof', 'bgsave', 'save', 'debug', 'cluster', 'failover', 'reset',
  'flushslots', 'slaveof', 'replicaof', 'acl',
])
const REDIS_STORE_VERBS = new Set(['sort', 'georadius', 'georadiusbymember'])
const REDIS_READ_SUBVERBS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['config', new Set(['get', 'help'])],
  ['cluster', new Set(['info', 'nodes', 'slots', 'shards', 'myid', 'myshardid', 'links', 'countkeysinslot', 'getkeysinslot', 'keyslot', 'help'])],
  ['acl', new Set(['whoami', 'list', 'users', 'getuser', 'cat', 'log', 'help'])],
  ['function', new Set(['list', 'dump', 'stats', 'help'])],
  ['script', new Set(['exists', 'help'])],
])

export function redisVerdict(args: string[], piped: boolean): DbVerdict {
  const words: string[] = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!
    if (a === '--eval') return refuse('redis-cli --eval runs an arbitrary Lua script')
    if (a === '-x' || a === '--pipe') return refuse('redis-cli reads the command from stdin, which the guard cannot read')
    if (a.startsWith('-')) {
      if (/^-(n|u|a|h|p|s|t|r|i|D|-user|-pass|-cacert|-cert|-key|-sni|-cacertdir|-cluster-\w+)$/.test(a)) k++
      continue
    }
    words.push(a)
  }
  const verb = (words[0] ?? '').toLowerCase()
  if (verb === '') return piped ? refuse('redis-cli reads its commands from a pipe or file, which the guard cannot read') : OK
  const sub = (words[1] ?? '').toLowerCase()
  const rest = words.slice(1).map((w) => w.toLowerCase())
  if (REDIS_READ_SUBVERBS.get(verb)?.has(sub)) return OK
  if (REDIS_WRITE.has(verb)) return refuse(`redis '${verb}' changes data`)
  if (REDIS_STORE_VERBS.has(verb) && rest.some((w) => w === 'store' || w === 'storedist')) return refuse(`redis '${verb} … STORE' writes a key`)
  if (verb === 'getex' && rest.some((w) => /^(ex|px|exat|pxat|persist)$/.test(w))) return refuse("redis 'getex' with an expiry option changes a key")
  return OK
}

const MONGO_WRITE =
  /\.(insert\w*|update\w*|delete\w*|remove|replaceone|save|bulkwrite|findoneand(update|delete|replace)|findandmodify|drop\w*|create(collection|index\w*|view)|renamecollection|reindex|dropdatabase|deletemany|deleteone|updatemany|updateone|insertmany|insertone|mapreduce)\s*\(/i
const MONGO_AGG_WRITE = /\$(out|merge)\b/i
const MONGO_COMMAND = /\.(runcommand|admincommand)\s*\(/i
const MONGO_COMPUTED_WRITE = /\[\s*['"`](insert|update|delete|remove|replace|save|bulkwrite|findoneand|drop|create|rename|reindex|mapreduce)\w*['"`]\s*\]/i
export function mongoVerdict(js: string): DbVerdict {
  if (MONGO_WRITE.test(js) || MONGO_AGG_WRITE.test(js) || MONGO_COMPUTED_WRITE.test(js)) return refuse('the mongosh script changes data')
  if (MONGO_COMMAND.test(js)) return refuse('the mongosh script sends a database command, which can change data')
  if (/\b(?:require|eval)\s*\(|\bchild_process\b|\bprocess\.|\bFunction\s*\(/.test(js)) return refuse('the mongosh script runs code the guard cannot read')
  return OK
}

export const SQLITE_READ_DOT = new Set([
  '.schema', '.tables', '.databases', '.indexes', '.indices', '.fullschema', '.show', '.dump', '.mode', '.headers',
  '.nullvalue', '.width', '.help', '.version', '.print', '.echo', '.timer', '.explain', '.stats', '.separator', '.quit',
  '.exit', '.expert', '.changes', '.eqp', '.lint',
])

export interface ClientSpec {
  mode: 'sql' | 'redis' | 'mongo' | 'sqlite'
  sqlFlags?: RegExp
  attachedSql?: RegExp
  unreadable?: RegExp
}

export const DB_CLIENTS: ReadonlyMap<string, ClientSpec> = new Map([
  ['psql', { mode: 'sql', sqlFlags: /^(-[^dhpUFPoTRLvw]*c|--command)$/, attachedSql: /^(?:-c|--command=)([\s\S]+)$/, unreadable: /^(-[A-Za-z]*f|--file|--file=.*)$/ }],
  ['mysql', { mode: 'sql', sqlFlags: /^(-[^uphPSD]*e|--execute|--init-command)$/, attachedSql: /^(?:-e|--execute=|--init-command=)([\s\S]+)$/ }],
  ['mariadb', { mode: 'sql', sqlFlags: /^(-[^uphPSD]*e|--execute|--init-command)$/, attachedSql: /^(?:-e|--execute=|--init-command=)([\s\S]+)$/ }],
  ['mysqlsh', { mode: 'sql', sqlFlags: /^(-[^uphPSD]*e|--execute)$/, attachedSql: /^(?:-e|--execute=)([\s\S]+)$/, unreadable: /^(-f|--file|--js|--py|--python)$/ }],
  ['sqlite3', { mode: 'sqlite', unreadable: /^(-init|-cmd)$/ }],
  ['sqlite', { mode: 'sqlite', unreadable: /^(-init|-cmd)$/ }],
  ['mongosh', { mode: 'mongo', sqlFlags: /^(--eval|-e)$/, attachedSql: /^(?:--eval=)([\s\S]+)$/, unreadable: /^(-f|--file)$/ }],
  ['mongo', { mode: 'mongo', sqlFlags: /^(--eval|-e)$/, attachedSql: /^(?:--eval=)([\s\S]+)$/ }],
  ['redis-cli', { mode: 'redis' }],
  ['valkey-cli', { mode: 'redis' }],
  ['cqlsh', { mode: 'sql', sqlFlags: /^(-e|--execute)$/, attachedSql: /^(?:--execute=)([\s\S]+)$/, unreadable: /^(-f|--file)$/ }],
  ['clickhouse-client', { mode: 'sql', sqlFlags: /^(-q|--query)$/, attachedSql: /^(?:-q|--query=)([\s\S]+)$/, unreadable: /^(--queries-file)$/ }],
  ['sqlcmd', { mode: 'sql', sqlFlags: /^(-Q|-q)$/, attachedSql: /^(?:-Q|-q)([\s\S]+)$/, unreadable: /^-i$/ }],
  ['mssql-cli', { mode: 'sql', sqlFlags: /^(-Q|--query)$/, attachedSql: /^(?:--query=)([\s\S]+)$/, unreadable: /^(-i|--input-file)$/ }],
  ['usql', { mode: 'sql', sqlFlags: /^(-c|--command)$/, attachedSql: /^(?:-c|--command=)([\s\S]+)$/, unreadable: /^(-f|--file)$/ }],
])

export const WRANGLER_D1: ClientSpec = { mode: 'sql', sqlFlags: /^--command$/, attachedSql: /^--command=([\s\S]+)$/, unreadable: /^--file(=.*)?$/ }

export interface ToolSpec {
  refuse?: ReadonlySet<string>
  refusePrefix?: readonly string[]
  readOnlyFlags?: ReadonlySet<string>
}
const SEQUELIZE: ToolSpec = { refuse: new Set(['db:migrate', 'db:migrate:undo', 'db:migrate:undo:all', 'db:seed', 'db:seed:all', 'db:seed:undo', 'db:seed:undo:all', 'db:drop', 'db:create']) }
const TYPEORM: ToolSpec = { refuse: new Set(['migration:run', 'migration:revert', 'schema:sync', 'schema:drop', 'query']) }
const MYSQL_ADMIN: ToolSpec = {
  refuse: new Set([
    'drop', 'create', 'shutdown', 'kill', 'password', 'reload', 'refresh', 'flush-hosts', 'flush-logs', 'flush-privileges',
    'flush-tables', 'flush-threads', 'flush-status', 'start-replica', 'stop-replica', 'start-slave', 'stop-slave',
  ]),
}
const MIKRO_ORM: ToolSpec = { refuse: new Set(['migration:up', 'migration:down', 'migration:fresh', 'schema:drop', 'schema:fresh', 'schema:update', 'schema:create', 'seeder:run']) }
export const MIGRATION_TOOLS: ReadonlyMap<string, ToolSpec> = new Map([
  ['prisma', { refusePrefix: ['migrate dev', 'migrate deploy', 'migrate reset', 'db push', 'db execute', 'db seed'] }],
  ['sequelize', SEQUELIZE],
  ['sequelize-cli', SEQUELIZE],
  ['knex', { refuse: new Set(['migrate:latest', 'migrate:up', 'migrate:down', 'migrate:rollback', 'seed:run']) }],
  ['typeorm', TYPEORM],
  ['typeorm-ts-node-commonjs', TYPEORM],
  ['typeorm-ts-node-esm', TYPEORM],
  ['drizzle-kit', { refuse: new Set(['push', 'migrate', 'drop']) }],
  ['alembic', { refuse: new Set(['upgrade', 'downgrade', 'stamp']), readOnlyFlags: new Set(['--sql']) }],
  ['flyway', { refuse: new Set(['migrate', 'clean', 'undo', 'baseline', 'repair']) }],
  ['dbmate', { refuse: new Set(['up', 'down', 'drop', 'migrate', 'rollback']) }],
  ['goose', { refuse: new Set(['up', 'up-by-one', 'up-to', 'down', 'down-to', 'reset', 'redo']) }],
  ['atlas', { refusePrefix: ['schema apply', 'migrate apply'] }],
  ['node-pg-migrate', { refuse: new Set(['up', 'down', 'redo']) }],
  ['db-migrate', { refuse: new Set(['up', 'down', 'reset']) }],
  ['migrate', { refuse: new Set(['up', 'down', 'drop', 'force', 'goto']) }],
  ['sqlx', { refusePrefix: ['migrate run', 'migrate revert', 'database reset', 'database drop', 'database create'] }],
  ['diesel', { refusePrefix: ['migration run', 'migration revert', 'migration redo', 'database reset', 'database setup', 'database drop'] }],
  ['phinx', { refuse: new Set(['migrate', 'rollback']), refusePrefix: ['seed:run'] }],
  ['supabase', { refusePrefix: ['db reset', 'db push', 'migration up', 'migration repair'] }],
  ['wrangler', { refusePrefix: ['d1 migrations apply', 'd1 delete', 'd1 time-travel restore'] }],
  ['turso', { refusePrefix: ['db destroy'] }],
  ['pscale', { refusePrefix: ['database delete', 'branch delete'] }],
  ['planetscale', { refusePrefix: ['database delete', 'branch delete'] }],
  ['mikro-orm', MIKRO_ORM],
  ['mikro-orm-esm', MIKRO_ORM],
  ['mysqladmin', MYSQL_ADMIN],
  ['mariadb-admin', MYSQL_ADMIN],
])

export const WRITE_PROGRAMS = new Set(['mysqlimport', 'mongoimport', 'mongorestore', 'dropdb', 'createdb', 'vacuumdb', 'reindexdb', 'clusterdb', 'dropuser', 'createuser'])
export const PG_RESTORE_TO_DATABASE = /^(--dbname(=|$)|-[acCelOsvx1]*d)/

export const ARTISAN_REFUSE = new Set([
  'migrate', 'migrate:fresh', 'migrate:refresh', 'migrate:reset', 'migrate:rollback', 'migrate:install', 'db:wipe', 'db:seed',
])
export const ARTISAN_GLOBAL_VALUES: ReadonlySet<string> = new Set(['--env'])
export const ARTISAN_TESTS = new Set(['test', 'dusk'])
export const DJANGO_REFUSE = new Set(['migrate', 'flush', 'loaddata', 'reset_db', 'createcachetable'])
export const DJANGO_READ_FLAGS = /^--(plan|check)$/
export const LARAVEL_TEST = new Set(['phpunit', 'pest', 'paratest'])
export const REPL_COMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['artisan', new Set(['tinker', 'db'])],
  ['rails', new Set(['console', 'c', 'dbconsole', 'db'])],
  ['manage.py', new Set(['shell', 'dbshell', 'shell_plus'])],
  ['flask', new Set(['shell'])],
])

const RAILS_DB_WRITE = ['db:migrate', 'db:rollback', 'db:drop', 'db:create', 'db:reset', 'db:setup', 'db:prepare', 'db:schema:load', 'db:structure:load', 'db:seed', 'db:purge', 'db:truncate_all', 'db:fixtures:load']
export function railsTaskChangesDatabase(task: string): boolean {
  const t = task.toLowerCase()
  if (/:status(:|$)/.test(t)) return false
  return RAILS_DB_WRITE.some((p) => t === p || t.startsWith(p + ':'))
}

export function toolSubVerdict(spec: ToolSpec, args: string[], label: string): DbVerdict {
  const positional = args.filter((a) => !a.startsWith('-')).map((p) => p.toLowerCase())
  if (positional.length === 0) return OK
  if (spec.readOnlyFlags && args.some((a) => spec.readOnlyFlags!.has(a))) return OK
  if (spec.refuse) {
    const hit = positional.find((p) => spec.refuse!.has(p))
    if (hit !== undefined) return refuse(`\`${label} ${hit}\` changes the database`)
  }
  for (const p of spec.refusePrefix ?? []) {
    const [head, ...tail] = p.split(' ')
    if (positional[0] !== head) continue
    let at = 1
    const inOrder = tail.every((word) => {
      const found = positional.indexOf(word, at)
      if (found === -1) return false
      at = found + 1
      return true
    })
    if (inOrder) return refuse(`\`${label} ${p}\` changes the database`)
  }
  return OK
}

export function skipOptions(values: readonly string[], from: number, valueOptions: ReadonlySet<string>): number {
  let k = from
  while (k < values.length && values[k]!.startsWith('-') && values[k] !== '--' && values[k] !== '-') k += valueOptions.has(values[k]!) ? 2 : 1
  return k
}

const CONTAINER_GLOBAL_VALUES = new Set(['-c', '--context', '-H', '--host', '--config', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey', '--connection', '--url', '--identity', '--root', '--runroot', '--storage-driver', '--tmpdir'])
const COMPOSE_GLOBAL_VALUES = new Set(['-f', '--file', '-p', '--project-name', '--env-file', '--profile', '--project-directory', '--ansi', '--progress', '--parallel'])
const COMPOSE_EXEC_VALUES = new Set(['-e', '--env', '-u', '--user', '-w', '--workdir', '--index', '--entrypoint', '--name', '-v', '--volume', '-p', '--publish', '-l', '--label', '--env-from-file', '--pull', '--cap-add', '--cap-drop'])
const CONTAINER_EXEC_VALUES = new Set([
  '-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--detach-keys', '-v', '--volume', '-p', '--publish', '--name', '--network', '--net',
  '--entrypoint', '-l', '--label', '--label-file', '--mount', '--platform', '--pull', '-h', '--hostname', '-m', '--memory', '--cpus', '--restart',
  '--link', '--add-host', '--dns', '--ip', '--volumes-from', '--device', '--gpus', '--log-driver', '--log-opt', '--cap-add', '--cap-drop', '--pod',
])
const COMPOSE_PROGRAMS = new Set(['docker-compose', 'podman-compose'])

function containerSubAt(name: string, values: readonly string[]): number | null {
  if (name !== 'docker' && name !== 'podman') return null
  return skipOptions(values, 0, CONTAINER_GLOBAL_VALUES)
}

function composeSubAt(name: string, values: readonly string[]): number | null {
  if (COMPOSE_PROGRAMS.has(name)) return skipOptions(values, 0, COMPOSE_GLOBAL_VALUES)
  const at = containerSubAt(name, values)
  if (at === null || values[at] !== 'compose') return null
  return skipOptions(values, at + 1, COMPOSE_GLOBAL_VALUES)
}

export function containerCommandAt(name: string, values: readonly string[]): number | null {
  let target: number
  const compose = composeSubAt(name, values)
  if (compose !== null) {
    if (values[compose] !== 'exec' && values[compose] !== 'run') return null
    target = skipOptions(values, compose + 1, COMPOSE_EXEC_VALUES) + 1
  } else {
    const at = containerSubAt(name, values)
    if (at === null) return null
    const sub = values[at] === 'container' ? values[at + 1] : values[at]
    if (sub !== 'exec' && sub !== 'run') return null
    target = skipOptions(values, values[at] === 'container' ? at + 2 : at + 1, CONTAINER_EXEC_VALUES) + 1
  }
  return target < values.length ? target : null
}

const volumeFlag = (args: readonly string[]): boolean =>
  args.some((a) => a === '--volumes' || /^--volumes=(?!false$)/.test(a) || /^-[a-z]*v[a-z]*(=(?!false$).*)?$/.test(a))
export function containerDataLoss(name: string, args: string[]): DbVerdict {
  const low = args.map((a) => a.toLowerCase())
  const compose = composeSubAt(name, low)
  if (compose !== null) {
    const sub = low[compose]
    if ((sub === 'down' || sub === 'rm') && volumeFlag(low.slice(compose + 1))) return refuse('it removes the compose volumes, where a database keeps its data')
    return OK
  }
  const at = containerSubAt(name, low)
  if (at === null) return OK
  const [a, b] = [low[at], low[at + 1]]
  const rest = low.slice(at + 1)
  if (a === 'volume' && (b === 'rm' || b === 'remove' || b === 'prune')) return refuse('it removes container volumes, where a database keeps its data')
  if (a === 'system' && b === 'prune' && volumeFlag(rest)) return refuse('it prunes volumes, where a database keeps its data')
  if (a === 'system' && b === 'reset') return refuse('it removes every container and volume, where a database keeps its data')
  if ((a === 'rm' || (a === 'container' && (b === 'rm' || b === 'remove'))) && volumeFlag(rest)) return refuse("it removes a container's volumes")
  return OK
}
