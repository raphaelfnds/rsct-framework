const NATIVE_SCHEMES = new Set(['ssh', 'git', 'http', 'https', 'ftp', 'ftps', 'file', 'git+ssh', 'ssh+git'])

export function helperUrl(value: string): boolean {
  if (value.includes('::')) return true
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value)
  return scheme !== null && !NATIVE_SCHEMES.has(scheme[1]!.toLowerCase())
}
