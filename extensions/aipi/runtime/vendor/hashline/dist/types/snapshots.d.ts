/**
 * One full-file version observed at a point in time. The tag the model sees is
 * {@link Snapshot.hash}; recovery replays edits against {@link Snapshot.text}.
 */
export interface Snapshot {
    /** Canonical path this version belongs to. */
    readonly path: string;
    /** Full normalized (LF, no BOM) file text as observed. */
    readonly text: string;
    /** Content-derived tag for {@link Snapshot.text} (see {@link computeFileHash}). */
    readonly hash: string;
    /** Timestamp (ms since epoch) the version was recorded. */
    recordedAt: number;
    /**
     * 1-indexed file lines a producer (read/search) actually *displayed* under
     * this tag. A partial read (range, or a structural summary that collapsed
     * bodies) leaves this sparse; a whole-file read fills every line. Multiple
     * reads of the same content union into one set. `undefined` means "no
     * provenance recorded" — the patcher then skips the seen-line check and
     * applies as before. Mutated in place as more of the same content is read.
     */
    seenLines?: Set<number>;
}
/**
 * Storage seam for full-file version snapshots. The patcher calls {@link head}
 * for the latest version of a path and {@link byHash} when it needs the
 * historical version a section's stale tag names.
 */
export declare abstract class SnapshotStore {
    /** Most-recently recorded version for `path`, or `null` if none. */
    abstract head(path: string): Snapshot | null;
    /**
     * Recorded version for `path` whose tag equals `hash`, or `null`. When two
     * distinct texts collide on the 16-bit tag, returns the most-recently
     * recorded one.
     */
    abstract byHash(path: string, hash: string): Snapshot | null;
    /**
     * Recorded version for `path` whose {@link Snapshot.text} equals `fullText`,
     * or `null`. The patcher uses it on the no-drift path to attach seen-line
     * provenance to the exact text the model read.
     */
    abstract byContent(path: string, fullText: string): Snapshot | null;
    /**
     * Every retained version whose tag equals `hash`, across all tracked
     * paths. The patcher uses this to recover the intended file when a section
     * names a path that does not exist on disk but carries a tag the store
     * minted — the model mistyped the path of a file it read this session.
     *
     * The base returns no matches (recovery disabled); stores that can
     * enumerate their contents override it to enable tag-based path recovery.
     */
    findByHash(_hash: string): Snapshot[];
    /**
     * Record the full normalized text of `path` and return its content tag.
     * `seenLines` (optional) are the 1-indexed lines the producer displayed;
     * they merge into {@link Snapshot.seenLines} across reads of identical text.
     */
    abstract record(path: string, fullText: string, seenLines?: Iterable<number>): string;
    /**
     * Merge `lines` into the {@link Snapshot.seenLines} of the version whose tag
     * equals `hash`. No-op when no such version is retained (the content aged
     * out or was overwritten). Lets producers attach displayed lines after the
     * tag was already minted (the body is formatted after the hash is computed).
     */
    abstract recordSeenLines(path: string, hash: string, lines: Iterable<number>): void;
    /** Drop the version history for a single path. */
    abstract invalidate(path: string): void;
    /**
     * Move retained version history (and read provenance) from `from` to `to`.
     * No-op when `from` has no history. Used by file moves so tags minted from
     * reads of the source path stay valid at the destination.
     */
    abstract relocate(from: string, to: string): void;
    /** Drop every version history. */
    abstract clear(): void;
}
export interface InMemorySnapshotStoreOptions {
    /** Maximum number of distinct paths tracked at once (default 30). LRU eviction. */
    maxPaths?: number;
    /** Maximum full-file versions retained per path (default 4). Oldest dropped first. */
    maxVersionsPerPath?: number;
    /**
     * Global ceiling on retained snapshot text summed across every path's
     * version history, measured in UTF-16 code units (default 64 MiB).
     * Least-recently-used path histories are evicted to stay under it.
     */
    maxTotalBytes?: number;
}
/**
 * In-memory {@link SnapshotStore} backed by `lru-cache`. Per-path history is a
 * short ring of full-file versions (oldest dropped first); per-session path
 * tracking is LRU-bounded so cold paths age out automatically.
 *
 * Recording byte-identical content again refreshes recency and reuses the
 * existing tag (read fusion); recording new content unshifts a fresh version
 * onto the front of the path history. Two distinct texts that collide on the
 * short 4-hex tag are retained as separate versions so callers can still tell
 * them apart via {@link Snapshot.text} — the tag is only a fast index, never
 * the identity.
 */
export declare class InMemorySnapshotStore extends SnapshotStore {
    #private;
    constructor(options?: InMemorySnapshotStoreOptions);
    head(path: string): Snapshot | null;
    byHash(path: string, hash: string): Snapshot | null;
    byContent(path: string, fullText: string): Snapshot | null;
    findByHash(hash: string): Snapshot[];
    record(path: string, fullText: string, seenLines?: Iterable<number>): string;
    recordSeenLines(path: string, hash: string, lines: Iterable<number>): void;
    invalidate(path: string): void;
    relocate(from: string, to: string): void;
    clear(): void;
}
