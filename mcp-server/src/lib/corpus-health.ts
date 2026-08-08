/**
 * #49 / #58 — is a knowledge-corpus file's EMPTY result trustworthy?
 *
 * `exists && zero entries` means "nothing recorded" only when the file was actually
 * read and holds nothing id-shaped. The other two cases are misses, and reporting a
 * miss as a clean zero is the failure both issues were filed for: `adrs_count: 0` on
 * a project holding dozens of ADRs, and an anti-decisions corpus that no upstream
 * tool reports at all.
 *
 * The predicate lives here because four tools answer this same question —
 * `rsct_load_context`, `rsct_get_decisions`, `rsct_check_premise` and the V-phase
 * checklist — and a third miss mode should be added in one place, not four. The
 * WORDING deliberately stays per-tool: "premises_count/adrs_count", "zero corpus to
 * check against" and "scanned counts" are not the same sentence, and flattening them
 * into one string would cost more clarity than the duplication does.
 *
 * Structural parameter rather than a union of the two snapshot types: the id flags
 * are named per corpus (`has_decision_ids`, `has_entry_ids`), and a caller that has
 * to spell out which count it means is a caller that cannot pass the wrong one.
 */
export type CorpusMiss = 'unreadable' | 'ids-unparsed' | null

export function corpusMiss(input: {
  read_error: boolean
  has_ids: boolean
  parsed_count: number
}): CorpusMiss {
  if (input.read_error) return 'unreadable'
  if (input.has_ids && input.parsed_count === 0) return 'ids-unparsed'
  return null
}
