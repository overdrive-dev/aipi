/** Format the required-shape diagnostic shown when a line reference is malformed. */
export declare function formatFullAnchorRequirement(raw?: string): string;
/** Parse a decorated bare line-number anchor like `42`, `*42:foo`, ` > 7`. */
export declare function parseTag(ref: string): {
    line: number;
};
export interface MismatchDetails {
    path?: string;
    expectedFileHash: string;
    actualFileHash: string;
    fileLines: string[];
    anchorLines?: readonly number[];
    /**
     * `true` when the section's expected hash resolved to a recorded snapshot
     * (file content drifted since that snapshot), `false` when no snapshot
     * was ever recorded for the hash (likely fabricated or carried over from
     * a prior session). Drives a more actionable rejection message; defaults
     * to `true` for backward compatibility with direct callers.
     */
    hashRecognized?: boolean;
}
/**
 * Raised when a hashline section's snapshot tag doesn't match the live file's
 * content (and recovery, if configured, declined the merge). Carries the
 * file lines plus anchored lines so renderers can produce a richer
 * diagnostic via {@link MismatchError.displayMessage}.
 */
export declare class MismatchError extends Error {
    readonly path: string | undefined;
    readonly expectedFileHash: string;
    readonly actualFileHash: string;
    readonly fileLines: string[];
    readonly anchorLines: readonly number[];
    readonly hashRecognized: boolean;
    constructor(details: MismatchDetails);
    get displayMessage(): string;
    static rejectionHeader(details: MismatchDetails): string[];
    static formatDisplayMessage(details: MismatchDetails): string;
    static formatMessage(details: MismatchDetails): string;
}
/** Throws when the line reference is out of bounds for the given file. */
export declare function validateLineRef(ref: {
    line: number;
}, fileLines: string[]): void;
