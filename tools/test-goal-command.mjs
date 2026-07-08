import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  formatGoalCommandResult,
  parseGoalArgs,
  parseGoalSpec,
  runGoalCommand,
} from "../extensions/aipi/runtime/goal-command.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-goal-command-"));
const sourceRoot = path.resolve("templates/.aipi");
let tick = 0;
const nowBase = Date.parse("2026-07-08T00:00:00.000Z");
const now = () => new Date(nowBase + (tick++) * 1000);
const fixedRandom = () => Buffer.from("abcdef", "hex");

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });

  // --- parseGoalSpec: labeled block (English) ---
  const spec1 = parseGoalSpec("objective: implementar login\ncriteria:\n- retorna 200 ao logar\n- logout invalida o token\ndone_when: usuario ve o dashboard");
  assert.equal(spec1.objective, "implementar login");
  assert.deepEqual(spec1.criteria, ["retorna 200 ao logar", "logout invalida o token"]);
  assert.equal(spec1.done_when, "usuario ve o dashboard");

  // --- parseGoalSpec: pt-BR labels ---
  const spec2 = parseGoalSpec("objetivo: adicionar cache\ncriterios:\n- latencia menor que 100\nfim: p95 abaixo de 100ms");
  assert.equal(spec2.objective, "adicionar cache");
  assert.deepEqual(spec2.criteria, ["latencia menor que 100"]);
  assert.equal(spec2.done_when, "p95 abaixo de 100ms");

  // --- parseGoalSpec: implicit objective + a criterion that itself contains a colon (must not be a label) ---
  const spec3 = parseGoalSpec("corrigir o bug do save\ncriteria:\n- login: retorna 200");
  assert.equal(spec3.objective, "corrigir o bug do save");
  assert.deepEqual(spec3.criteria, ["login: retorna 200"]);

  // --- parseGoalArgs ---
  assert.equal(parseGoalArgs("").action, "status");
  assert.equal(parseGoalArgs("status").action, "status");
  assert.equal(parseGoalArgs("achieve").action, "achieve");
  assert.equal(parseGoalArgs("cancel").action, "abandon");
  assert.equal(parseGoalArgs("abandon").action, "abandon");
  const cm = parseGoalArgs("criterion c1 met o teste passou");
  assert.deepEqual([cm.action, cm.criterionId, cm.evidence], ["criterion_met", "c1", "o teste passou"]);
  assert.throws(() => parseGoalArgs("criterion c1 done x"), /criterion <id> met/);
  assert.equal(parseGoalArgs("plan").action, "plan");
  assert.equal(parseGoalArgs("plan plan-123").planId, "plan-123");
  assert.equal(parseGoalArgs("show goal-1").action, "show");
  const setParsed = parseGoalArgs("set\nobjective: algo claro aqui\ncriteria:\n- retorna 200\ndone_when: ve o dashboard");
  assert.equal(setParsed.action, "set");
  assert.equal(setParsed.spec.objective, "algo claro aqui");

  // --- runGoalCommand: empty status ---
  const emptyStatus = await runGoalCommand({ args: "", projectRoot: tempRoot, now });
  assert.equal(emptyStatus.active, null);
  assert.match(formatGoalCommandResult(emptyStatus), /no active goal/);

  // --- runGoalCommand: set REJECTED (structural + vague) ---
  const rejected = await runGoalCommand({ args: "set\nobjective: fix\ncriteria:\n- x\ndone_when: y", projectRoot: tempRoot, now, randomBytes: fixedRandom });
  assert.equal(rejected.accepted, false);
  assert.match(formatGoalCommandResult(rejected), /NOT accepted/);

  // --- runGoalCommand: set ACCEPTED ---
  const setArgs = [
    "set",
    "objective: implementar login de usuarios com sessao",
    "criteria:",
    "- o login retorna 200 e cria a sessao",
    "- logout invalida o token",
    "done_when: usuario loga e ve o dashboard",
  ].join("\n");
  const accepted = await runGoalCommand({ args: setArgs, projectRoot: tempRoot, now, randomBytes: fixedRandom });
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));
  assert.match(formatGoalCommandResult(accepted), /ACCEPTED/);

  // --- status now shows the active goal ---
  const status = await runGoalCommand({ args: "status", projectRoot: tempRoot, now });
  assert.equal(status.active.goal.objective, "implementar login de usuarios com sessao");
  assert.match(formatGoalCommandResult(status), /0\/2 met/);

  // --- achieve blocked while criteria are unmet ---
  const blocked = await runGoalCommand({ args: "achieve", projectRoot: tempRoot, now });
  assert.equal(blocked.achieved, false);
  assert.equal(blocked.unmet.length, 2);
  assert.match(formatGoalCommandResult(blocked), /NOT achievable/);

  // --- mark criteria met, then achieve ---
  const met1 = await runGoalCommand({ args: "criterion c1 met verify.log mostra 200 no POST /login", projectRoot: tempRoot, now });
  assert.equal(met1.met, 1);
  assert.match(formatGoalCommandResult(met1), /1\/2 criteria met/);
  await runGoalCommand({ args: "criterion c2 met suite de auth cobre logout", projectRoot: tempRoot, now });
  const achieved = await runGoalCommand({ args: "achieve", projectRoot: tempRoot, now });
  assert.equal(achieved.achieved, true);
  assert.match(formatGoalCommandResult(achieved), /ACHIEVED/);

  console.log("AIPI_GOAL_COMMAND_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
