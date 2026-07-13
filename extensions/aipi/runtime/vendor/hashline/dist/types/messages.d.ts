/** Centralized error/warning text for the hashline parser, applier, and patcher. */
/** Lines of context shown either side of a hash mismatch. */
export declare const MISMATCH_CONTEXT = 2;
/**
 * Numbered `LINE:TEXT` rows around `anchorLines` (±{@link MISMATCH_CONTEXT}),
 * `*`-marking anchors, `...` between non-adjacent runs. Out-of-range anchors
 * contribute no rows.
 */
export declare function formatAnchoredContext(anchorLines: readonly number[], fileLines: readonly string[]): string[];
/** Optional patch envelope start marker; silently consumed. */
export declare const BEGIN_PATCH_MARKER = "*** Begin Patch";
/** Optional patch envelope end marker; terminates parsing. */
export declare const END_PATCH_MARKER = "*** End Patch";
/**
 * Truncation sentinel emitted by an agent loop mid-call. Ends parsing like
 * {@link END_PATCH_MARKER}, without a warning.
 */
export declare const ABORT_MARKER = "*** Abort";
/** Two consecutive hunks targeted the exact same concrete range. */
export declare const REPLACE_PAIR_COALESCED_WARNING = "Two hunks targeted the same range; kept only the second. One `SWAP N.=M:` hunk per range \u2014 the body is the final content, never old+new.";
/** Bare body rows auto-converted to literal `+` rows. */
export declare const BARE_BODY_AUTO_PIPED_WARNING = "Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines.";
/** Unified-diff-style `-` row in a hunk body. */
export declare const MINUS_ROW_REJECTED = "`-` rows are not valid; the range already names the lines being changed. For Markdown bullets or other literal `-` lines, prefix the literal row with `+`: `+- item`.";
/** Replace hunk with no body. */
export declare const EMPTY_REPLACE = "`SWAP N.=M:` needs at least one `+TEXT` body row. To delete lines, use `DEL N.=M`.";
/** `replace_block N:` hunk with no body. */
export declare const EMPTY_BLOCK = "`SWAP.BLK N:` needs at least one `+TEXT` body row. To delete a block, use `DEL.BLK N`.";
/**
 * Block-anchored replace/delete could not resolve to a syntactic block
 * (unsupported language, blank/out-of-range line, no node beginning on N, or
 * parse error). Appends a {@link formatAnchoredContext} preview when
 * `fileLines` is given. `insert_after_block N:` never reaches this — it is
 * lowered to plain `insert after N:` instead (see
 * {@link insertAfterBlockUnresolvedLoweredWarning}).
 */
export declare function blockUnresolvedMessage(line: number, op?: "replace" | "delete", fileLines?: readonly string[]): string;
/** Block-anchored edit reached a path with no {@link BlockResolver} wired in — a host-configuration bug. */
export declare const BLOCK_RESOLVER_UNAVAILABLE = "`SWAP.BLK`/`DEL.BLK`/`INS.BLK.POST` are not available here (no block resolver configured). Use a concrete line range.";
/**
 * `insert_after_block N:` anchored on a closing-delimiter line, lowered to
 * plain `insert after N:` — the closer ends a block, and inserting after it
 * is exactly what the plain form does.
 */
export declare function insertAfterBlockCloserLoweredWarning(line: number): string;
/**
 * `insert_after_block N:` anchor unresolvable (unsupported language, blank
 * line, parse error, or no resolver), lowered to plain `insert after N:` —
 * applying with a warning beats failing the patch.
 */
export declare function insertAfterBlockUnresolvedLoweredWarning(line: number): string;
/**
 * Internal invariant: `applyEdits` received an unresolved `replace_block N:`
 * edit; `resolveBlockEdits` must run first. Wiring bug, not authored input.
 */
export declare const UNRESOLVED_BLOCK_INTERNAL = "internal error: unresolved `SWAP.BLK` edit reached the applier (resolveBlockEdits was not run).";
/** Delete hunk received a body row. */
export declare const DELETE_TAKES_NO_BODY = "`DEL N.=M` does not take body rows. Remove the body, or use `SWAP N.=M:`.";
/** `REM` received a body row or coexists with line edits. */
export declare const REM_TAKES_NO_BODY = "`REM` deletes the whole file and takes no body rows or line ops. Issue it alone under the header.";
/** `MV` received a body row. */
export declare const MOVE_TAKES_NO_BODY = "`MV DEST` does not take body rows. Put line edits above the `MV` row; the destination path follows `MV` on the same line.";
/** `delete_block N` hunk received a body row. */
export declare const DELETE_BLOCK_TAKES_NO_BODY = "`DEL.BLK N` does not take body rows. Remove the body, or use `SWAP.BLK N:`.";
/** Insert hunk with no body. */
export declare const EMPTY_INSERT = "`INS` needs at least one `+TEXT` body row.";
/**
 * `insert after` body indented shallower than the anchor: the landing slid
 * forward past trailing closer lines — the common "anchored on the last line
 * I read instead of after the block" mistake.
 */
export declare function afterInsertLandingShiftWarning(anchorLine: number, landingLine: number, crossed: number): string;
/**
 * `insert_after_block N:` body indented deeper than the block's closer: the
 * landing was pulled inside the block — a deeper body almost always means
 * "append inside the block's body".
 */
export declare function blockInsertLandingShiftWarning(blockStart: number, closerLine: number, landingLine: number): string;
/** `Recovery`: an external write matched a cached snapshot. */
export declare const RECOVERY_EXTERNAL_WARNING = "Recovered from a stale file hash using a previous read snapshot (file changed externally between read and edit).";
/** `Recovery`: a prior in-session edit advanced the hash. */
export declare const RECOVERY_SESSION_CHAIN_WARNING = "Recovered from a stale file hash using an earlier in-session snapshot (a prior edit in this session advanced the hash).";
/**
 * `Recovery`: session-chain replay fast-path. Less certain than
 * {@link RECOVERY_SESSION_CHAIN_WARNING} — the 3-way merge refused, the
 * anchor-content gate passed, but a coincidental insert+delete earlier in
 * the chain could still misplace an anchor — hence the verify hedge.
 */
export declare const RECOVERY_SESSION_REPLAY_WARNING = "Recovered by replaying your edits onto the current file content (a prior in-session edit changed the lines you re-targeted with a stale hash). Verify the diff matches your intent.";
/** `Recovery`: stale anchors were relocated to unchanged live lines after drift. */
export declare const RECOVERY_LINE_REMAP_WARNING = "Recovered by remapping stale line anchors to unchanged current lines (file changed since the tagged read). Verify the diff matches your intent.";
/**
 * `insert head:`/`insert tail:` applied despite a stale snapshot tag.
 * Head/tail position is content-independent, so drift is non-fatal: apply
 * onto live content and warn instead of hard-failing.
 */
export declare const HEADTAIL_DRIFT_WARNING = "Applied the `INS.HEAD:`/`INS.TAIL:` edit despite a stale snapshot tag (file changed since your read) \u2014 head/tail position is content-independent. Re-read if the drift was unexpected.";
/**
 * Section omitted the mandatory snapshot tag. Shared by the apply
 * ({@link Patcher.prepare}) and preview/diff paths so both stay in lockstep.
 */
export declare function missingSnapshotTagMessage(sectionPath: string): string;
/**
 * A section named a path that does not exist, but its filename and snapshot
 * tag together match exactly one file read earlier this session — the model
 * gave the bare filename (or wrong directory) for a file it just read. The
 * edit was rebound to that file's full path. Surfaced as a warning so the
 * model (and user) learn the corrected path and stop reusing the wrong one.
 */
export declare function pathRecoveredFromTagMessage(authoredPath: string, resolvedPath: string, tag: string): string;
/** One anchored line whose actual content is being surfaced in an error message. */
export interface RevealedLine {
    line: number;
    text: string;
}
/**
 * Content preview handed to {@link unseenLinesMessage}. `lines` are the
 * unseen anchor lines whose actual file content we surface inline (from the
 * tagged snapshot the caller matched). `truncated` = true means the anchor
 * range exceeded the inline reveal cap; the caller only revealed a prefix
 * and the remaining unseen lines still require a range re-read.
 */
export interface UnseenLinesReveal {
    lines: readonly RevealedLine[];
    truncated: boolean;
}
/**
 * An anchored edit referenced lines the read that minted the cited tag never
 * displayed (a partial range, or a structural summary that collapsed bodies).
 * Editing lines you have not read is the off-by-memory failure that mangles
 * files. When `reveal.lines` is non-empty, the caller has already inlined the
 * actual file content at those lines and merged them into the snapshot's
 * seen-line set, so the message points the model at a straight retry with the
 * same `[path#tag]` header; when the reveal is empty or truncated, the
 * message falls back to instructing a range re-read.
 */
export declare function unseenLinesMessage(sectionPath: string, unseenLines: readonly number[], tag: string, reveal?: UnseenLinesReveal): string;
/** Op kind of a deferred block edit, for {@link blockSingleLineMessage}. */
export type BlockOp = "replace" | "delete" | "insert_after";
/**
 * A `replace_block`/`delete_block`/`insert_after_block` anchor resolved to a
 * single line — almost always a bare statement the model mis-anchored, not a
 * multi-line construct. The plain op is unambiguous for one line; the block
 * form only earns its keep when it spares counting a closing line you cannot
 * see. Reject and point at both fixes.
 */
export declare function blockSingleLineMessage(line: number, op: BlockOp): string;
