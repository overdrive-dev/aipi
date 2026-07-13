/**
 * Re-number a unified diff that uses the `+<lineNum>|content` /
 * `-<lineNum>|content` / ` <lineNum>|content` line format into a compact
 * current-file preview. Removed lines are counted for stats and post-edit
 * offset tracking, but omitted from the preview. Added and context lines are
 * anchored to their post-edit positions so a follow-up edit can reuse visible
 * concrete lines directly. Long contiguous added runs are summarized with a
 * `…` marker instead of echoing every inserted line.
 *
 * This is intentionally decoupled from the diff producer: anything that
 * emits the `<sign><lineNum>|<content>` shape works.
 */
import type { CompactDiffOptions, CompactDiffPreview } from "./types.js";
export declare function buildCompactDiffPreview(diff: string, options?: CompactDiffOptions): CompactDiffPreview;
