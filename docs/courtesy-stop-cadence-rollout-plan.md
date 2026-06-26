# Plano de implantação — eliminar paradas de cortesia / cadência no autonomous-execute

Status: proposto · Data: 2026-06-25 · Escopo: engine AIPI (`extensions/aipi/runtime`, `templates/.aipi`, `tools/test-*.mjs`)

## 1. Problema

Durante o autonomous-execute, o AIPI encerra o turno com uma pergunta de **cortesia/cadência**
(ex.: *"Quer que eu mantenha esse ritmo de checkpoints ou prefere ir direto até a PR?"*) que **não é
um gate real** — nenhuma decisão do usuário é necessária — e a execução **estagna** esperando resposta.

Não é um bug; são **três pontos de vazamento com uma raiz só**: *cadência/ritmo de trabalho não tem
casa no modelo de dados*, então o agente improvisa a pergunta, e nada distingue "pergunta de cortesia"
de "gate real".

| # | Onde | Mecanismo | Fase que conserta |
|---|------|-----------|-------------------|
| **1** | Host orchestrator (auto-dispatch OFF = default) | Encerra o turno com a pergunta e não re-invoca `/aipi-plan execute`. O *return value* do hook de fim-de-turno não re-prompta, **mas** existe `pi.sendMessage(msg,{triggerTurn:true})` que força um novo turno (ver §3 gotcha #1b). | F1 (diretiva seeded) + F2 (texto estático do context-pointer) + F4 (rede no message_end: surface **ou** auto-continue via triggerTurn) |
| **2** | Run forkado — **courtesy-stop fabricado** (Sink B) | Gate-stop sem rota `on_verdict` → `shouldAskUserOnGateStop` (`workflow-executor.js:1706-1710`) + `defaultBlockedGateQuestion` inventam um *"Como você quer seguir?"* que o worker nunca pediu → `blocked` → plano trava (`plan-executor.js:106-109`). **≠ Sink A** (no-adapter/transient, `:288-305`, onde o trabalho não rodou — esse NÃO auto-continua). | F3 (flag `synthesized` **só no Sink B** + auto-continue) |
| **3** | Run forkado — worker improvisa | Sem cadência no modelo, o worker emite a pergunta como blocker via `BLOCKED_TO_PLANNING: stop_for_user_question`. Re-perguntada a cada task. | F1 (diretiva seeded) + **F2 (Rules do worker — alavanca durável; o seed da F1 é eviction-prone, ver §3 gotcha #8)** |

## 2. Princípios de integração (andar nos trilhos que já existem)

- **Default em tempo de leitura, não migração.** Não há validador nem migration runner para `PLAN.json`
  (`readPlanState` é um `JSON.parse` cru, `plan-state.js:380-383`). O default do campo novo entra no **read
  chokepoint** → back-fill preguiçoso na primeira escrita. Schema continua `aipi.plan.v1` (mudança aditiva).
- **Trilho de seeding existente.** O executor já replica respostas no run via `recordUserInput(source:"plan_preflight")`
  (`plan-executor.js:80-90`, *"no mid-run re-asking of what the plan already settled"*). A diretiva de cadência
  anda nesse mesmo trilho.
- **Gate de settle como fronteira "definição fechada".** `settlePlan` (`plan-state.js:234-246`) é o ponto único
  onde a cadência é congelada (espelha os guards `status !== "discovery"` de `recordPlanAnswer`/`addPlanQuestions`).
- **Disciplina de evals.** Cenário novo precisa do gêmeo programático em `MODEL_PRESSURE_SCENARIOS`, senão o
  `test-model-pressure-evals.mjs` quebra a cadeia do `npm test`. Graduação `predicted→observed` é **evidência
  model-backed**, não edição de código.
- **Convenção de testes.** Sem framework. Cada suíte é `tools/test-<area>.mjs` rodada via `npm run test:<area>`;
  agregado é `npm test` (cadeia `&&`).

## 3. ⚠️ Gotchas de integração (achados das costuras — leia antes de codar)

1. **Protocolos NÃO são injetados (mas existem em disco).** `templates/.aipi/protocols/default.md` (Autonomy Rule),
   `business-rules.md` (Autonomy Law) e `behavioral-discipline.md` são **doc de referência** — `project-init.js
   copyTree` (`:139-174`) os copia pra `<projeto>/.aipi/protocols/`, mas **nenhum código de runtime lê o conteúdo
   deles num prompt**. Editá-los **não muda comportamento** (o agente só os veria se decidisse `read` por conta).
   ⚠️ **Armadilha de nome:** `.aipi/memory/project/business-rules.md` (gerado no onboarding, **é** referenciado todo
   turno via `PROJECT_GUIDANCE_REFS`) é um arquivo **diferente** de `.aipi/protocols/business-rules.md` (inerte).
   As superfícies reais:
   - **Turno default do coordinator (sem run ativo — o caso #1):** só chega o texto estático de
     `renderContextPointer` (`lifecycle-hooks.js:~3181-3186`) + `PROJECT_GUIDANCE_REFS`. Disciplinas (`finish-turn`,
     `outcome-first`) **não** chegam aqui (`loadAndRecordActiveDisciplines` retorna `[]` quando `!snapshot.active`,
     `:3287`; branch sem-run manda `active_disciplines: []`, `:2099`).
   - **Coordinator durante run ativo:** disciplinas `.md` são injetadas verbatim (truncadas em 1800 chars).
   - **Worker AIPI (forkado):** `subagents.js buildWorkerPrompt` bloco `"Rules:"` (`:802-810`) — **nunca** vê
     `worker.md` nem disciplinas.
   - **Worker vendor (pi-subagents/contact_supervisor):** `vendor/.../agents/worker.md` (`:22`) + template do
     `intercom-bridge.ts` (`:34`).
   → Para o sintoma do usuário (#1), a edição **load-bearing** é o **texto estático do `renderContextPointer`**,
     não os `.md`.
   - **1b. O host PODE auto-continuar (correção do adversarial, claim C).** O *return value* de um hook de
     fim-de-turno não re-prompta (`message_end` só retorna `undefined`/mensagem do mesmo papel — `extensions.md:561`),
     **mas** o `ExtensionAPI` expõe `pi.sendMessage(msg,{triggerTurn:true})`, que injeta uma mensagem e **força um
     novo turno do main agent sem input do usuário** (host: `agent-session.js:1003-1004` → `_runAgentPrompt`). O
     próprio pi-subagents já usa isso (`notify.ts`, `control-notices.ts`) para re-engajar o main agent após trabalho
     async — disparado de um **handler de evento async/pós-turno** (`pi.events.on`), **não** sincronamente de dentro
     do hook (onde a sessão ainda está streaming e o `triggerTurn` vira fila). Logo F4 é decisão de **produto**
     (queremos auto-continue não-supervisionado, com loop-guard?), não um limite técnico.
2. **`MAX_DISCIPLINE_CHARS = 1800`** (`lifecycle-hooks.js:65,3280`) trunca disciplinas. Adições em `finish-turn.md`
   têm de ser **curtas**, ou regras anteriores caem silenciosamente.
3. **Dois prompts de worker distintos** (`buildWorkerPrompt` vs `worker.md`+`intercom-bridge`). Editar um deixa o
   outro vazando. Edite **ambos**.
4. **Acoplamento dos evals.** `test-model-pressure-evals.mjs:24-27` exige que todo cenário tenha gêmeo em
   `MODEL_PRESSURE_SCENARIOS` **e** que a disciplina esteja `status: predicted`. Não dá pra flipar `finish-turn`
   para `observed` enquanto S9/S10 a referenciam sem resolver esse acoplamento. Graduação exige rodar o harness
   2× (baseline FAIL + verify PASS) e gravar 2 JSONs — **fora do PR de código**.
5. **`buildDiscoveryReport().instruction`** é asado por `.includes("Autonomy Law")` (`test-plan-command.mjs:117`).
   **Anexe**, não substitua.
6. **Legacy `PLAN.json`** sem o campo lê `undefined`. Gate sempre em `=== "checkpoint_per_task"` (default-falsy)
   e aplique o default no read chokepoint.
7. **Double-handling (F3) — RESOLVIDO (claim K recheck).** F3 **não** é redundante com o auto-detach de
   `readActiveRun` (`run-state.js:235-247`): o `executePlanRun` chama `executeWorkflowRun` **direto** e lê
   `execution.status` — o loop do plano **nunca** passa por `readActiveRun`, então o auto-detach não dispara no
   caminho do executor (o block vira `blocked` → `halted=true`, trava). E onde `readActiveRun` é alcançado, ele
   **ABANDONA** o run (`status="abandoned"`, `clearActiveRun`) — o **oposto** de auto-continuar. Donos distintos:
   meta-kind = "não re-aprisionar na próxima leitura"; F3 = "não travar o loop num stop fabricado". Manter o
   `synthesized` distinto do `workflow_blocked_decision`.
8. **O seed da F1 é eviction-prone (correção do adversarial, claim F1).** A diretiva `plan_cadence` chega ao worker
   (USER-INPUT.jsonl → `materializeRunUserInputs` → `context.user_inputs` → `context_packet` → `buildWorkerPrompt`),
   mas `materializeRunUserInputs` guarda só os **últimos 4** user-inputs (`refs.slice(-4)`, `context-builder.js:339`)
   e trunca texto em **1200 chars** (`:332`), e o seed chega como **JSON aninhado**, não linha de diretiva. ⇒
   **seedar por último** E manter a regra explícita no `buildWorkerPrompt` "Rules:" (F2) como alavanca durável do #3.
9. **Sink A ≠ Sink B (correção do adversarial, claim D — segurança).** No `workflow-executor.js` há **dois** sinks
   que viram `state.status="blocked"`: **Sink A** (`:288-305`) = `no-executable-adapter`/transient → **o passo não
   rodou** (fallback recusa auto-stamp PASS, `:376`); **Sink B** (`:335-348`) = `shouldAskUserOnGateStop` +
   `defaultBlockedGateQuestion` **inventam** um blocker que o worker nunca pediu. **Só o Sink B** pode auto-continuar.
   Marcar Sink A como `synthesized` **pularia uma task que não executou** e rodaria dependências em estado incompleto.

## 4. Fases (ordenadas por ROI × risco; cada uma mergeável sozinha)

### Fase 1 — Dar casa à cadência (raiz; baixo risco) ⭐ maior alavanca

**Objetivo:** o campo `execution_cadence` existe, tem default, é congelado no settle e **seeded como diretiva**
em todo run — removendo o *motivo* de improvisar a pergunta (cobre #1 e #3 na origem).

| Arquivo | Símbolo | Mudança |
|---------|---------|---------|
| `plan-state.js` | `createPlan()` literal (`77-101`) | Adicionar `execution_cadence: "checkpoint_per_task",` (default **conservador** — preserva controle do usuário; ver §8b claim L). |
| `plan-state.js` | `readPlanState()` (`380-383`) | Após o `JSON.parse`: normalizar — `plan.execution_cadence = ["autonomous_to_pr","checkpoint_per_task"].includes(plan.execution_cadence) ? plan.execution_cadence : "checkpoint_per_task";` (default p/ legacy + back-fill na 1ª escrita). |
| `plan-state.js` | `settlePlan()` (`234-246`) | Garantir valor antes do freeze (`if (!plan.execution_cadence) plan.execution_cadence = "checkpoint_per_task";`) + assert do enum. |
| `plan-state.js` | `renderPlanManifest()` (`425-463`) | Emitir `execution_cadence` no front-matter (`?? "checkpoint_per_task"`). |
| `plan-executor.js` | `executePlanRun()` seeding block (`80-90`) | `recordUserInput({ runId, source:"plan_cadence", text: "EXECUTION CADENCE (plan-level, do not re-ask): " + plan.execution_cadence + ". checkpoint_per_task = pausa entre tasks; autonomous_to_pr = corre até a PR, para só em bloqueio real. Em ambos: NÃO pergunte ritmo/cadência — está decidido." })` — 1× por run. **Seedar por último** (gotcha #8). |
| `plan-executor.js` | halt loop (`106-109`) | ⚠️ **NÃO wirar por default.** O executor hoje corre todas as tasks até o fim (status quo confirmado — claim A/L); fazer `checkpoint_per_task` pausar entre tasks **mudaria** esse status quo. Efeito **garantido** do campo = (1) diretiva seeded anti-cortesia + (2) gate do auto-continue do host (F4). A pausa **no executor** é opt-in separado (§6 decisão #2), não amarrada ao default. |

**Testes:** `test-plan-state.mjs` (default no `createPlan`; round-trip persist→read; PLAN.json antigo sem o campo
→ read aplica default; settle congela). `test-plan-executor.mjs` (assert do seed `plan_cadence`; se comportamental,
`checkpoint` pausa entre tasks e `autonomous` não). `test-plan-policy.mjs` (sanity: gates passam com o campo).

**Backward-compat:** coberto pelo default no read chokepoint (gotcha #6). Schema fica `v1` (aditivo). Default
`checkpoint_per_task` preserva controle do usuário **e** mantém o auto-continue do host (F4) **off-by-construction**
para quem não optou (claim L).
**Flag de rollout:** o campo é aditivo; o efeito garantido (diretiva seeded + gate do F4) não muda o executor.
**Done:** `npm run test:plan-state && npm run test:plan-executor && npm run test:plan-policy` verdes; um PLAN.json
legado lê com cadência preenchida (`checkpoint_per_task`).

### Fase 2 — Dar dentes ao prompt (zero risco de runtime)

**Objetivo:** proibir explicitamente perguntas de cadência/checkpoint/permissão-pra-continuar nas **superfícies que
realmente chegam ao modelo** (não nos protocolos de referência) — **sem** suprimir gates reais.

⚠️ **Regra POSITIVA obrigatória (correção do adversarial, claim J).** Cada uma das 4 superfícies injetadas abaixo
precisa, junto da proibição, dizer o que **fazer**: *"Se você encontrar um gate real (destrutivo/secrets/prod/escopo/
regra de negócio), **ESTRUTURE** como blocker (`BLOCKED`/`BLOCKED_TO_PLANNING` + `blocker_question`) — não encerre
como prosa nem pule."* Sem isso, o "perguntar menos" empurraria um gap de regra de negócio (expresso como pergunta
solta) pra zona de supressão. O caminho **estruturado** já é estruturalmente protegido; a regra positiva força o gap
real a virar blocker estruturado em vez de prosa.

| Arquivo | Símbolo | Mudança | Alcança |
|---------|---------|---------|---------|
| `lifecycle-hooks.js` | `renderContextPointer` texto estático (`~3181-3186`) | Linha: *"Durante execução autônoma, NÃO encerre o turno com pergunta de cadência/checkpoint/permissão ('quer que eu siga?', 'mantenho o ritmo?'). Siga para o próximo passo. Pare só por um gate real (destrutivo/secrets/prod/escopo/regra de negócio)."* | **Coordinator no turno default (sem run)** — o caso #1 |
| `subagents.js` | `buildWorkerPrompt` `"Rules:"` (`802-810`) | Mesma regra, 1 bullet. | **Worker AIPI forkado** |
| `vendor/.../agents/worker.md` | linha `22` | Estender o "choose-one" para incluir cadência/pacing/permissão. | Worker vendor (systemPrompt base) |
| `vendor/.../intercom-bridge.ts` | `DEFAULT_INTERCOM_BRIDGE_TEMPLATE` (`30-39`) | Idem na `:34`. | Todo fork com intercom (maior cobertura) |
| `templates/.aipi/disciplines/finish-turn.md` | Rules + Red Flags (curto!) | Regra: cadência/checkpoint/pacing nunca é motivo de parada. (gotcha #2: ≤1800 chars) | Coordinator/worker **durante run ativo** |
| `templates/.aipi/disciplines/outcome-first.md` | `:19` | Nomear "cadence/permission meta-questions" junto de "offer tails". | Reply-shape em vários papéis |
| `templates/.aipi/protocols/default.md` + `business-rules.md` + `behavioral-discipline.md` | Autonomy Rule/Law/Precedence | *(doc-only)* registrar a regra p/ consistência — **flag explícita de que não é injetado** (gotcha #1). | Nenhum (referência) |

**Eval (acoplado — fazer junto):** adicionar `## S10 - finish-turn: courtesy check-in mid-autonomous-execute` em
`pressure-scenarios.md` (com a frase de comportamento desejado em *"The target agent should…"* para o stripper de
baseline) **+** gêmeo em `model-pressure-scorer.js MODEL_PRESSURE_SCENARIOS`
(`{ id:"S10", discipline:"finish-turn", required:[/continue|finish|next task/i], forbidden:[/should i|keep going|is this ok|want me to continue|mantenho o ritmo|quer que eu/i] }`). `finish-turn` **permanece `predicted`**.

**Testes:** `npm run test:model-pressure-evals` (gêmeo presente, disciplina `predicted`); asserts de presença das
strings em `buildWorkerPrompt`/intercom template; `test-plan-command` continua verde (Autonomy Law intacto).
**Backward-compat:** nenhum risco de runtime; só texto de prompt.
**Done:** `npm test` verde; revisão manual confirma a regra nos 4 surfaces injetados.

### Fase 3 — Rede de código no run forkado (médio risco) — conserta #2

**Objetivo:** auto-continuar **APENAS** o courtesy-stop fabricado (Sink B), e rotear o que de fato falhou (Sink A:
no-adapter/transient) para **retry/re-dispatch ou fail-loud** — nunca pular. *(Correção crítica do adversarial: a
versão anterior marcava Sink A como `synthesized` e o pularia — §3 gotcha #9.)*

| Arquivo | Símbolo | Mudança |
|---------|---------|---------|
| `step-result.js` | `optional[]` (`16-19`) | Registrar `"synthesized"`, `"synthesized_kind"` (contrato aditivo sancionado). |
| `workflow-executor.js` | **Sink B** `:335-348` (`shouldAskUserOnGateStop`+`awaitingUserDecisionForBlockedGate`) | **Só aqui** marcar `synthesized: true` / `synthesized_kind:"fabricated_courtesy_stop"` quando o blocker foi inventado (worker não trouxe `blocker_question` próprio). |
| `workflow-executor.js` | **Sink A** `:288-305` (`structuralNoAdapter`/`transientProviderBlock`) | **NÃO** marcar `synthesized`. Rotear para **re-dispatch/retry** (o engine já oferece "Tentar novamente" em `defaultBlockedGateQuestion:1769-1782`) ou **halt fail-loud**. Permanece travando — é falha de infra, não cortesia. |
| `blocker-input.js` | `awaitingUserInputFromStepResult` (`45-66`) | Carregar `synthesized` no objeto awaiting (espelhar `if (kind) awaiting.kind = kind`, `:64`). |
| `plan-executor.js` | loop body (`93-109`) | Ler `execution?.state?.awaiting_user_input?.synthesized === true` **e** `synthesized_kind === "fabricated_courtesy_stop"` (strict; legacy/Sink A = falsy → ainda trava) → `continue` em vez de `halted=true`. Decisão no corpo do loop (state-aware), **não** em `mapRunStatusToTask`. |
| `run-state.js` | `isRecoverableBlockedDecision` (`251-254`) | *(decidir dono — gotcha #7)* manter `synthesized` distinto do `workflow_blocked_decision`. |

**3-vias (com o stop-classifier Haiku — ver §4b):** o discriminador "courtesy vs infra vs gate real" pode ser regex
(piso) **ou** o classificador semântico. Idealmente o classificador decide o `synthesized_kind` no Sink B/gate-stop:
`continue` (cortesia → auto-continua) · `retry_infra` (Sink A → re-dispatch/fail-loud) · `real_gate` (abre blocker).

**Testes:** `test-workflow-executor.mjs` (`57-92` **Sink A → synthesized AUSENTE**, ainda trava; novo caso Sink B
fabricado → `synthesized:true`; `313-364` worker real → synthesized ausente). `test-plan-executor.mjs` (`102-117`:
Sink B → `halted:false` e próxima task inicia; Sink A e blocker real → ainda trava — **enriquecer o mock `executeRun`**
que hoje só retorna `{status}`). `test-step-result.mjs` (synthesized valida OK; sibling extra passa
`validateBlockerQuestion`). `test-run-state.mjs` (auto-detach legacy intacto).
**Backward-compat:** gate estrito `=== true` + `synthesized_kind` específico; campos aditivos no `optional[]`. **Flag:**
`state.plan_id` já é proxy de "run sob plano"; gate o auto-continue nisso.
**Done:** suites verdes; **Sink B (courtesy) não trava o plano; Sink A (no-adapter) AINDA trava/retry** (nunca pula).

### Fase 4 — Rede no host (opcional) — agora com auto-continue REAL

**Objetivo:** quando o coordinator host encerra com pergunta de cortesia e há plano executando com task pendente,
**detectar** e **auto-continuar** (ou, em modo conservador, surfacear + 1-toque). *(Correção do adversarial, claim C:
o host **pode** auto-continuar — não é limite técnico.)*

**Mecanismo — dois caminhos distintos:**
- **(a) Return value do hook** (`handleEndDisciplineAudit` em `message_end`): **não** re-prompta — serve só p/
  `safeNotify` ou substituir a msg do mesmo papel.
- **(b) `pi.sendMessage(msg,{triggerTurn:true})`** disparado de um **handler async/pós-turno** (`pi.events.on`,
  padrão do `notify.ts`/`control-notices.ts`): **força um novo turno** do main agent sem input do usuário. É o
  auto-continue de verdade.

| Arquivo | Símbolo | Mudança |
|---------|---------|---------|
| `lifecycle-hooks.js` | `handleEndDisciplineAudit` branch `message_end` (`~2204`) | **Detectar** a parada de cortesia: reusar detector de pergunta-pura de `isCompletionClaim` (`1744-1745`) + regex cadência (ou o stop-classifier §4b); só se `role==="assistant"`, sem `isAwaitingUserInput`, e `hasActivePlan` com task pendente. Registrar o sinal. |
| `lifecycle-hooks.js` / `index.js` | novo handler async (`pi.events.on`) | No modo auto-continue: `pi.sendMessage({customType:"aipi.auto-continue",display:false,content:"Continue. Cadência já decidida (autonomous); não pergunte ritmo/checkpoint — siga para a próxima task."},{triggerTurn:true})`. **Loop-guard** obrigatório (contador de auto-continues consecutivos + dedupe estilo `lastSurfacedClaimWarning`) p/ não entrar em loop se o agente insistir. |

**Modos (flag `AIPI_HOST_AUTOCONTINUE`):** `off` (default) = só `safeNotify` + 1-toque (o roteador já mapeia
`segue/continua/pode seguir` → continue, `:1005`); `on` = auto-continue via `triggerTurn` com loop-guard.
**Decisão de produto:** auto-continue não-supervisionado no host é poderoso mas precisa do loop-guard e respeitar
`execution_cadence` (se `checkpoint_per_task`, **não** auto-continua — o usuário quer checkpoint).
**Testes:** `test-lifecycle-hooks.mjs` (detecta cortesia com plano ativo; **não** dispara em turno interativo legítimo,
sem plano, ou sob `checkpoint_per_task`; loop-guard corta após N). **Done:** stall de cortesia vira aviso+1-toque
(modo off) ou auto-continue limitado (modo on).

### Fase 4b — Stop-classifier Haiku (OPCIONAL; só depois do pré-requisito de taxonomia)

**Hipótese validada:** o AIPI já tem o shape — `applyAutoDispatchVeto` (`lifecycle-hooks.js:1421-1488`) é um veto LLM
opcional com `withTimeout(1500ms)` e verdict logado. Mas o adversarial (claim I) mostrou que **NÃO dá pra congelar do
jeito anterior** — duas premissas eram falsas contra o código. Correções obrigatórias:

⚠️ **Pré-requisito que não existe ainda.** A premissa "piso determinístico é autoridade; Haiku só no ambíguo" assumia
uma taxonomia de gate (destrutivo/secrets/prod/regra) no blocker. **Ela não existe:** `validateBlockerQuestion`
(`step-result.js:441`) valida só forma; `shouldAskUserOnGateStop` (`:1706`) chaveia em target+status; o único
discriminador determinístico é a regex de no-adapter (`:1771`). ⇒ **Primeiro** landar um campo `gate_kind`
(`destructive|secrets|prod|business_rule|courtesy`) emitido no Sink B/gate-stop e validado em `step-result.js`.
**Sem esse piso, "Haiku só no ambíguo" é indefinível** e o LLM acabaria julgando exatamente a fronteira `real_gate`
que ele nunca deveria tocar.

| Item | Decisão (corrigida) |
|------|---------------------|
| **Modelo** | classe de baixo esforço **da família do host** (`context-fast`); **NÃO** `verifier-fast` — é `CROSS_FAMILY_REVIEW_CLASS` (`model-router.js:7`) e pode resolver fora da família. |
| **Saída** | **3-vias** sobre o piso `gate_kind`: `continue` · `retry_infra` (Sink A) · `real_gate`. |
| **Direção de falha (CRÍTICO)** | **NÃO** é fail-open-pro-regex como `applyAutoDispatchVeto` (lá o regex já pré-computou rota conservadora; aqui **não há** rota de stop pré-computada). Timeout/erro/qualquer dúvida → **fail-STOP / keep-blocked**. Fail-open-pra-continue = blow-past = inseguro. |
| **Autoridade do piso** | o piso determinístico é **estritamente** autoridade pra PARAR. O Haiku só pode **rebaixar** `stop→continue` quando **zero tokens de alto risco** E há sinal estruturado de cortesia. **Nunca** sobe `continue→stop`; **nunca** decide com token de alto risco presente. |
| **Não é árbitro solitário** | 1 call Haiku de baixo esforço não é suficiente como único árbitro da fronteira `real_gate` (custo assimétrico: 1 falso-`continue` num gate destrutivo é irreversível). Gate atrás do piso; painel/redundância só pro resíduo genuinamente ambíguo. |
| **Testabilidade** | flag `AIPI_STOP_CLASSIFIER=1`; logar **a decisão do piso junto** do verdict do LLM (replay prova que o piso, não o LLM, decidiu cada STOP). |

**Status: OPCIONAL e gated no pré-requisito `gate_kind`.** Complementa F1/F2 (que derrubam a taxa na origem) — é a
**rede** pro resíduo, **não** substitui F1/F2. Posture un-wired do classificador já falha-pra-STOP (seguro). Se o
pré-requisito não for feito, **não** ative §4b.

### Fase 5 — Estrutural (opcional; "se 'desencorajado' não basta")

Rotear a execução multi-task pelo **executor forkado** (onde pausar **exige** blocker estruturado validado), em vez
do agente host. Aí a parada de cortesia estilo-host vira **impossível**. Mudança maior, altera UX (menos narração no
host). Tratar como decisão de produto separada; pré-requisito = F3 estável.

## 5. Sequência, dependências e PRs

**Núcleo mínimo que conserta o sintoma confirmado (claim A = host): F1 + F2.** O resto são redes.

```
F1+F2 (NÚCLEO: campo+seed+prompt)  ──►  conserta #1 e #3 na origem
   ├──►  F3 (rede forkada: synthesized só no Sink B)         — opcional, conserta #2
   ├──►  F4 (rede host: triggerTurn, flag off-default)        — opcional, decisão de produto
   │        └──►  F4b (Haiku) — opcional, GATED no pré-requisito gate_kind (§4b)
   └──►  F5 (estrutural) — opcional
```

- **PR 1 = F1** (campo, default **checkpoint**, settle, seed) — aditivo, baixo risco, valor sozinho.
- **PR 2 = F2** (prompt nos 4 surfaces injetados + **regra positiva** + S10 + gêmeo scorer) — zero risco runtime.
  → **PR 1+2 = o conserto.** Os demais são incrementais.
- **PR 3 = F3** (synthesized **só Sink B** + auto-continue) — médio risco; **não** redundante (gotcha #7).
- **PR 4 = F4** (rede host, flag `AIPI_HOST_AUTOCONTINUE` off-default) — opcional.
- **PR 4b = F4b** (Haiku) — opcional, **bloqueado** até o campo `gate_kind` existir e ser validado.
- **PR 5 = F5** (estrutural) — opcional, decisão de produto.
- **Follow-up (não-código):** graduar `finish-turn` `predicted→observed` rodando o harness model-backed
  (baseline FAIL em S10 → verify PASS) e gravando os 2 JSONs (`evals/README.md:59-63`). Resolver o acoplamento do
  `test-model-pressure-evals` (gotcha #4) antes de editar `catalog.yaml` status.

## 6. Decisões em aberto

1. **Default da cadência — DECIDIDO (claim L):** `checkpoint_per_task` (conservador, preserva controle do usuário e
   mantém o auto-continue do host off-by-construction para quem não optou); `autonomous_to_pr` = opt-in explícito via
   `/aipi-plan cadence`. *(O papel principal do campo — diretiva seeded que mata a pergunta — independe do default.)*
2. **`checkpoint_per_task` muda o executor (pausa entre tasks)?** ⚠️ **Não por default** — mudaria o status quo do
   executor (corre até o fim, claim A/L). Efeito garantido do campo = diretiva seeded + gate do F4. Pausa no executor
   é opt-in separado.
3. **Comando `/aipi-plan cadence checkpoint|autonomous`?** Custo baixo (verbo novo em `parsePlanArgs` **antes** do
   fallthrough de create; **não** no allow-list singleWord; bare = query read-only). Inclui nota no
   `buildDiscoveryReport` (anexar, manter "Autonomy Law"). Opcional em F1 ou PR próprio.
4. **Dono da recuperação do synthesized-block (F3):** plan-loop vs `readActiveRun` auto-detach (gotcha #7).

## 7. Critério de pronto global

`npm test` verde (cadeia `&&` completa). Reprodução do caminho real: um plano multi-task settle→execute corre
de ponta a ponta sem perguntar cadência; um **courtesy-stop fabricado (Sink B)** não trava o plano, mas um
**no-adapter (Sink A)** AINDA trava/retry (nunca pula); o coordinator no turno default não encerra com pergunta de
cortesia (F2) e, se encerrar, vira aviso+1-toque (F4 off) ou auto-continue com loop-guard (F4 on).

**Teste de não-regressão de segurança (claim J — o mais importante):** um gate **real** (regra de negócio/escopo/
destrutivo/prod/secrets) **continua parando** — estruturado como blocker, nunca pulado nem auto-continuado. O modelo
inteiro empurra "perguntar menos"; este teste prova que ainda pergunta o que **deve**.

## 8. Revisão adversarial (2026-06-25)

6 céticos independentes + recheck das contestadas, lendo o código real para *refutar* cada afirmação load-bearing.

| Claim | Veredito | Efeito no plano |
|-------|----------|-----------------|
| **A** — o sintoma é o turno do host (não run forkado) | ✅ confirmado | Atribuição mantida; `checkpoint_per_task` no executor é **ortogonal** ao sintoma — não vender como o conserto. |
| **B** — protocolos não são injetados | ✅ confirmado | Nuance: estão em disco (`project-init`), só não lidos; armadilha de nome com `memory/project/*.md` (gotcha #1). |
| **C** — host não consegue auto-continuar | ⚠️ **parcial (overreach)** | **F4 reescrita:** `pi.sendMessage(...,{triggerTurn:true})` auto-continua de verdade via handler async (gotcha #1b). |
| **D** — auto-continuar no synthesized é seguro | ❌ **refutado** | **F3 reescrita:** `synthesized`/auto-continue **só no Sink B**; Sink A (no-adapter/transient) → retry/fail-loud (gotcha #9). |
| **F1** — o seed chega ao worker | ✅ confirmado | Mas eviction-prone (últimos-4 + 1200 chars) → **F2 é a alavanca durável** do #3; seedar por último (gotcha #8). |
| **E** — âncoras de linha existem | ✅ confirmado | Mapa de código confiável p/ implementação. |

### 8b. 2ª revisão adversarial — ataque ao modelo *revisado* (antes de fechar)

| Claim | Veredito | Efeito no plano |
|-------|----------|-----------------|
| **G** — F3 conserta o vazamento #3 | ❌ **quebrado** | F3 **não** alcança #3 (worker improvisa cadência como `blocker_question` **próprio** → `hasQuestion=true` → nunca fabricado → não auto-continua). #3 é **só F1+F2**. Plano já roteava assim; framing tensionado. |
| **H** — F4 `triggerTurn` é firável e real | ✅ **holds** | Confirmado contra o host (`agent-session.js:1003`) e uso vendored. **Loop-guard é net-new** + gate contra race de digitação = requisitos duros. |
| **I** — classificador Haiku é seguro como desenhado | ⚠️ **parcial** | **§4b reescrita:** piso `gate_kind` **não existe** → criar primeiro; fail-direction = **STOP** (não fail-open-pra-continue); Haiku só **rebaixa** stop→continue; modelo da **família do host**. §4b vira **opcional+gated**. |
| **J** — o modelo não suprime gate real | ⚠️ **parcial** | Caminho **estruturado** é protegido; gap = pergunta de negócio **não-estruturada**. Fix = **regra positiva** na F2 (estruture gate real como blocker). |
| **K** — 5 fases são justificadas, não over-eng. | ⚠️ **parcial** | **Núcleo = F1+F2**; F4/F4b explicitamente **opcionais**. F3 **não** é redundante (recheck refutou o overreach — gotcha #7). |
| **L** — default `autonomous_to_pr` é seguro | ⚠️ **parcial** | **Default → `checkpoint_per_task`** (conservador); `autonomous_to_pr` = opt-in. F4-on fica off-by-construction p/ não-optados. |

**Modelo fechado:** núcleo **F1+F2** (conserta #1/#3 na origem, baixo risco); **F3** rede forkada para #2 (synthesized
**só Sink B**); **F4** rede host opcional (flag off-default); **F4b** Haiku opcional **gated** no pré-requisito
`gate_kind`; **F5** estrutural opcional. Default conservador. Incertezas residuais explícitas: a graduação de
`finish-turn` exige run model-backed (fora do código); o `gate_kind` é pré-requisito real e não-trivial para §4b.
