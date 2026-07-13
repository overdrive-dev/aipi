/**
 * When a hashline payload is authored against `read`/`search` output, each
 * line is prefixed with either a hashline-mode line number (`123:`) or, for
 * diff-style echoes, a leading `+`. These helpers detect that and recover
 * the raw text. Two strip modes are exposed:
 *
 * - {@link stripNewLinePrefixes} — opportunistic: strips when the input
 *   clearly carries hashline or diff prefixes, leaves it alone otherwise.
 * - {@link stripHashlinePrefixes} — strict: only strips when every non-empty
 *   content line is hashline-prefixed.
 *
 * These run *before* the tokenizer; they exist because hashline mode is the
 * common case for echoed file content, and erroneously echoed prefixes will
 * otherwise turn every content line into a (malformed) op.
 */
/**
 * Single-pass variant of {@link stripLeadingHashlinePrefixes} that strips at
 * most one leading hashline prefix (`N:`, `>>>N:`, `+N:` etc.) and does NOT
 * loop. Use this when the input carries at most one snapshot prefix (e.g. a
 * bare body row paste from `read` output) — recursive stripping would corrupt
 * content whose own text starts with `digits:`.
 */
export declare function stripOneLeadingHashlinePrefix(line: string): string;
/**
 * Strip whichever prefix scheme the lines appear to be carrying:
 * - hashline line-number prefixes (`123:`) when every content line has one
 * - leading `+` (diff style) when at least half the lines have one
 * - mixed `+<n>:` form when present
 *
 * Returns the lines untouched if no scheme is recognized.
 */
export declare function stripNewLinePrefixes(lines: string[]): string[];
/**
 * Strict variant: strip hashline prefixes only when every content line is
 * hashline-prefixed. Returns the lines unchanged otherwise.
 */
export declare function stripHashlinePrefixes(lines: string[]): string[];
/**
 * Normalize line payloads by stripping read/search line prefixes. `null` /
 * `undefined` yield `[]`; a single multiline string is split on `\n`.
 */
export declare function hashlineParseText(edit: string[] | string | null | undefined): string[];
