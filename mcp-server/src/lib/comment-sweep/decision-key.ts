export function decisionKey(path: string, blob: string): string {
  return `${path}\0${blob}`
}

export function deletionBlob(headBlob: string): string {
  return `deleted:${headBlob}`
}
