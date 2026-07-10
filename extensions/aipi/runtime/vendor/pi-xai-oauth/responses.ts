import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { randomUUID } from "crypto";
import { isGrokCliProxyModel, xaiBaseUrlForModel, xaiModelForRequest, xaiModelRequestHeaders, xaiResponsesUrlForModel } from "./models";
import { rewriteXaiResponsesPayload } from "./payload";

type AssistantStreamEvent = Record<string, any>;

function resultFromStreamEvent(event: AssistantStreamEvent): any {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  return undefined;
}

function createForwardingAssistantStream() {
  const queue: AssistantStreamEvent[] = [];
  const waiting: Array<(result: IteratorResult<AssistantStreamEvent>) => void> = [];
  let done = false;
  let resolveResult: (result: any) => void = () => {};
  const resultPromise = new Promise<any>((resolve) => {
    resolveResult = resolve;
  });

  function finish(result: any) {
    if (done) return;
    done = true;
    resolveResult(result);
  }

  return {
    push(event: AssistantStreamEvent) {
      const finalResult = resultFromStreamEvent(event);
      const isTerminal = event.type === "done" || event.type === "error";
      if (isTerminal) finish(finalResult);
      if (done && !isTerminal) return;
      const waiter = waiting.shift();
      if (waiter) {
        waiter({ value: event, done: false });
      } else {
        queue.push(event);
      }
    },
    end(result?: any) {
      finish(result);
      while (waiting.length > 0) {
        waiting.shift()?.({ value: undefined as any, done: true });
      }
    },
    result() {
      return resultPromise;
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else if (done) {
          return;
        } else {
          const result = await new Promise<IteratorResult<AssistantStreamEvent>>((resolve) => waiting.push(resolve));
          if (result.done) return;
          yield result.value;
        }
      }
    },
  };
}

function streamErrorMessage(model: Model<Api>, error: unknown) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

/** POST a JSON body to an xAI endpoint with OAuth bearer auth. */
export async function postXaiJson(
  apiKey: string,
  url: string,
  body: Record<string, any>,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    const error = new Error(errorText);
    (error as any).status = response.status;
    throw error;
  }

  return response.json();
}

/** Create a single xAI Responses API response with model-aware routing. */
export async function createXaiResponse(apiKey: string, body: Record<string, any>, signal?: AbortSignal): Promise<any> {
  const model = xaiModelForRequest(typeof body.model === "string" ? body.model : undefined);
  const payload = rewriteXaiResponsesPayload(body, model) as Record<string, any>;
  const usesGrokCliProxy = isGrokCliProxyModel(model.id);
  const grokCliSessionId = usesGrokCliProxy
    ? (typeof body.previous_response_id === "string" && body.previous_response_id) || randomUUID()
    : undefined;
  return postXaiJson(
    apiKey,
    xaiResponsesUrlForModel(model.id),
    payload,
    signal,
    xaiModelRequestHeaders(model.id, grokCliSessionId),
  );
}

/**
 * Stream pi's simple Responses flow through xAI with payload normalization.
 *
 * The transport is delegated to pi's OpenAI Responses helper with a temporary
 * `openai-responses` API tag so pi 0.79.8+ accepts the helper call, while xAI
 * routing headers, request URLs, and payload rewriting continue to use the
 * original xAI model metadata. Returned events are forwarded through an
 * assistant stream exposing async iteration and `result()`. Delegate load or
 * stream failures are converted into terminal error events with xAI provider
 * metadata instead of escaping as unstructured promise failures.
 *
 * @param model xAI provider model selected by pi.
 * @param context Conversation messages and tool context to stream.
 * @param options Simple stream options, including OAuth token, session ID, cancellation, and payload hooks.
 * @returns A forwarding assistant stream compatible with pi's async iterator and `result()` contract.
 */
export function streamSimpleXaiResponses(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
  // Prefer pi's stable session id for cache routing. For Grok CLI proxy only,
  // fall back to a per-stream id so x-grok-conv-id is always present.
  // Docs: Responses API uses body.prompt_cache_key; Chat Completions / CLI
  // proxy also benefit from the x-grok-conv-id header.
  // https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits
  const sessionId = options?.sessionId;
  const routingSessionId = sessionId || (isGrokCliProxyModel(model.id) ? randomUUID() : undefined);
  const streamModel = {
    ...model,
    baseUrl: xaiBaseUrlForModel(model.id),
    headers: {
      ...(model as any).headers,
      ...xaiModelRequestHeaders(model.id, routingSessionId),
    },
  };
  // pi 0.79.8+ API-guards the OpenAI Responses helper; keep the xAI
  // stream model for routing/payload rewriting, but delegate with the API
  // tag expected by the helper.
  const openAIResponsesModel = {
    ...streamModel,
    api: "openai-responses" as const,
  };
  const headers = { ...(options?.headers || {}) };
  if (routingSessionId && !headers["x-grok-conv-id"]) headers["x-grok-conv-id"] = routingSessionId;

  const stream = createForwardingAssistantStream();
  void (async () => {
    try {
      const { streamSimpleOpenAIResponses } = await import("@earendil-works/pi-ai");
      const inner = streamSimpleOpenAIResponses(openAIResponsesModel as Model<"openai-responses">, context, {
        ...options,
        // Ensure rewriteXaiResponsesPayload can always stamp prompt_cache_key.
        sessionId: sessionId || routingSessionId,
        headers,
        async onPayload(payload) {
          const rewritten = rewriteXaiResponsesPayload(payload, streamModel, {
            ...options,
            sessionId: sessionId || routingSessionId,
          });
          const userRewritten = await options?.onPayload?.(rewritten, streamModel);
          return userRewritten === undefined ? rewritten : userRewritten;
        },
      });
      for await (const event of inner as AsyncIterable<AssistantStreamEvent>) {
        stream.push(event);
      }
      stream.end();
    } catch (error) {
      const message = streamErrorMessage(model, error);
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
    }
  })();
  return stream;
}
