// Verifies the in-flight background-research notice: it lists still-running workers, dedupes by the active
// set (one note per distinct set), and resets when nothing is in flight.

import assert from "node:assert/strict";
import {
  inflightResearchRuns,
  formatInflightNotice,
  computeInflightNotice,
} from "../extensions/aipi/runtime/inflight-research-notice.js";

const run = (id, state) => ({ id, state });

// --- inflightResearchRuns: only running/queued count as in-flight ---
{
  const runs = [
    run("contrarian:aa", "running"),
    run("project-researcher:bb", "queued"),
    run("context-curator:cc", "complete"),
    run("old:dd", "failed"),
  ];
  const active = inflightResearchRuns(runs);
  assert.deepEqual(active.map((r) => r.id), ["contrarian:aa", "project-researcher:bb"]);
  assert.deepEqual(inflightResearchRuns(null), [], "null → []");
}

// --- formatInflightNotice: lists role names, pluralizes, marks the response non-final ---
{
  const notice = formatInflightNotice([run("contrarian:aa", "running"), run("project-researcher:bb", "running")]);
  assert.match(notice, /2 background research agents still running/);
  assert.match(notice, /contrarian, project-researcher/, "role names (base of run.id) are listed");
  assert.match(notice, /isn't final/, "explicitly flags the response as not final");
  const one = formatInflightNotice([run("solo:aa", "running")]);
  assert.match(one, /1 background research agent still running/, "singular for one agent");
}

// --- computeInflightNotice: emits once per distinct active set (dedupe), resets when empty ---
{
  const set3 = [run("contrarian:aa", "running"), run("researcher:bb", "running"), run("curator:cc", "running")];

  // First sighting of a non-empty set → emit + return its signature.
  const first = computeInflightNotice(set3, { lastSignature: null });
  assert.ok(first.notice, "first non-empty set emits a note");
  assert.ok(first.signature, "returns the active-set signature");

  // Same set again → no repeat.
  const repeat = computeInflightNotice(set3, { lastSignature: first.signature });
  assert.equal(repeat.notice, null, "identical active set does not re-note");
  assert.equal(repeat.signature, first.signature, "signature unchanged");

  // A job finished (set shrank) → signature changes → re-note with the updated count.
  const set2 = [run("contrarian:aa", "running"), run("researcher:bb", "running")];
  const shrank = computeInflightNotice(set2, { lastSignature: first.signature });
  assert.ok(shrank.notice, "a changed active set re-notes");
  assert.match(shrank.notice, /2 background research agents/, "note reflects the current count");
  assert.notEqual(shrank.signature, first.signature, "signature reflects the new set");

  // Nothing in flight → reset (null signature, no note) so the next batch notes again.
  const drained = computeInflightNotice([], { lastSignature: shrank.signature });
  assert.equal(drained.notice, null, "no note when nothing is in flight");
  assert.equal(drained.signature, null, "signature resets to null when drained");

  // Signature is order-independent (run-store ordering must not cause a spurious re-note).
  const reordered = [run("researcher:bb", "running"), run("curator:cc", "running"), run("contrarian:aa", "running")];
  const sig = computeInflightNotice(set3, { lastSignature: null }).signature;
  assert.equal(computeInflightNotice(reordered, { lastSignature: sig }).notice, null, "reordered same set does not re-note");
}

console.log("inflight-research-notice: ok");
