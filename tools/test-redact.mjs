import assert from "node:assert/strict";
import { redactSecrets, SECRET_PATTERNS } from "../extensions/aipi/runtime/redact.js";

function run(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

run("legacy openai-style keys still redact", () => {
  assert.equal(redactSecrets("key sk-abc123DEF456ghi789 trailing"), "key sk-[REDACTED] trailing");
});

run("legacy github tokens still redact", () => {
  assert.equal(redactSecrets("ghp_ABCdef123456789012 done"), "gh_[REDACTED] done");
  assert.equal(redactSecrets("ghs_ABCdef123456789012"), "gh_[REDACTED]");
});

run("legacy key=value pairs still redact and keep the key name", () => {
  assert.equal(redactSecrets("token=SECRETSECRET12345"), "token=[REDACTED]");
  assert.equal(redactSecrets('api_key: "abcd1234efgh5678"'), "api_key=[REDACTED]");
  assert.equal(redactSecrets("password = hunter2hunter2"), "password=[REDACTED]");
  assert.equal(redactSecrets("refresh_token=abcdefgh1234"), "refresh_token=[REDACTED]");
});

run("three-part JWTs redact", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
  const output = redactSecrets(`header ${jwt} tail`);
  assert.equal(output, "header eyJ[REDACTED] tail");
});

run("plain base64 without dots is NOT redacted (jwt false-positive guard)", () => {
  const blob = "eyJhbGciOiJIUzI1NiJ9AAAABBBBCCCCDDDD";
  assert.equal(redactSecrets(blob), blob);
});

run("aws access key ids redact, temporary and long-term", () => {
  assert.equal(redactSecrets("AKIAIOSFODNN7EXAMPLE"), "AKIA[REDACTED]");
  assert.equal(redactSecrets("ASIAIOSFODNN7EXAMPLE"), "ASIA[REDACTED]");
});

run("lowercase akia-lookalike is NOT redacted", () => {
  assert.equal(redactSecrets("akiaiosfodnn7example"), "akiaiosfodnn7example");
});

run("credentialed urls keep user, drop password", () => {
  assert.equal(
    redactSecrets("postgres://nora:hunter2secret@db.internal:5432/app"),
    "postgres://nora:[REDACTED]@db.internal:5432/app",
  );
});

run("url without password is untouched", () => {
  const url = "https://registry.npmjs.org/@earendil-works/pi-coding-agent";
  assert.equal(redactSecrets(url), url);
});

run("bearer values redact, composite Authorization header collapses fully", () => {
  assert.equal(redactSecrets("Bearer abcdef123456"), "Bearer [REDACTED]");
  const output = redactSecrets("Authorization: Bearer abcdef123456xyz");
  assert.ok(!output.includes("abcdef123456xyz"), `token leaked: ${output}`);
});

run("bare word Bearer without a token is untouched", () => {
  assert.equal(redactSecrets("the Bearer of bad news"), "the Bearer of bad news");
});

run("non-string input coerces without throwing", () => {
  assert.equal(redactSecrets(null), "");
  assert.equal(redactSecrets(undefined), "");
  assert.equal(redactSecrets(12345), "12345");
});

run("patterns registry is frozen and named", () => {
  assert.ok(Object.isFrozen(SECRET_PATTERNS));
  for (const entry of SECRET_PATTERNS) {
    assert.equal(typeof entry.name, "string");
    assert.ok(entry.pattern instanceof RegExp);
  }
});

console.log("test-redact: all assertions passed");
