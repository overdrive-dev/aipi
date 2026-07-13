import type { BlockResolution, BlockResolver, Edit } from "./types.js";
export interface ResolveBlockEditsOptions {
    /**
     * How to handle a replace/delete block edit that cannot be resolved
     * (missing resolver or a `null` span). `"throw"` (default) raises a
     * `blockUnresolvedMessage` error — used by the authoritative apply + final
     * preview paths. `"drop"` silently skips the edit — used by the streaming
     * preview, where a half-written file or transient parse error must not
     * throw. Unresolvable `insert_after_block N:` edits never reach this: they
     * are lowered to plain `insert after N:` with a warning.
     */
    onUnresolved?: "throw" | "drop";
    /**
     * Invoked once per successfully resolved block edit, in patch order, with
     * the anchor line and the concrete span it resolved to. Lets the host echo
     * the resolution back to the caller. Never fired for dropped/unresolvable
     * edits.
     */
    onResolved?: (resolution: BlockResolution) => void;
    /**
     * Invoked once per diagnostic produced while resolving — currently the
     * `insert_after_block N:` lowerings (closer anchor or unresolvable block).
     * Hosts should surface these on the apply result's `warnings`.
     */
    onWarning?: (message: string) => void;
}
/** True when at least one edit is an unresolved deferred block edit. */
export declare function hasBlockEdit(edits: readonly Edit[]): boolean;
/**
 * Resolve every deferred block edit in `edits` against `text` (parsed as the
 * language inferred from `path`). Non-block edits pass through untouched.
 * Returns a fresh edit list with no `block` variants. The fast path returns the
 * input unchanged when there is nothing to resolve.
 *
 * Synthesized inserts/deletes carry sequential `index` values for readability
 * only — {@link applyEdits} re-derives every edit's index from array order, so
 * the passthrough edits keeping their original indices is harmless.
 */
export declare function resolveBlockEdits(edits: readonly Edit[], text: string, path: string, resolver: BlockResolver | undefined, options?: ResolveBlockEditsOptions): readonly Edit[];
