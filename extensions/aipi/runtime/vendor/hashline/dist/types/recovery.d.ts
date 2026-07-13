import type { SnapshotStore } from "./snapshots.js";
import type { Edit } from "./types.js";
export interface RecoveryArgs {
    path: string;
    currentText: string;
    fileHash: string;
    edits: readonly Edit[];
}
export interface RecoveryResult {
    /** Post-recovery text. */
    text: string;
    /** First changed line (1-indexed) relative to the live `currentText`, or `undefined`. */
    firstChangedLine: number | undefined;
    /** Warnings collected during recovery, including the user-facing recovery banner. */
    warnings: string[];
}
/**
 * Stateless recovery driver over a {@link SnapshotStore}. Construct once and
 * call {@link Recovery.tryRecover} per stale-tag incident. The default
 * implementation tries three strategies in order:
 *
 * 1. Apply the edits on the full-file version the tag names, then 3-way-merge
 *    the resulting patch onto the live content (handles external writes).
 * 2. Remap every stale anchor through the unchanged-line diff from the tagged
 *    snapshot to the live text, then replay on live content. This handles a
 *    prior insertion/deletion before the target while refusing changed anchors
 *    and mixed offsets across the same edit range.
 * 3. (Session chain) If that version wasn't the head, replay the edits onto
 *    the live content directly when line counts match AND every edit's anchor
 *    line content is unchanged between version and current — a prior in-session
 *    edit advanced the tag and the model's anchors still name the same logical
 *    rows. Emits a dedicated {@link RECOVERY_SESSION_REPLAY_WARNING} because
 *    even with both guards a coincidental insert+delete pair on duplicate rows
 *    can still land the edit on the wrong row; see {@link replaySessionChainOnCurrent}.
 */
export declare class Recovery {
    readonly store: SnapshotStore;
    constructor(store: SnapshotStore);
    /**
     * Attempt recovery. Returns `null` when no path forward is found — the
     * caller should then surface a {@link MismatchError}.
     */
    tryRecover(args: RecoveryArgs): RecoveryResult | null;
}
