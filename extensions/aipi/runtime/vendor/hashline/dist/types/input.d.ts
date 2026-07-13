import type { ApplyResult, BlockResolver, Edit, FileOp, SplitOptions } from "./types.js";
interface RawSection {
    path: string;
    fileHash?: string;
    diff: string;
}
/**
 * Returns true when the input contains at least one line that the tokenizer
 * recognizes as a hashline op. Used by streaming previews to decide whether
 * the partial input is worth treating as a hashline patch yet.
 */
export declare function containsRecognizableHashlineOperations(input: string): boolean;
/**
 * Snapshot of one section in a parsed {@link Patch}: a target file plus the
 * lazily-parsed list of edits that should land on it. Constructed by
 * {@link Patch.parse}; consumers usually iterate `patch.sections` rather
 * than build these directly.
 */
export declare class PatchSection {
    #private;
    readonly path: string;
    readonly fileHash: string | undefined;
    readonly diff: string;
    constructor(raw: RawSection);
    /**
     * Parse this section's diff body. Cached: subsequent calls return the
     * same `{ edits, fileOp?, warnings }` object so callers can safely call this from
     * multiple paths (preflight, apply, diff-preview).
     */
    parse(): {
        edits: Edit[];
        fileOp?: FileOp;
        warnings: readonly string[];
    };
    /** Parsed edits for this section. */
    get edits(): readonly Edit[];
    /** Optional whole-file operation (`REM` / `MV`). */
    get fileOp(): FileOp | undefined;
    /** Warnings emitted during parsing of this section. */
    get warnings(): readonly string[];
    /**
     * True when at least one edit anchors to concrete file content. Pure
     * `insert head:` / `insert tail:` literal inserts do not count: those are
     * safe to apply to files that don't yet exist.
     */
    get hasAnchorScopedEdit(): boolean;
    /** Anchor lines touched by this section, sorted ascending and deduplicated. */
    collectAnchorLines(): readonly number[];
    /**
     * Apply this section's edits to `text` and return the post-edit result.
     * Pure: does no I/O, does not validate the section snapshot tag. The
     * {@link Patcher} owns tag validation and recovery; reach for this
     * method directly when you've already validated the file content and
     * just want the result.
     *
     * `blockResolver` resolves any `replace_block N:` edits against `text`; an
     * unresolvable block throws (this is the final, authoritative preview path).
     */
    applyTo(text: string, blockResolver?: BlockResolver): ApplyResult;
    /**
     * Streaming-tolerant counterpart to {@link applyTo}. Uses
     * {@link parsePatchStreaming} so a trailing in-flight op (no payload yet,
     * or a per-token parse error mid-stream) does not throw or emit a phantom
     * empty-payload edit. Intended for incremental diff previews; the writer
     * path should always use {@link applyTo}.
     *
     * `blockResolver` resolves any `replace_block N:` edits against `text`; an
     * unresolvable block is silently dropped so a half-written file does not
     * throw mid-stream.
     */
    applyPartialTo(text: string, blockResolver?: BlockResolver): ApplyResult;
    /**
     * A copy of this section rebound to a different target `path`, preserving
     * the snapshot tag, diff body, and any cached parse result. Used by the
     * patcher's tag-based path recovery to redirect an edit whose authored
     * path does not exist onto the file its snapshot tag actually names.
     */
    withPath(path: string): PatchSection;
}
/**
 * A parsed hashline patch — zero or more {@link PatchSection}s, each rooted
 * at a `[PATH#HASH]` header. Construct via {@link Patch.parse}.
 *
 * `Patch` is pure data: parsing is line-anchored and does not look at the
 * filesystem. To apply a patch, hand it to {@link Patcher.apply}.
 */
export declare class Patch {
    readonly sections: readonly PatchSection[];
    private constructor();
    /**
     * Parse `input` into a {@link Patch}. `options.cwd` resolves absolute
     * paths inside headers to cwd-relative form; `options.path` provides a
     * fallback when the input lacks a header but contains hashline ops
     * (useful for streaming previews).
     *
     * Consecutive sections targeting the same path are merged into a single
     * section with concatenated diff bodies. Anchors authored against the
     * same file snapshot must be applied as one batch; otherwise the first
     * sub-edit shifts line numbers out from under the second's anchors and
     * validation fails.
     */
    static parse(input: string, options?: SplitOptions): Patch;
    /**
     * Parse `input` and return only the first section. Throws if the input
     * has zero sections. Convenience for the single-section case where the
     * caller already knows the patch is one hunk.
     */
    static parseSingle(input: string, options?: SplitOptions): PatchSection;
}
export {};
