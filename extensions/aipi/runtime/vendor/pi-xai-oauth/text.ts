/** Extract display text from an xAI/OpenAI Responses API response. */
export function extractResponsesText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text) return data.output_text;
  const chunks: string[] = [];
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === "string" && (part.type === "output_text" || part.text)) chunks.push(part.text);
    }
  }
  return chunks.join("") || JSON.stringify(data);
}

/** Extract text from Responses content parts. */
export function textFromResponsesContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const item = part as { type?: unknown; text?: unknown };
      const type = typeof item.type === "string" ? item.type : "";
      return ["text", "input_text", "output_text"].includes(type) && typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Extract an HTTP-like status from thrown xAI request errors. */
export function statusFromError(error: unknown): number | undefined {
  return typeof (error as any)?.status === "number" ? (error as any).status : undefined;
}

/** Return a safe display message for thrown values. */
export function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
