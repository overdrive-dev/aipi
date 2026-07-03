// Shared secret redaction for everything AIPI persists (runtime jsonl logs,
// watchdog traces, diagnose bundles). Single source of truth: lifecycle-hooks.js
// and diagnose.js previously carried divergent private copies of these patterns.
// Order matters: URL credentials and bearer values are rewritten before the
// generic key=value pattern so composite shapes ("Authorization: Bearer x")
// collapse into one redaction instead of leaving the token half-exposed.

export const SECRET_PATTERNS = Object.freeze([
  // scheme://user:password@host — keep the user, drop the password.
  { name: "credentialed_url", pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi, replacement: "$1:[REDACTED]@" },
  // Three-part JWTs; the dot-separated segments keep plain base64 blobs from matching.
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: "eyJ[REDACTED]" },
  // AWS access key ids (long-term AKIA, temporary ASIA).
  { name: "aws_access_key_id", pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: "$1[REDACTED]" },
  // {8,} is the stricter of the two legacy thresholds (diagnose.js used 8, lifecycle-hooks.js 12).
  { name: "openai_style_key", pattern: /\b(sk-[A-Za-z0-9_-]{8,})\b/g, replacement: "sk-[REDACTED]" },
  { name: "github_token", pattern: /\b(gh[pousr]_[A-Za-z0-9_]{8,})\b/g, replacement: "gh_[REDACTED]" },
  { name: "bearer_value", pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "$1 [REDACTED]" },
  {
    name: "key_value",
    pattern: /\b(api[_-]?key|token|secret|password|authorization|refresh_token|access_token)\s*[:=]\s*["']?([A-Za-z0-9._/+=-]{8,})["']?/gi,
    replacement: "$1=[REDACTED]",
  },
]);

export function redactSecrets(text) {
  let value = String(text ?? "");
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    value = value.replace(pattern, replacement);
  }
  return value;
}
