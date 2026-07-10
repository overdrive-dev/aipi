import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { normalizeXaiImageInput } from "./images";
import { grokSupportsReasoningEffort, isGrokCliProxyModel } from "./models";
import { textFromResponsesContent } from "./text";

function normalizeResponsesImageParts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeResponsesImageParts);
  if (!value || typeof value !== "object") return value;

  const obj: Record<string, any> = { ...(value as Record<string, any>) };
  if (obj.type === "image" && typeof obj.data === "string" && typeof obj.mimeType === "string") {
    return {
      type: "input_image",
      image_url: `data:${obj.mimeType};base64,${obj.data}`,
      detail: typeof obj.detail === "string" && obj.detail ? obj.detail : "auto",
    };
  }
  if (obj.type === "image_url") {
    const imageUrl = typeof obj.image_url === "object" && obj.image_url ? obj.image_url.url : obj.image_url;
    const detail = typeof obj.image_url === "object" && obj.image_url ? obj.image_url.detail : obj.detail;
    obj.type = "input_image";
    obj.image_url = imageUrl;
    if (typeof detail === "string" && detail) obj.detail = detail;
  }
  if (obj.type === "input_image") {
    const imageUrl = typeof obj.image_url === "object" && obj.image_url ? obj.image_url.url : obj.image_url;
    const detail = typeof obj.image_url === "object" && obj.image_url ? obj.image_url.detail : obj.detail;
    const normalized = normalizeXaiImageInput(imageUrl);
    if (normalized) obj.image_url = normalized;
    if (typeof detail === "string" && detail) obj.detail = detail;
    if (typeof obj.detail !== "string" || !obj.detail) obj.detail = "auto";
  }
  if (Array.isArray(obj.content)) obj.content = normalizeResponsesImageParts(obj.content);
  if (Array.isArray(obj.output)) obj.output = normalizeResponsesImageParts(obj.output);
  return obj;
}

function isResponsesInputImagePart(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && (value as Record<string, any>).type === "input_image";
}

function textForFunctionCallOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return output === undefined || output === null ? "" : JSON.stringify(output);

  const chunks: string[] = [];
  let imageCount = 0;
  for (const part of output) {
    if (isResponsesInputImagePart(part)) {
      imageCount++;
      continue;
    }
    const text = textFromResponsesContent([part]).trim();
    if (text) chunks.push(text);
  }
  if (imageCount > 0) chunks.push(`[${imageCount} image${imageCount === 1 ? "" : "s"} attached in the following user message]`);
  return chunks.join("\n") || (imageCount > 0 ? `[${imageCount} image${imageCount === 1 ? "" : "s"} attached]` : "");
}

function normalizeXaiResponsesInput(input: unknown[], model: Model<Api>): unknown[] {
  const normalizedInput = input.map(normalizeResponsesImageParts) as Record<string, any>[];
  const rewritten: unknown[] = [];
  const modelInputs = Array.isArray((model as any).input) ? ((model as any).input as unknown[]) : [];
  const supportsImages = modelInputs.includes("image");

  for (const item of normalizedInput) {
    if (!item || typeof item !== "object" || item.type !== "function_call_output" || !Array.isArray(item.output)) {
      rewritten.push(item);
      continue;
    }

    // xAI rejects OpenAI Responses' image-bearing tool replay shape:
    //   { type: "function_call_output", output: [{ type: "input_text" }, { type: "input_image" }] }
    // with a 422 ModelInput deserialization error. Keep the required tool
    // output as text and replay images as a normal following user message.
    const outputParts = item.output;
    const imageParts = outputParts.filter(isResponsesInputImagePart);
    const outputText = textForFunctionCallOutput(outputParts);
    rewritten.push({ ...item, output: outputText || "(tool returned no text output)" });

    if (supportsImages && imageParts.length > 0) {
      const label = `The previous tool result${item.call_id ? ` (${item.call_id})` : ""} included ${imageParts.length} image${imageParts.length === 1 ? "" : "s"}. Use the attached image${imageParts.length === 1 ? "" : "s"} as the visual output from that tool.`;
      rewritten.push({
        role: "user",
        content: [{ type: "input_text", text: label }, ...imageParts],
      });
    }
  }

  return rewritten;
}

/** Rewrite generic OpenAI Responses payloads into xAI-compatible payloads. */
export function rewriteXaiResponsesPayload(payload: unknown, model: Model<Api>, options?: SimpleStreamOptions): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const body: Record<string, any> = { ...(payload as Record<string, any>) };
  const modelId = String(body.model || model.id);
  const usesGrokCliProxy = isGrokCliProxyModel(modelId);

  // xAI's Responses API matches the OpenAI surface but has a few stricter
  // edges than pi's generic OpenAI Responses serializer. Hermes solves the
  // same Grok OAuth path with top-level instructions; xAI also rejects
  // image arrays in function_call_output.output, so normalize those here.
  if (Array.isArray(body.input)) {
    let input = normalizeXaiResponsesInput([...body.input], model) as Record<string, any>[];
    const instructionParts: string[] = [];

    if (usesGrokCliProxy) {
      input = input.filter((item) => {
        if (!item || typeof item !== "object") return true;
        if (item.type === "reasoning") return false;
        if (typeof item.content === "string" && item.content.length === 0) return false;
        if (item.role !== "developer" && item.role !== "system") return true;
        const text = textFromResponsesContent(item.content).trim();
        if (text) instructionParts.push(text);
        return false;
      });
    } else {
      while (input.length > 0) {
        const first = input[0];
        if (!first || typeof first !== "object" || (first.role !== "developer" && first.role !== "system")) break;
        const text = textFromResponsesContent(first.content).trim();
        if (text) instructionParts.push(text);
        input.shift();
      }
    }

    if (instructionParts.length > 0) {
      body.instructions = [body.instructions, ...instructionParts].filter((part) => typeof part === "string" && part).join("\n\n");
    }
    body.input = input;
  } else if (typeof body.input === "string") {
    // String input is valid and should stay string-shaped.
  }

  if (body.response_format && !body.text) {
    body.text = { format: body.response_format };
    delete body.response_format;
  }

  if (body.reasoning && typeof body.reasoning === "object") {
    const effort = body.reasoning.effort;
    if (typeof effort === "string" && effort !== "none" && grokSupportsReasoningEffort(modelId)) {
      body.reasoning = { effort: effort === "minimal" ? "low" : effort };
    } else {
      delete body.reasoning;
    }
  }

  if (usesGrokCliProxy && Array.isArray(body.include)) {
    body.include = body.include.filter((item: unknown) => item !== "reasoning.encrypted_content");
    if (body.include.length === 0) delete body.include;
  }

  // xAI doesn't implement OpenAI's prompt_cache_retention knobs. Keep the
  // cache key (Responses API body field), but remove retention.
  // Docs: https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits
  // prompt_cache_key routes a conversation to the same server so cache hits
  // are reliable; without it multi-turn agent loops often pay full input price.
  delete body.prompt_cache_retention;
  const cacheKey =
    (typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim()) ||
    (typeof options?.sessionId === "string" && options.sessionId.trim()) ||
    "";
  if (cacheKey) body.prompt_cache_key = cacheKey;
  else delete body.prompt_cache_key;

  return body;
}
