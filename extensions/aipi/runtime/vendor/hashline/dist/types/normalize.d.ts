/**
 * Minimal text-shape normalization: line-ending detection / round-trip and
 * BOM stripping. The patcher uses these to canonicalize text to LF before
 * applying edits and to restore the original shape on write-back.
 */
export type LineEnding = "\r\n" | "\n";
/** Detect the first line ending style in `content`. Defaults to LF when neither is present. */
export declare function detectLineEnding(content: string): LineEnding;
/** Normalize every line ending to LF. */
export declare function normalizeToLF(text: string): string;
/** Re-encode LF text with the requested line ending. */
export declare function restoreLineEndings(text: string, ending: LineEnding): string;
export interface BomResult {
    /** Either the empty string or the BOM sequence (currently UTF-8 BOM). */
    bom: string;
    /** Text with any leading BOM removed. */
    text: string;
}
/** Strip a UTF-8 BOM if present and return both the BOM and the trailing text. */
export declare function stripBom(content: string): BomResult;
