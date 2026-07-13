/**
 * Result returned by {@link Filesystem.writeText}. The patcher echoes back
 * `text` so adapters that transform on serialization (e.g. notebooks) can
 * report what actually landed on disk.
 */
export interface WriteResult {
    /** Final text that was persisted. May differ from the input if the FS transformed it. */
    text: string;
}
import type { FileOp } from "./types.js";
/** Optional hints for {@link Filesystem.preflightWrite}. */
export interface PreflightWriteOptions {
    fileOp?: FileOp;
}
/**
 * ENOENT-like error thrown by {@link Filesystem.readText} when a path is
 * missing. Carrying a `code` property keeps the contract compatible with
 * `node:fs` callers that already check `err.code === "ENOENT"`.
 */
export declare class NotFoundError extends Error {
    readonly code = "ENOENT";
    constructor(path: string, cause?: unknown);
}
/** Type guard for {@link NotFoundError} and structurally-compatible errors. */
export declare function isNotFound(error: unknown): boolean;
/**
 * Abstract storage backend the {@link Patcher} reads from and writes to.
 * Subclass for new backends; the package ships {@link InMemoryFilesystem} and
 * {@link NodeFilesystem} for the most common cases.
 *
 * Implementations work with raw text — the patcher handles BOM stripping and
 * line-ending normalization itself. `readText` MUST throw {@link
 * NotFoundError} (or any error for which {@link isNotFound} returns true)
 * when the path doesn't exist; that's how the patcher detects a create-vs-
 * update.
 */
export declare abstract class Filesystem {
    /** Read the file's full text content. Throw on missing file. */
    abstract readText(path: string): Promise<string>;
    /** Read raw bytes for backends whose text is a direct decode of persisted bytes. */
    readBinary?(path: string): Promise<Uint8Array | undefined>;
    /** Validate that `path` is writable before a prepared batch starts committing. */
    preflightWrite(_path: string, _options?: PreflightWriteOptions): Promise<void>;
    /** Persist `content` at `path`. Returns the actual final text that was written. */
    abstract writeText(path: string, content: string): Promise<WriteResult>;
    /** Delete the file at `path`. Default: not supported. */
    delete(path: string): Promise<void>;
    /**
     * Move/rename `from` to `to`. When `content` is provided the destination
     * receives that text; otherwise implementations may preserve the source bytes.
     */
    move(from: string, to: string, content?: string): Promise<void>;
    /** Return true when the path exists and can be read. Default: probe via {@link readText}. */
    exists(path: string): Promise<boolean>;
    /**
     * Canonical path used as a key by external caches (e.g. snapshot
     * stores). The default is identity; override to return an absolute or
     * otherwise canonicalised path so producers and consumers of cached
     * snapshots agree on the key without each having to redo the resolution.
     */
    canonicalPath(path: string): string;
    /**
     * Whether a section whose authored path is missing may be redirected to
     * the file its snapshot tag names (tag-based path recovery in
     * {@link Patcher.prepare}). `resolvedPath` is the canonical path the
     * redirect would read and write. Default: allow.
     *
     * Hosts that grant write privileges by path shape override this to refuse
     * redirects that could escalate beyond what the caller approved — e.g. an
     * internal-URL authored target (approved read-only), or a `resolvedPath`
     * outside the working tree (a sandbox/vault/out-of-tree write).
     */
    allowTagPathRecovery(_authoredPath: string, _resolvedPath: string): boolean;
}
/**
 * In-memory {@link Filesystem}. Useful for tests, sandboxes, dry-runs, and as
 * a building block for stacked adapters (e.g. an LRU layer on top).
 */
export declare class InMemoryFilesystem extends Filesystem {
    #private;
    constructor(initial?: Iterable<readonly [string, string]>);
    readText(path: string): Promise<string>;
    writeText(path: string, content: string): Promise<WriteResult>;
    delete(path: string): Promise<void>;
    move(from: string, to: string, content?: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    /** Synchronous helper for setting up fixtures without awaiting. */
    set(path: string, content: string): void;
    /** Synchronous helper for inspecting state without awaiting. */
    get(path: string): string | undefined;
    /** Wipe all entries. */
    clear(): void;
    /** Iterate `[path, content]` pairs. */
    entries(): IterableIterator<[string, string]>;
}
/**
 * Disk-backed {@link Filesystem} using Bun's file APIs. The default for CLI
 * use. Paths are accepted as-is; callers responsible for any cwd or
 * jail/sandbox resolution should wrap this with their own subclass.
 */
export declare class NodeFilesystem extends Filesystem {
    readText(path: string): Promise<string>;
    readBinary(path: string): Promise<Uint8Array>;
    writeText(path: string, content: string): Promise<WriteResult>;
    delete(path: string): Promise<void>;
    move(from: string, to: string, content?: string): Promise<void>;
    canonicalPath(path: string): string;
    exists(path: string): Promise<boolean>;
}
