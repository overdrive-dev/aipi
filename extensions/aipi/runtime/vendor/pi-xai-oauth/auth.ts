import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  DEFAULT_XAI_MODEL,
  XAI_GROK_CLI_AUTH_SCOPE_KEY,
  XAI_GROK_CLI_LEGACY_AUTH_SCOPE_KEY,
  XAI_OAUTH_ISSUER,
  XAI_OAUTH_REFRESH_SKEW_MS,
  XAI_PROVIDER_ID,
} from "./constants";
import { ensureFreshXaiCredentials } from "./oauth";

function parseExpiry(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;

  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Load reusable OAuth credentials from the official Grok CLI auth file. */
export function getGrokAuthCredentials(): OAuthCredentials | null {
  const authPath = join(homedir(), ".grok", "auth.json");
  if (!existsSync(authPath)) return null;

  try {
    const data = JSON.parse(readFileSync(authPath, "utf8"));

    // Official Grok CLI stores OAuth2 credentials under
    // "https://auth.x.ai::<client_id>" as { key, refresh_token, expires_at }.
    const oidc = data?.[XAI_GROK_CLI_AUTH_SCOPE_KEY];
    if (oidc && typeof oidc === "object") {
      const access = String(oidc.key || oidc.access_token || oidc.token || "");
      if (access) {
        const expires = parseExpiry(oidc.expires_at) || Date.now() + 6 * 60 * 60 * 1000;
        return {
          refresh: String(oidc.refresh_token || oidc.refresh || ""),
          access,
          expires: expires - XAI_OAUTH_REFRESH_SKEW_MS,
          tokenEndpoint: `${XAI_OAUTH_ISSUER}/oauth2/token`,
          tokenType: "Bearer",
        };
      }
    }

    // Older Grok builds stored a bearer at the sign-in URL scope.
    const legacy = data?.[XAI_GROK_CLI_LEGACY_AUTH_SCOPE_KEY];
    const legacyAccess = legacy && typeof legacy === "object" ? legacy.key || legacy.access_token || legacy.token : "";
    if (legacyAccess) {
      return {
        refresh: "",
        access: String(legacyAccess),
        expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
      };
    }

    // Back-compat with early pi-xai-oauth guesses.
    const topLevelAccess = data?.access_token || data?.token;
    if (topLevelAccess) {
      return {
        refresh: String(data.refresh_token || data.refresh || ""),
        access: String(topLevelAccess),
        expires: parseExpiry(data.expires_at || data.expires) || Date.now() + 30 * 24 * 60 * 60 * 1000,
        tokenEndpoint: `${XAI_OAUTH_ISSUER}/oauth2/token`,
        tokenType: String(data.token_type || "Bearer"),
      };
    }
  } catch {
    return null;
  }

  return null;
}

/** Resolve an xAI OAuth access token from pi context or reusable Grok CLI credentials. */
export async function resolveXaiAuthToken(ctx: any): Promise<string | null> {
  const registryModel = ctx?.modelRegistry?.find?.(XAI_PROVIDER_ID, DEFAULT_XAI_MODEL);
  if (registryModel && typeof ctx?.modelRegistry?.getApiKeyAndHeaders === "function") {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(registryModel);
    if (auth?.ok && auth.apiKey) return auth.apiKey;
    const authorization = auth?.ok && typeof auth.headers?.Authorization === "string" ? auth.headers.Authorization : "";
    if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice("bearer ".length);
  }
  if (ctx?.apiKey) return ctx.apiKey;

  const credentials = getGrokAuthCredentials();
  if (!credentials?.access) return null;
  return (await ensureFreshXaiCredentials(credentials)).access;
}
