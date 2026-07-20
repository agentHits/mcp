import type { ToolDefinition } from "./types.js";
import apiClient from "./utils/apiClient.js";
import { getClientConfig } from "./utils/clientConfig.js";
import { createLogger } from "./utils/logger.js";
import { redactSensitive } from "./utils/redactSensitive.js";
import { type FormattedResponse, ResponseFormatter } from "./utils/responseFormatter.js";

const logger = createLogger("ToolHandler");
const FORBIDDEN_SECRET_PLACEHOLDERS = ["__DOKPLOY_REDACTED_SECRET__", "[REDACTED]"];
const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);
const FINAL_OPERATION_STATUSES = new Set(["running", "succeeded", "failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getRedactFieldsForTool(tool: ToolDefinition, input: Record<string, unknown>) {
  if (tool.execution?.kind === "compose-env-upsert") {
    return ["variables"];
  }
  if (tool.execution?.kind === "compose-deploy-exact") {
    return ["idempotencyKey"];
  }
  if (tool.name === "application-env-upsert" && isRecord(input.variables)) {
    return Object.keys(input.variables);
  }
  return [];
}

function invalidInput(tool: ToolDefinition): FormattedResponse {
  return ResponseFormatter.error(
    `Invalid input for ${tool.name}`,
    "The request did not satisfy the safe recovery contract",
  );
}

function containsForbiddenPlaceholder(input: Record<string, unknown>): boolean {
  if (!isRecord(input.variables)) {
    return false;
  }

  return Object.values(input.variables).some(
    (value) =>
      typeof value === "string" &&
      FORBIDDEN_SECRET_PLACEHOLDERS.some((placeholder) => value.includes(placeholder)),
  );
}

function getHttpStatus(error: unknown): number | undefined {
  if (!isRecord(error) || !isRecord(error.response)) {
    return undefined;
  }
  return typeof error.response.status === "number" ? error.response.status : undefined;
}

function isRetryableTransportError(error: unknown): boolean {
  const status = getHttpStatus(error);
  if (status !== undefined) {
    return RETRYABLE_STATUS_CODES.has(status);
  }
  if (!isRecord(error) || isRecord(error.response)) {
    return false;
  }

  const code = typeof error.code === "string" ? error.code : undefined;
  return "request" in error || code === "ECONNABORTED" || code === "ETIMEDOUT";
}

async function postWithBoundedRetry(
  path: string,
  body: Record<string, unknown>,
  maxAttempts: number,
) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await apiClient.post(path, body);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableTransportError(error)) {
        throw error;
      }
    }
  }
  throw new Error("unreachable retry state");
}

function parseRecoveryResponse(tool: ToolDefinition, value: unknown): Record<string, unknown> {
  const parsed = tool.outputSchema?.safeParse(value);
  if (!parsed?.success || !isRecord(parsed.data)) {
    throw new Error("invalid recovery response");
  }
  return parsed.data;
}

async function executeComposeEnvUpsert(
  tool: ToolDefinition,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const composeId = input.composeId as string;
  const variables = input.variables as Record<string, string>;
  const dryRun = input.dryRun === true;
  const expectedRevision =
    typeof input.expectedRevision === "string" ? input.expectedRevision : undefined;

  if (dryRun) {
    const previewBody: Record<string, unknown> = {
      composeId,
      variables,
      dryRun: true,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    };
    const response = await postWithBoundedRetry(
      tool.path,
      previewBody,
      tool.execution?.maxAttempts ?? 1,
    );
    return parseRecoveryResponse(tool, response.data);
  }

  const previewBody = {
    composeId,
    variables,
    dryRun: true,
    expectedRevision,
  };
  const previewResponse = await postWithBoundedRetry(
    tool.path,
    previewBody,
    tool.execution?.maxAttempts ?? 1,
  );
  const preview = parseRecoveryResponse(tool, previewResponse.data);

  if (
    preview.composeId !== composeId ||
    preview.dryRun !== true ||
    preview.revision !== expectedRevision
  ) {
    throw new Error("invalid conditional preview");
  }

  const writeBody = {
    composeId,
    variables,
    dryRun: false,
    expectedRevision: preview.revision,
  };
  const writeResponse = await apiClient.post(tool.path, writeBody);
  const result = parseRecoveryResponse(tool, writeResponse.data);
  if (result.composeId !== composeId) {
    throw new Error("invalid compose env response identity");
  }
  return result;
}

async function executeExactDeploy(
  tool: ToolDefinition,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const body = {
    composeId: input.composeId,
    expectedRevision: input.expectedRevision,
    idempotencyKey: input.idempotencyKey,
  };
  const response = await postWithBoundedRetry(tool.path, body, tool.execution?.maxAttempts ?? 1);
  const result = parseRecoveryResponse(tool, response.data);
  if (result.composeId !== input.composeId || result.sourceRevision !== input.expectedRevision) {
    throw new Error("invalid exact deploy response identity");
  }
  return result;
}

function canRepairReconcile(inspect: Record<string, unknown>): boolean {
  const queue = inspect.queue;
  return (
    isRecord(queue) &&
    queue.state === "queue-empty" &&
    typeof inspect.operationStatus === "string" &&
    !FINAL_OPERATION_STATUSES.has(inspect.operationStatus) &&
    inspect.deployment === null &&
    inspect.repairPerformed === false
  );
}

async function executeDeploymentReconcile(
  tool: ToolDefinition,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const inspectBody = {
    composeId: input.composeId,
    operationId: input.operationId,
    repair: false,
  };
  const inspectResponse = await postWithBoundedRetry(
    tool.path,
    inspectBody,
    tool.execution?.maxAttempts ?? 1,
  );
  const inspect = parseRecoveryResponse(tool, inspectResponse.data);

  if (inspect.composeId !== input.composeId || inspect.operationId !== input.operationId) {
    throw new Error("invalid reconcile response identity");
  }

  if (input.repair !== true || !canRepairReconcile(inspect)) {
    return inspect;
  }

  const repairBody = {
    composeId: input.composeId,
    operationId: input.operationId,
    repair: true,
  };
  const repairResponse = await apiClient.post(tool.path, repairBody);
  const repaired = parseRecoveryResponse(tool, repairResponse.data);
  if (repaired.composeId !== input.composeId || repaired.operationId !== input.operationId) {
    throw new Error("invalid reconcile repair response identity");
  }
  return repaired;
}

async function executeTool(tool: ToolDefinition, input: Record<string, unknown>) {
  switch (tool.execution?.kind) {
    case "compose-env-upsert":
      return executeComposeEnvUpsert(tool, input);
    case "compose-deploy-exact":
      return executeExactDeploy(tool, input);
    case "deployment-reconcile":
      return executeDeploymentReconcile(tool, input);
    default: {
      const response =
        tool.method === "GET"
          ? await apiClient.get(tool.path, { params: input })
          : await apiClient.post(tool.path, input);
      return response.data;
    }
  }
}

export function createHandler(tool: ToolDefinition) {
  return async (rawInput: Record<string, unknown>) => {
    let input = rawInput;
    if (tool.execution) {
      const parsedInput = tool.schema.safeParse(rawInput);
      if (!parsedInput.success || !isRecord(parsedInput.data)) {
        return invalidInput(tool);
      }
      input = parsedInput.data;

      if (tool.execution.kind === "compose-env-upsert") {
        if (containsForbiddenPlaceholder(input)) {
          return invalidInput(tool);
        }
        if (
          input.dryRun !== true &&
          (typeof input.expectedRevision !== "string" || input.expectedRevision.length === 0)
        ) {
          return invalidInput(tool);
        }
      }
    }

    const { redactEnv, redactFields } = getClientConfig();
    const toolRedactFields = getRedactFieldsForTool(tool, input);
    const effectiveRedactFields = redactEnv
      ? [...new Set([...redactFields, ...toolRedactFields])]
      : toolRedactFields;
    const redact = <T>(value: T): T =>
      effectiveRedactFields.length > 0 ? redactSensitive(value, effectiveRedactFields) : value;

    try {
      logger.info(`Executing tool: ${tool.name}`, { input: redact(input) });
      const data = await executeTool(tool, input);
      return ResponseFormatter.success(
        `${tool.name} completed successfully`,
        tool.execution ? data : redact(data),
      );
    } catch (error) {
      const status = getHttpStatus(error);
      logger.error(`Tool execution failed: ${tool.name}`, {
        ...(status === undefined ? {} : { status }),
      });

      if (status === 401) {
        return ResponseFormatter.error(
          `Authentication failed for ${tool.name}`,
          "Please check your DOKPLOY_API_KEY configuration",
        );
      }
      if (status === 404) {
        return ResponseFormatter.error(
          "Resource not found",
          `The requested resource for ${tool.name} could not be found`,
        );
      }
      if (status === 409) {
        return ResponseFormatter.error(
          `Conflict while executing ${tool.name}`,
          "The operation state changed; inspect or preview again before retrying",
        );
      }

      return ResponseFormatter.error(
        `Failed to execute ${tool.name}`,
        status === undefined
          ? "The Dokploy API request failed"
          : `The Dokploy API request failed with status ${status}`,
      );
    }
  };
}
