import type { Filesystem } from "./fs.js";
import type { Patch, PatchSection } from "./input.js";
import { type LineEnding } from "./normalize.js";
import { Recovery } from "./recovery.js";
import type { SnapshotStore } from "./snapshots.js";
import type { ApplyResult, BlockResolution, BlockResolver, FileOp } from "./types.js";
export interface PatcherOptions {
    /** Storage backend used for all reads and writes. */
    fs: Filesystem;
    /** Snapshot store that minted and resolves hashline section tags. Required. */
    snapshots: SnapshotStore;
    /**
     * Resolves `replace_block N:` anchors to concrete line spans via tree-sitter.
     * Optional: when omitted, any `replace_block N:` edit throws on apply (the
     * host did not wire a resolver). Plain line-range ops never need it.
     */
    blockResolver?: BlockResolver;
}
/** Per-section result returned by {@link Patcher.apply} / {@link Patcher.commit}. */
export interface PatchSectionResult {
    /** Section path (as authored, after cwd-resolution at parse time). */
    path: string;
    /** Filesystem-canonical key for this section (e.g. absolute path). */
    canonicalPath: string;
    /** `"noop"` when the apply produced no change; `"delete"` removes the file; otherwise `"create"` / `"update"`. */
    op: "create" | "update" | "delete" | "noop";
    /** Pre-edit text (LF-normalized, BOM-stripped). */
    before: string;
    /** Post-edit text (LF-normalized, BOM-stripped). For `"noop"` equals `before`. */
    after: string;
    /** Same text as `after` but with the original BOM and line ending restored. */
    persisted: string;
    /** Final text that the {@link Filesystem} actually wrote (may differ if the FS transformed it). */
    written: string;
    /** 4-hex content-hash tag for `after`. Use to anchor follow-up edits. */
    fileHash: string;
    /** Hashline section header (`[path#tag]`) of the post-edit content. */
    header: string;
    /** 1-indexed first changed line in `after`, or `undefined` for noops. */
    firstChangedLine?: number;
    /** Warnings collected by the parser, applier, and (optionally) recovery. */
    warnings: string[];
    /** Destination path when this section includes `MV DEST`. */
    moveDest?: string;
    /**
     * Resolved spans for any `replace_block`/`delete_block` ops, present when the
     * apply matched the tagged content. Undefined for patches with no block ops
     * (and for resolutions routed through drift recovery, where numbers shift).
     */
    blockResolutions?: BlockResolution[];
}
export interface PatcherApplyResult {
    sections: PatchSectionResult[];
}
/**
 * Opaque token returned by {@link Patcher.prepare}. Carries the section, the
 * raw file content read off disk, and the in-memory apply result.
 * {@link Patcher.commit} just writes the {@link PreparedSection.applyResult}.
 */
export declare class PreparedSection {
    readonly section: PatchSection;
    readonly canonicalPath: string;
    readonly exists: boolean;
    readonly rawContent: string;
    readonly bom: string;
    readonly lineEnding: LineEnding;
    readonly normalized: string;
    readonly applyResult: ApplyResult;
    readonly parseWarnings: readonly string[];
    readonly fileOp: FileOp | undefined;
    /** @internal */
    constructor(section: PatchSection, canonicalPath: string, exists: boolean, rawContent: string, bom: string, lineEnding: LineEnding, normalized: string, applyResult: ApplyResult, parseWarnings: readonly string[], fileOp: FileOp | undefined);
    /** Convenience: returns true when the apply produced no change and no file op. */
    get isNoop(): boolean;
}
/**
 * High-level patcher. Wires a {@link Filesystem} and a required
 * {@link SnapshotStore} together with the parsing + applying core.
 *
 * Construct once per FS configuration; reuse across patches.
 */
export declare class Patcher {
    #private;
    readonly fs: Filesystem;
    readonly snapshots: SnapshotStore;
    readonly recovery: Recovery;
    readonly blockResolver: BlockResolver | undefined;
    constructor(options: PatcherOptions);
    /**
     * Apply every section in `patch`. `prepare` runs the full apply for each
     * section in memory before any write hits the filesystem, so a
     * multi-section batch is naturally all-or-nothing. Returns one
     * {@link PatchSectionResult} per section in the original patch order.
     */
    apply(patch: Patch): Promise<PatcherApplyResult>;
    /**
     * Run the preflight pass only: read, parse, validate, apply-in-memory.
     * No writes hit the filesystem. Use for CI checks and dry runs.
     */
    preflight(patch: Patch): Promise<void>;
    /**
     * Read a section's target file, parse the section, validate the snapshot
     * tag (with recovery), and apply the edits in memory. Returns a
     * {@link PreparedSection} which can be fed to {@link commit} to land
     * the result on the filesystem.
     *
     * Throws on parse error, missing-file-for-anchored-edit, or unrecovered
     * tag mismatch ({@link MismatchError}).
     */
    prepare(section: PatchSection): Promise<PreparedSection>;
    /**
     * Commit a previously {@link prepare}d section to the filesystem.
     * Restores line endings and BOM, writes via the {@link Filesystem}, and
     * records a fresh snapshot in the {@link SnapshotStore} keyed by the
     * filesystem-canonical path.
     */
    commit(prepared: PreparedSection): Promise<PatchSectionResult>;
}
