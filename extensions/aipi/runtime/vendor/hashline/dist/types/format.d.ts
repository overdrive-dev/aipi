/**
 * Hashline format primitives: sigils, separators, regex fragments, and
 * display helpers. These are the single source of truth for the parser, the
 * tokenizer, the prompt, and the formal grammar.
 */
import type { Cursor } from "./types.js";
/** File-section header delimiters: `[path#hash]`. */
export declare const HL_FILE_PREFIX = "[";
export declare const HL_FILE_SUFFIX = "]";
/** Payload sigil for literal body rows. */
export declare const HL_PAYLOAD_REPLACE = "+";
/** Hunk-header keyword for concrete line replacement. */
export declare const HL_REPLACE_KEYWORD = "SWAP";
/** Hunk-header keyword for concrete line deletion. */
export declare const HL_DELETE_KEYWORD = "DEL";
/** Hunk-header keyword for insertion operations. */
export declare const HL_INSERT_KEYWORD = "INS";
/** Insert position keyword for inserting before a concrete line. */
export declare const HL_INSERT_BEFORE = "PRE";
/** Insert position keyword for inserting after a concrete line. */
export declare const HL_INSERT_AFTER = "POST";
/** Insert position keyword for inserting at the start of the file. */
export declare const HL_INSERT_HEAD = "HEAD";
/** Insert position keyword for inserting at the end of the file. */
export declare const HL_INSERT_TAIL = "TAIL";
/** Hunk-header keyword: `SWAP.BLK N:` resolves N to a tree-sitter block range and replaces its span. */
export declare const HL_REPLACE_BLOCK_KEYWORD = "SWAP.BLK";
/** Hunk-header keyword: `DEL.BLK N` resolves N to a tree-sitter block range and deletes its span. */
export declare const HL_DELETE_BLOCK_KEYWORD = "DEL.BLK";
/** Hunk-header keyword: `INS.BLK.POST N:` inserts after the last line of the tree-sitter block at N. */
export declare const HL_INSERT_AFTER_BLOCK_KEYWORD = "INS.BLK.POST";
/** File-level keyword: `REM` deletes the whole file named by the section header. */
export declare const HL_REM_KEYWORD = "REM";
/** File-level keyword: `MV DEST` renames/moves the section file to `DEST`. */
export declare const HL_MOVE_KEYWORD = "MV";
export declare const HL_HEADER_COLON = ":";
/** Separator between a hashline file path and its opaque snapshot tag. */
export declare const HL_FILE_HASH_SEP = "#";
/** Separator between two line numbers in a range, e.g. `5.=10`. */
export declare const HL_RANGE_SEP = ".=";
/** Separator between a line number and displayed line content in hashline mode. */
export declare const HL_LINE_BODY_SEP = ":";
/** Bare positive line-number Lid (no decorations, no captures, no anchors). */
export declare const HL_LINE_RE_RAW = "[1-9]\\d*";
/** Capture-group form of {@link HL_LINE_RE_RAW}. */
export declare const HL_LINE_CAPTURE_RE_RAW = "([1-9]\\d*)";
/** Format a concrete replacement hunk header. */
export declare function formatReplaceHeader(start: number, end: number): string;
/** Format a concrete deletion hunk header. */
export declare function formatDeleteHeader(start: number, end?: number): string;
/** Format an insertion hunk header for a cursor position. */
export declare function formatInsertHeader(cursor: Cursor): string;
/** Number of hex characters in a content-derived file-hash tag. */
export declare const HL_FILE_HASH_LENGTH = 4;
/** Canonical uppercase hexadecimal content-hash tag carried by a hashline section header. */
export declare const HL_FILE_HASH_RE_RAW = "[0-9A-F]{4}";
/** Capture-group form of {@link HL_FILE_HASH_RE_RAW}. */
export declare const HL_FILE_HASH_CAPTURE_RE_RAW = "([0-9A-F]{4})";
/** Regex-escaped form of {@link HL_LINE_BODY_SEP}, safe for embedding inside a regex. */
export declare const HL_LINE_BODY_SEP_RE_RAW: string;
/**
 * Representative file-hash tags for use in user-facing error messages and
 * prompt examples.
 */
export declare const HL_FILE_HASH_EXAMPLES: readonly ["1A2B", "3C4D", "9F3E"];
/**
 * Compute the content-derived hash tag carried by a hashline section header.
 * The tag is a 4-hex fingerprint of the whole file's normalized text: any read
 * of byte-identical content mints the same tag, and a follow-up edit anchored
 * at any line validates whenever the live file still hashes to it.
 */
export declare function computeFileHash(text: string): string;
/**
 * Format a comma-separated list of example anchors with an optional line-number
 * prefix, quoted for inclusion in error messages: `"160", "42", "7"`.
 */
export declare function describeAnchorExamples(linePrefix?: string): string;
/** Format a hashline section header for a file path and snapshot tag. */
export declare function formatHashlineHeader(filePath: string, fileHash: string): string;
/** Formats a single numbered line as `LINE:TEXT`. */
export declare function formatNumberedLine(lineNumber: number, line: string): string;
/** Format file text with hashline-mode line-number prefixes for display. */
export declare function formatNumberedLines(text: string, startLine?: number): string;
