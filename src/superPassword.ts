import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { type FormattedResponse, ResponseFormatter } from "./utils/responseFormatter.js";

export type SuperPasswordDenial =
  | "api-key-write-locked"
  | "super-session-required"
  | "browser-session-required";

// The panel's fixed denial texts. Matching them exactly keeps the rule that
// remote error bodies never reach the model: only these known strings are
// recognised, and the reply below is written here, not copied from the server.
const SERVER_DENIAL_MESSAGES = new Map<string, SuperPasswordDenial>([
  ["API key write access is locked. Open it in Profile → Super password.", "api-key-write-locked"],
  [
    "This action needs the super password. Open access in Profile → Super password.",
    "super-session-required",
  ],
  [
    "This action needs a browser session with super password access open. API keys cannot perform it.",
    "browser-session-required",
  ],
]);

const DENIAL_DETAILS: Record<SuperPasswordDenial, string> = {
  "api-key-write-locked":
    "Super password access is closed, so writes through the API key are locked. Reads still work. Ask the owner to open access in Dokploy Profile → Super password (it lasts 24 hours), then retry. Call superPassword-status to check the state.",
  "super-session-required":
    "This action needs open super password access. Ask the owner to open access in Dokploy Profile → Super password, then retry. Call superPassword-status to check the state.",
  "browser-session-required":
    "This action is only allowed in the Dokploy panel in a browser with super password access open. API keys, including this MCP server, can never perform it, even while access is open. Ask the owner to do it in the panel.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function getSuperPasswordDenial(error: unknown): SuperPasswordDenial | null {
  if (!isRecord(error) || !isRecord(error.response) || error.response.status !== 403) {
    return null;
  }
  const body = error.response.data;
  if (!isRecord(body) || typeof body.message !== "string") {
    return null;
  }
  return SERVER_DENIAL_MESSAGES.get(body.message) ?? null;
}

export function superPasswordDenialResponse(
  toolName: string,
  denial: SuperPasswordDenial,
): FormattedResponse {
  return ResponseFormatter.error(
    `${toolName} was blocked by the Dokploy super password`,
    DENIAL_DETAILS[denial],
  );
}

export const superPasswordStatusTool: ToolDefinition = {
  name: "superPassword-status",
  description:
    "Check whether the Dokploy super password access is open. While it is closed, writes through the API key fail with 403 until the owner opens access in Profile → Super password (24 hours per opening). Dangerous actions (revealing env, deletions, terminals, users and keys) are never available through the API.",
  tag: "superPassword",
  method: "GET",
  path: "/superPassword.status",
  schema: z.object({}),
  annotations: {
    title: "Super Password Status",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  execution: { kind: "super-password-status", maxAttempts: 3 },
};

function formatTimeLeft(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  return `${hours} h ${totalMinutes % 60} min`;
}

// Only whitelisted fields go back to the model: the server also returns the
// password hint and the recovery channels, which the model has no use for.
export function summarizeSuperPasswordStatus(
  data: unknown,
  now: number = Date.now(),
): Record<string, unknown> {
  const status = isRecord(data) ? data : {};
  const isSet = status.isSet === true;
  const active = status.active === true;
  const expiresAt = typeof status.expiresAt === "string" ? status.expiresAt : null;
  const lockedUntil = typeof status.lockedUntil === "string" ? status.lockedUntil : null;
  const expiresAtMs = expiresAt === null ? Number.NaN : Date.parse(expiresAt);

  let apiKeyWrites: string;
  if (!isSet) {
    apiKeyWrites = "allowed: no super password is set";
  } else if (active) {
    apiKeyWrites = "allowed while access is open";
  } else {
    apiKeyWrites =
      "locked: ask the owner to open access in Dokploy Profile → Super password, then retry";
  }

  return {
    isSet,
    active,
    expiresAt,
    timeLeft: active && Number.isFinite(expiresAtMs) ? formatTimeLeft(expiresAtMs - now) : null,
    lockedUntil,
    apiKeyWrites,
    dangerousActions: "never through the API: only in the panel in a browser with access open",
  };
}
