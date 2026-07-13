// EXPERIMENTAL (flag-gated) hashline editing for AIPI workers.
//
// Registers two worker-side tools that pair to give content-hash-anchored edits
// on top of AIPI's owned-file scope:
//
//   aipi_read_hashline  reads a file and renders it in hashline form — a
//                       `[PATH#TAG]` header (TAG = 4-hex content hash) + `LINE:TEXT`
//                       numbered rows. This is the producer the model reads to
//                       author an edit; the tag certifies the snapshot it saw.
//   aipi_edit           applies a hashline patch. The Patcher re-hashes the live
//                       file and REJECTS a stale anchor (instead of corrupting it)
//                       before any write; a multi-section patch is preflighted
//                       all-or-nothing. Writes are confined to the worker's
//                       owned-file allocation via an owned-scoped Filesystem.
//
// The tag is content-derived, so validation needs no cross-call state: each edit
// gets a fresh snapshot store and validates against live content. 3-way-merge
// recovery and seen-line gating (which need a persistent read-provenance store)
// are intentionally out of scope for this first cut — a stale anchor hard-rejects
// and the model re-reads. The `write` tool is unchanged; this is additive.
//
// Gated OFF by default in pi-subagents.js (HASHLINE_WORKER_EDIT_ENABLED); when
// enabled, the worker prompt is extended with the hashline edit format.

import fs from "node:fs/promises";
import path from "node:path";
import { loadHashline } from "./hashline.js";
import {
  workerProjectRoot,
  workerAgentId,
  workerProjectScoped,
  ownedFilesFromEnv,
  normalizeRelativePath,
  assertInside,
  assertWorkerWritable,
} from "./aipi-worker-path-guard.js";

let ScopedFilesystem = null;

// Build (once) a disk Filesystem subclass that resolves authored relative paths
// under the project root, lets the worker READ any in-root file, but confines
// every WRITE to its owned-file scope. The owned-scope check runs in
// `preflightWrite` (the patcher's pre-commit gate) so an out-of-scope section
// rejects the whole batch before anything lands.
function getScopedFilesystemClass(hl) {
  if (ScopedFilesystem) return ScopedFilesystem;
  ScopedFilesystem = class extends hl.NodeFilesystem {
    constructor({ root, agentId, owned, projectScoped }) {
      super();
      this._root = root;
      this._agentId = agentId;
      this._owned = owned;
      this._projectScoped = projectScoped;
    }

    // Resolve a hashline (relative, forward-slash) path to an absolute disk path
    // inside the project root. Throws on absolute / escaping / .git paths.
    _abs(p) {
      const rel = normalizeRelativePath(p);
      const target = path.resolve(this._root, rel);
      assertInside(this._root, target);
      return target;
    }

    _assertWritable(p) {
      assertWorkerWritable(normalizeRelativePath(p), {
        agentId: this._agentId,
        owned: this._owned,
        projectScoped: this._projectScoped,
      });
    }

    canonicalPath(p) {
      return this._abs(p);
    }

    async readText(p) {
      return super.readText(this._abs(p));
    }

    async readBinary(p) {
      return super.readBinary(this._abs(p));
    }

    async exists(p) {
      return super.exists(this._abs(p));
    }

    async preflightWrite(p, options) {
      this._assertWritable(p);
      if (options?.fileOp?.kind === "move") this._assertWritable(options.fileOp.dest);
    }

    async writeText(p, content) {
      this._assertWritable(p);
      return super.writeText(this._abs(p), content);
    }

    async delete(p) {
      this._assertWritable(p);
      return super.delete(this._abs(p));
    }

    async move(from, to, content) {
      this._assertWritable(from);
      this._assertWritable(to);
      return super.move(this._abs(from), this._abs(to), content);
    }
  };
  return ScopedFilesystem;
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toolText(text) {
  return { content: [{ type: "text", text }] };
}

export default function registerAipiHashlineEditChild(pi) {
  pi.registerTool?.({
    name: "aipi_read_hashline",
    label: "Read (hashline)",
    description:
      "Read a file in hashline form for editing: a `[PATH#TAG]` header (TAG = content-hash snapshot) " +
      "followed by `LINE:TEXT` numbered rows. Use this before aipi_edit — the TAG and line numbers you " +
      "pass to aipi_edit come from this output.",
    parameters: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Project-relative path of the file to read." },
      },
      additionalProperties: false,
    },
    async execute(_id, params = {}) {
      let hl;
      try {
        hl = loadHashline();
      } catch (error) {
        return toolError(`aipi_read_hashline: hashline runtime unavailable (${String(error?.message ?? error)}).`);
      }
      const root = workerProjectRoot();
      let relPath;
      let target;
      try {
        relPath = normalizeRelativePath(params.path);
        target = path.resolve(root, relPath);
        assertInside(root, target);
      } catch (error) {
        return toolError(`aipi_read_hashline: ${String(error?.message ?? error)}`);
      }
      let raw;
      try {
        raw = await fs.readFile(target, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") {
          return toolError(`aipi_read_hashline: file not found: ${relPath}. Use write to create new files.`);
        }
        return toolError(`aipi_read_hashline: ${String(error?.message ?? error)}`);
      }
      // Normalize exactly as the patcher does so the tag we display matches the
      // tag it will validate against.
      const { text } = hl.stripBom(raw);
      const normalized = hl.normalizeToLF(text);
      const tag = hl.computeFileHash(normalized);
      const header = hl.formatHashlineHeader(relPath, tag);
      const body = hl.formatNumberedLines(normalized);
      return toolText(`${header}\n${body}`);
    },
  });

  pi.registerTool?.({
    name: "aipi_edit",
    label: "Edit (hashline)",
    description:
      "Apply a hashline patch to files this worker owns. Each section starts with `[PATH#TAG]` (TAG from your " +
      "latest aipi_read_hashline) and lists SWAP/DEL/INS ops. The edit is REJECTED if the file changed since " +
      "that read (stale tag) — re-read and retry. Multi-section patches apply all-or-nothing. Edits existing " +
      "files only; create new files with write.",
    parameters: {
      type: "object",
      required: ["patch"],
      properties: {
        patch: {
          type: "string",
          description: "A hashline patch: `[PATH#TAG]` header(s) followed by SWAP/DEL/INS ops and `+` body rows.",
        },
      },
      additionalProperties: false,
    },
    async execute(_id, params = {}) {
      let hl;
      try {
        hl = loadHashline();
      } catch (error) {
        return toolError(`aipi_edit: hashline runtime unavailable (${String(error?.message ?? error)}).`);
      }
      const patchText = String(params.patch ?? "").trim();
      if (!patchText) return toolError("aipi_edit requires a non-empty `patch`.");

      const root = workerProjectRoot();
      const Scoped = getScopedFilesystemClass(hl);
      const filesystem = new Scoped({
        root,
        agentId: workerAgentId(),
        owned: ownedFilesFromEnv(),
        projectScoped: workerProjectScoped(),
      });
      const snapshots = new hl.InMemorySnapshotStore();
      const patcher = new hl.Patcher({ fs: filesystem, snapshots });

      let patch;
      try {
        patch = hl.Patch.parse(patchText, { cwd: root });
      } catch (error) {
        return toolError(`aipi_edit: could not parse patch: ${String(error?.message ?? error)}`);
      }
      if (!patch.sections.length) {
        return toolError("aipi_edit: the patch produced no file sections. Start each section with `[PATH#TAG]`.");
      }

      let result;
      try {
        result = await patcher.apply(patch);
      } catch (error) {
        // Patcher messages (stale tag, unseen line, file-not-found) are written
        // for the model — surface them verbatim so it knows to re-read/retry.
        return toolError(`aipi_edit: ${String(error?.message ?? error)}`);
      }

      const lines = [];
      for (const section of result.sections) {
        // The fresh header is the anchor for any follow-up edit to the same file.
        lines.push(`${section.op} ${section.path} -> ${section.header}`);
        for (const warning of section.warnings ?? []) lines.push(`  warning: ${warning}`);
      }
      lines.push("Re-anchor further edits on the new #TAG above (or a fresh aipi_read_hashline).");
      return toolText(lines.join("\n"));
    },
  });
}
