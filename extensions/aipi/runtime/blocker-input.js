export const BLOCKER_FREE_TEXT_OPTION = "✍️  Escrever outra resposta…";
export const MAX_BLOCKER_OPTIONS = 3;

export function normalizeBlockerOptions(options) {
  if (!Array.isArray(options)) return [];
  const seen = new Set();
  const normalized = [];
  for (const option of options) {
    const value = String(option ?? "").replace(/\s+/g, " ").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
    if (normalized.length >= MAX_BLOCKER_OPTIONS) break;
  }
  return normalized;
}

export function normalizeBlockerQuestion(value, {
  fallbackQuestion = "",
  fallbackReason = "",
} = {}) {
  const source = normalizeQuestionSource(value);
  const question = source.question ||
    String(fallbackQuestion || fallbackReason || "AIPI precisa de uma decisão do usuário para continuar.").trim();
  return {
    question,
    options: normalizeBlockerOptions(source.options),
    allow_free_text: source.allow_free_text !== false,
  };
}

export function blockerQuestionFromStepResult(result, {
  fallbackQuestion = "",
  fallbackReason = "",
} = {}) {
  const source =
    result?.blocker_question ??
    result?.awaiting_user_input ??
    result?.user_question ??
    result?.question ??
    null;
  return normalizeBlockerQuestion(source, { fallbackQuestion, fallbackReason });
}

export function awaitingUserInputFromStepResult({
  step,
  result,
  reason = "",
  createdAt,
} = {}) {
  const blocker = blockerQuestionFromStepResult(result, {
    fallbackQuestion: reason,
    fallbackReason: reason,
  });
  return {
    step_id: step?.id ?? result?.step_id ?? null,
    reason,
    created_at: createdAt ?? new Date().toISOString(),
    question: blocker.question,
    options: blocker.options,
    allow_free_text: true,
  };
}

export function formatAwaitingUserInputPrompt(awaiting = {}) {
  const blocker = normalizeBlockerQuestion(awaiting, {
    fallbackReason: awaiting?.reason,
  });
  const lines = [
    "AIPI workflow bloqueado aguardando decisão do usuário.",
    "",
    blocker.question,
  ];
  if (blocker.options.length) {
    lines.push("", "Opções recomendadas:");
    for (const [index, option] of blocker.options.entries()) {
      lines.push(`${index + 1}. ${option}`);
    }
    lines.push("", "Você também pode escrever outra resposta em texto livre.");
  }
  return lines.join("\n");
}

function normalizeQuestionSource(value) {
  if (typeof value === "string") {
    return { question: value.trim(), options: [], allow_free_text: true };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { question: "", options: [], allow_free_text: true };
  }
  const question = String(value.question ?? value.prompt ?? value.title ?? "").replace(/\s+/g, " ").trim();
  return {
    question,
    options: value.options,
    allow_free_text: value.allow_free_text,
  };
}
