import type { ApplyResult, Edit } from "./types.js";
/** A line that is nothing but closing delimiters: `}`, `)`, `];`, `})`, `},`. */
export declare const STRUCTURAL_CLOSER_RE: RegExp;
/**
 * Apply a parsed list of edits to a text body. Pure function — no I/O.
 *
 * Returns the post-edit text and the first changed line number (1-indexed).
 * Throws if an anchor is out of bounds.
 */
export declare function applyEdits(text: string, edits: readonly Edit[]): ApplyResult;
