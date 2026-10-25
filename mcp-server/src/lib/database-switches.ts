import { defaultPackageReader, findUp, parsePackage, type PackageReader } from './package-scripts.js'

export interface DatabaseSwitches {
  database: boolean
  test: boolean
}

const ON: DatabaseSwitches = { database: true, test: true }

export function readDatabaseSwitches(start: string, reader: PackageReader = defaultPackageReader): DatabaseSwitches {
  const found = findUp(start, '.rsct.json', reader)
  if (found === null) return ON
  const parsed = parsePackage(found.path, found.read)
  if (!parsed.ok) return ON
  return { database: parsed.json.database_guard !== false, test: parsed.json.database_test_guard !== false }
}
