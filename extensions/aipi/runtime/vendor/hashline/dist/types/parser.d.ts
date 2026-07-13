import { type Token } from "./tokenizer.js";
import type { Edit, FileOp } from "./types.js";
export declare class Executor {
    #private;
    feed(token: Token): void;
    end(): {
        edits: Edit[];
        fileOp?: FileOp;
        warnings: string[];
    };
    endStreaming(): {
        edits: Edit[];
        fileOp?: FileOp;
        warnings: string[];
    };
    reset(): void;
}
export declare function parsePatch(diff: string): {
    edits: Edit[];
    fileOp?: FileOp;
    warnings: string[];
};
export declare function parsePatchStreaming(diff: string): {
    edits: Edit[];
    fileOp?: FileOp;
    warnings: string[];
};
