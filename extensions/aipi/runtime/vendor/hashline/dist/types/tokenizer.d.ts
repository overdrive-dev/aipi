import type { Anchor, Cursor, ParsedRange } from "./types.js";
export declare function splitHashlineLines(text: string): string[];
export declare function cloneCursor(cursor: Cursor): Cursor;
/** Parse a bare line-number anchor. Throws on malformed input. */
export declare function parseLid(raw: string, lineNum: number): Anchor;
export type BlockTarget = {
    kind: "replace";
    range: ParsedRange;
} | {
    kind: "block";
    anchor: Anchor;
} | {
    kind: "delete";
    range: ParsedRange;
} | {
    kind: "delete_block";
    anchor: Anchor;
} | {
    kind: "insert_before";
    anchor: Anchor;
} | {
    kind: "insert_after";
    anchor: Anchor;
} | {
    kind: "insert_after_block";
    anchor: Anchor;
} | {
    kind: "rem";
} | {
    kind: "move";
    dest: string;
} | {
    kind: "bof";
} | {
    kind: "eof";
};
interface TokenBase {
    lineNum: number;
}
export type Token = (TokenBase & {
    kind: "blank";
}) | (TokenBase & {
    kind: "envelope-begin";
}) | (TokenBase & {
    kind: "envelope-end";
}) | (TokenBase & {
    kind: "abort";
}) | (TokenBase & {
    kind: "header";
    path: string;
    fileHash?: string;
}) | (TokenBase & {
    kind: "op-block";
    target: BlockTarget;
}) | (TokenBase & {
    kind: "payload-literal";
    text: string;
}) | (TokenBase & {
    kind: "raw";
    text: string;
});
export declare class Tokenizer {
    #private;
    feed(chunk: string): Token[];
    end(): Token[];
    reset(): void;
    tokenizeAll(text: string): Token[];
    tokenize(line: string, lineNum?: number): Token;
    isOp(line: string): boolean;
    isHeader(line: string): boolean;
    isEnvelopeMarker(line: string): boolean;
}
export type { ParsedRange } from "./types.js";
