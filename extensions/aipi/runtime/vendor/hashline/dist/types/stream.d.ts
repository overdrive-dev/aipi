import type { StreamOptions } from "./types.js";
export declare function streamHashLines(source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, options?: StreamOptions): AsyncGenerator<string>;
