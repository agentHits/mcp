import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock apiClient before server.ts is imported — it calls getClientConfig() at
// module level which requires DOKPLOY_URL/DOKPLOY_API_KEY env vars.
vi.mock("./utils/apiClient.js", () => ({
  default: { get: vi.fn(), post: vi.fn() },
  setAuthToken: vi.fn(),
  clearAuthToken: vi.fn(),
}));

const { default: apiClient } = await import("./utils/apiClient.js");
const { generatedTools } = await import("./generated/tools.js");
const { createServer } = await import("./server.js");

const RECOVERY_PATHS = [
  "/compose/env/upsert",
  "/compose/deploy/exact",
  "/deployment/reconcile",
] as const;
const VERIFIED_RECOVERY_SUBTREE_SHA256 =
  "924bb49db03e133053276e890d8570af89b63940015044a374c612d8dd4e209d";

function responseText(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((item) => (item.type === "text" ? (item.text ?? "") : "")).join("\n");
}

describe("MCP server tools/list", () => {
  const originalDokployUrl = process.env.DOKPLOY_URL;
  const originalDokployApiKey = process.env.DOKPLOY_API_KEY;
  const originalDokployRedactEnv = process.env.DOKPLOY_REDACT_ENV;
  const originalDokployRedactFields = process.env.DOKPLOY_REDACT_FIELDS;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DOKPLOY_URL = "https://dokploy.example";
    process.env.DOKPLOY_API_KEY = "test-api-key";
    process.env.DOKPLOY_REDACT_ENV = "false";
    delete process.env.DOKPLOY_REDACT_FIELDS;
  });

  afterEach(() => {
    if (originalDokployUrl === undefined) {
      delete process.env.DOKPLOY_URL;
    } else {
      process.env.DOKPLOY_URL = originalDokployUrl;
    }

    if (originalDokployApiKey === undefined) {
      delete process.env.DOKPLOY_API_KEY;
    } else {
      process.env.DOKPLOY_API_KEY = originalDokployApiKey;
    }

    if (originalDokployRedactEnv === undefined) {
      delete process.env.DOKPLOY_REDACT_ENV;
    } else {
      process.env.DOKPLOY_REDACT_ENV = originalDokployRedactEnv;
    }

    if (originalDokployRedactFields === undefined) {
      delete process.env.DOKPLOY_REDACT_FIELDS;
    } else {
      process.env.DOKPLOY_REDACT_FIELDS = originalDokployRedactFields;
    }
  });

  async function createConnectedClient() {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  async function getToolList() {
    const client = await createConnectedClient();
    const { tools } = await client.listTools();
    await client.close();
    return tools;
  }

  it("returns tools", async () => {
    const tools = await getToolList();
    expect(tools.length).toBeGreaterThan(0);
  });

  it("exposes deployment-readLogs for schedule deployment log inspection", async () => {
    const tools = await getToolList();
    const tool = tools.find(({ name }) => name === "deployment-readLogs");

    expect(tool).toBeDefined();
    expect(tool?.description).toBe("GET /deployment.readLogs");

    const schema = tool?.inputSchema as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const required = schema.required as string[];

    expect(properties.deploymentId).toMatchObject({
      type: "string",
      minLength: 1,
    });
    expect(properties.tail).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 10000,
      default: 100,
    });
    expect(required).toContain("deploymentId");
  });

  it("routes deployment-readLogs calls to the deployment log API endpoint", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: "schedule stdout\nschedule stderr",
    });

    const client = await createConnectedClient();
    const result = await client.callTool({
      name: "deployment-readLogs",
      arguments: {
        deploymentId: "dep_test",
        tail: 25,
      },
    });
    await client.close();

    expect(apiClient.get).toHaveBeenCalledWith("/deployment.readLogs", {
      params: {
        deploymentId: "dep_test",
        tail: 25,
      },
    });

    const content = result.content[0];
    expect(content.type).toBe("text");
    const parsed = JSON.parse(content.type === "text" ? content.text : "");

    expect(parsed).toEqual({
      success: true,
      message: "deployment-readLogs completed successfully",
      data: "schedule stdout\nschedule stderr",
    });
  });

  it("every tool inputSchema has $schema set to draft 2020-12", async () => {
    const tools = await getToolList();
    for (const tool of tools) {
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.$schema, `Tool "${tool.name}" is missing $schema or has wrong draft`).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
    }
  });

  it("no tool inputSchema contains any $schema key at nested levels", async () => {
    const tools = await getToolList();

    function findNestedSchemaKeys(obj: unknown, path = ""): string[] {
      if (obj === null || typeof obj !== "object") return [];
      if (Array.isArray(obj)) {
        return obj.flatMap((item, i) => findNestedSchemaKeys(item, `${path}[${i}]`));
      }
      const record = obj as Record<string, unknown>;
      const found: string[] = [];
      for (const [key, value] of Object.entries(record)) {
        const currentPath = path ? `${path}.${key}` : key;
        if (key === "$schema" && path !== "") found.push(currentPath);
        found.push(...findNestedSchemaKeys(value, currentPath));
      }
      return found;
    }

    for (const tool of tools) {
      const found = findNestedSchemaKeys(tool.inputSchema);
      expect(
        found,
        `Tool "${tool.name}" has nested $schema keys at: ${found.join(", ")}`,
      ).toHaveLength(0);
    }
  });

  it("all tools have name, inputSchema with type=object", async () => {
    const tools = await getToolList();
    for (const tool of tools) {
      expect(tool.name, "tool is missing name").toBeTruthy();
      expect(tool.inputSchema, `tool "${tool.name}" is missing inputSchema`).toBeDefined();
      expect(
        (tool.inputSchema as Record<string, unknown>).type,
        `tool "${tool.name}" inputSchema is missing type`,
      ).toBe("object");
    }
  });

  it("exposes application env upsert with partial-update inputs", async () => {
    const tools = await getToolList();
    const tool = tools.find((candidate) => candidate.name === "application-env-upsert");

    expect(tool).toBeDefined();
    expect(tool?.description).toBe("POST /application.env.upsert");

    const schema = tool?.inputSchema as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;

    expect(schema.required).toEqual(["applicationId", "variables"]);
    expect(properties.applicationId.type).toBe("string");
    expect(properties.variables.type).toBe("object");
    expect(properties.variables.additionalProperties).toMatchObject({
      type: "string",
    });
    expect(properties.variables.propertyNames).toMatchObject({
      pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
    });
    expect(properties.redeploy.type).toBe("boolean");
    expect(properties.dryRun.type).toBe("boolean");
    expect(properties.expectedRevision.type).toBe("string");

    const generatedTool = generatedTools.find(
      (candidate) => candidate.name === "application-env-upsert",
    );
    expect(generatedTool).toBeDefined();
    expect(
      generatedTool?.schema.safeParse({
        applicationId: "app_1",
        variables: {
          REDIS_PASSWORD: "placeholder-secret-value",
        },
      }).success,
    ).toBe(true);
    expect(
      generatedTool?.schema.safeParse({
        applicationId: "app_1",
        variables: {},
      }).success,
    ).toBe(false);
    expect(
      generatedTool?.schema.safeParse({
        applicationId: "app_1",
        variables: {
          "1_BAD": "placeholder-secret-value",
        },
      }).success,
    ).toBe(false);
  });

  it("routes application env upsert without full environment replacement or raw value output", async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: {
        applicationId: "app_1",
        changed: true,
        revision: "env:next",
        dryRun: true,
        redeployed: false,
        variables: [
          {
            name: "REDIS_PASSWORD",
            action: "updated",
            secret: true,
          },
        ],
      },
    });

    const client = await createConnectedClient();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await client.callTool({
        name: "application-env-upsert",
        arguments: {
          applicationId: "app_1",
          variables: {
            REDIS_PASSWORD: "placeholder-secret-value",
          },
          dryRun: true,
          redeploy: false,
          expectedRevision: "env:current",
        },
      });

      expect(apiClient.get).not.toHaveBeenCalled();
      expect(apiClient.post).toHaveBeenCalledTimes(1);
      expect(apiClient.post).toHaveBeenCalledWith("/application/env/upsert", {
        applicationId: "app_1",
        variables: {
          REDIS_PASSWORD: "placeholder-secret-value",
        },
        dryRun: true,
        redeploy: false,
        expectedRevision: "env:current",
      });
      expect(apiClient.post).not.toHaveBeenCalledWith(
        "/application.saveEnvironment",
        expect.anything(),
      );

      const [, postBody] = vi.mocked(apiClient.post).mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(postBody).not.toHaveProperty("env");
      expect(postBody).not.toHaveProperty("buildArgs");
      expect(postBody).not.toHaveProperty("buildSecrets");
      expect(postBody).not.toHaveProperty("createEnvFile");

      const responseText = result.content
        .map((item) => (item.type === "text" ? item.text : ""))
        .join("\n");
      const logText = consoleError.mock.calls.map((call) => String(call[0])).join("\n");

      expect(responseText).toContain('"applicationId": "app_1"');
      expect(responseText).toContain('"secret": true');
      expect(responseText).not.toContain("placeholder-secret-value");
      expect(logText).toContain('"REDIS_PASSWORD":"[REDACTED]"');
      expect(logText).not.toContain("placeholder-secret-value");
    } finally {
      consoleError.mockRestore();
      await client.close();
    }
  });

  it("matches the verified recovery OpenAPI path subtrees", () => {
    const spec = JSON.parse(
      readFileSync(new URL("./generated/openapi.json", import.meta.url), "utf8"),
    ) as { paths: Record<string, unknown> };
    const recoverySubtrees = Object.fromEntries(
      RECOVERY_PATHS.map((path) => [path, spec.paths[path]]),
    );
    const digest = createHash("sha256").update(JSON.stringify(recoverySubtrees)).digest("hex");

    expect(digest).toBe(VERIFIED_RECOVERY_SUBTREE_SHA256);
    expect(RECOVERY_PATHS.every((path) => spec.paths[path] !== undefined)).toBe(true);
  });

  it("keeps two fresh remote and local profile server contracts byte-equivalent", async () => {
    const first = await getToolList();
    const second = await getToolList();

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("exposes exact recovery names, schemas, and conservative annotations", async () => {
    const tools = await getToolList();
    const envTool = tools.find(({ name }) => name === "compose_env_upsert");
    const exactTool = tools.find(({ name }) => name === "compose_deploy_exact");
    const reconcileTool = tools.find(({ name }) => name === "deployment_reconcile");

    expect(envTool?.annotations).toMatchObject({
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(envTool?.annotations).not.toHaveProperty("idempotentHint");
    expect(envTool?.annotations).not.toHaveProperty("readOnlyHint");
    expect(exactTool?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(reconcileTool?.annotations).toMatchObject({
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(reconcileTool?.annotations).not.toHaveProperty("idempotentHint");
    expect(tools.filter(({ name }) => name === "compose_env_upsert")).toHaveLength(1);
    expect(tools.filter(({ name }) => name === "compose_deploy_exact")).toHaveLength(1);
    expect(tools.filter(({ name }) => name === "deployment_reconcile")).toHaveLength(1);
    expect(tools.some(({ name }) => name === "compose-env-upsert")).toBe(false);
    expect(tools.some(({ name }) => name === "compose-deployExact")).toBe(false);
    expect(tools.some(({ name }) => name === "deployment-reconcile")).toBe(false);
  });

  it("enforces exact SHA and idempotency key bounds", () => {
    const exactTool = generatedTools.find(({ name }) => name === "compose_deploy_exact");
    const validInput = {
      composeId: "compose_1",
      expectedRevision: "a".repeat(40),
      idempotencyKey: "stable-1",
    };

    expect(exactTool?.schema.safeParse(validInput).success).toBe(true);
    for (const expectedRevision of [
      "A".repeat(40),
      "main",
      "g".repeat(40),
      "a".repeat(39),
      "a".repeat(41),
    ]) {
      expect(exactTool?.schema.safeParse({ ...validInput, expectedRevision }).success).toBe(false);
    }
    expect(
      exactTool?.schema.safeParse({ ...validInput, idempotencyKey: "x".repeat(7) }).success,
    ).toBe(false);
    expect(
      exactTool?.schema.safeParse({ ...validInput, idempotencyKey: "x".repeat(201) }).success,
    ).toBe(false);
  });

  it("rejects empty or invalid compose env variable maps", () => {
    const envTool = generatedTools.find(({ name }) => name === "compose_env_upsert");
    expect(
      envTool?.schema.safeParse({ composeId: "compose_1", variables: {}, dryRun: true }).success,
    ).toBe(false);
    expect(
      envTool?.schema.safeParse({
        composeId: "compose_1",
        variables: { "1_INVALID": "value" },
        dryRun: true,
      }).success,
    ).toBe(false);
    expect(
      envTool?.schema.safeParse({
        composeId: "compose_1",
        variables: { VALID_NAME: 123 },
        dryRun: true,
      }).success,
    ).toBe(false);
  });

  it("performs compose env conditional preview then one exact-revision write", async () => {
    vi.mocked(apiClient.post)
      .mockResolvedValueOnce({
        data: {
          composeId: "compose_1",
          changed: true,
          revision: "env:current",
          dryRun: true,
          variables: [{ name: "TOKEN", action: "updated", secret: true }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          composeId: "compose_1",
          changed: true,
          revision: "env:next",
          dryRun: false,
          variables: [{ name: "TOKEN", action: "updated", secret: true }],
        },
      });

    const client = await createConnectedClient();
    const result = await client.callTool({
      name: "compose_env_upsert",
      arguments: {
        composeId: "compose_1",
        variables: { TOKEN: "submitted-value" },
        dryRun: false,
        expectedRevision: "env:current",
      },
    });
    await client.close();

    expect(apiClient.post).toHaveBeenCalledTimes(2);
    expect(apiClient.post).toHaveBeenNthCalledWith(1, "/compose/env/upsert", {
      composeId: "compose_1",
      variables: { TOKEN: "submitted-value" },
      dryRun: true,
      expectedRevision: "env:current",
    });
    expect(apiClient.post).toHaveBeenNthCalledWith(2, "/compose/env/upsert", {
      composeId: "compose_1",
      variables: { TOKEN: "submitted-value" },
      dryRun: false,
      expectedRevision: "env:current",
    });
    expect(apiClient.get).not.toHaveBeenCalled();
    const serializedResult = responseText(result);
    expect(serializedResult).toContain('"name": "TOKEN"');
    expect(serializedResult).toContain('"action": "updated"');
    expect(serializedResult).toContain('"secret": true');
    expect(serializedResult).not.toContain("submitted-value");
  });

  it("runs compose env dry-run as one preview request", async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: {
        composeId: "compose_1",
        changed: false,
        revision: "env:current",
        dryRun: true,
        variables: [{ name: "TOKEN", action: "unchanged", secret: true }],
      },
    });
    const client = await createConnectedClient();
    await client.callTool({
      name: "compose_env_upsert",
      arguments: {
        composeId: "compose_1",
        variables: { TOKEN: "submitted-value" },
        dryRun: true,
      },
    });
    await client.close();

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith("/compose/env/upsert", {
      composeId: "compose_1",
      variables: { TOKEN: "submitted-value" },
      dryRun: true,
    });
  });

  it("rejects compose env writes without a revision before any request or log", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await createConnectedClient();
    try {
      const result = await client.callTool({
        name: "compose_env_upsert",
        arguments: {
          composeId: "compose_1",
          variables: { TOKEN: "submitted-value" },
          dryRun: false,
        },
      });

      expect(apiClient.post).not.toHaveBeenCalled();
      expect(apiClient.get).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
      expect(responseText(result)).toContain("Invalid input");
    } finally {
      consoleError.mockRestore();
      await client.close();
    }
  });

  it("rejects both secret placeholders at start, middle, and end before request or log", async () => {
    const values = FORBIDDEN_PLACEHOLDER_FIXTURES();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await createConnectedClient();
    try {
      for (const value of values) {
        const result = await client.callTool({
          name: "compose_env_upsert",
          arguments: {
            composeId: "compose_1",
            variables: { TOKEN: value },
            dryRun: true,
          },
        });
        expect(responseText(result)).not.toContain(value);
      }

      expect(apiClient.post).not.toHaveBeenCalled();
      expect(apiClient.get).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      await client.close();
    }
  });

  it("stops stale, mismatched, and invalid env previews without fallback or write", async () => {
    const client = await createConnectedClient();
    const cases: unknown[] = [
      {
        isAxiosError: true,
        response: { status: 409, data: { message: "remote-sensitive-conflict" } },
      },
      {
        data: {
          composeId: "compose_1",
          changed: true,
          revision: "env:other",
          dryRun: true,
          variables: [{ name: "TOKEN", action: "updated", secret: true }],
        },
      },
      { data: { composeId: "compose_1", revision: "env:current" } },
    ];

    for (const fixture of cases) {
      vi.clearAllMocks();
      if (isRejectedFixture(fixture)) {
        vi.mocked(apiClient.post).mockRejectedValueOnce(fixture);
      } else {
        vi.mocked(apiClient.post).mockResolvedValueOnce(fixture);
      }
      const result = await client.callTool({
        name: "compose_env_upsert",
        arguments: {
          composeId: "compose_1",
          variables: { TOKEN: "submitted-value" },
          dryRun: false,
          expectedRevision: "env:current",
        },
      });

      expect(apiClient.post).toHaveBeenCalledTimes(1);
      expect(apiClient.get).not.toHaveBeenCalled();
      expect(apiClient.post).not.toHaveBeenCalledWith(
        "/compose.saveEnvironment",
        expect.anything(),
      );
      expect(responseText(result)).not.toContain("remote-sensitive-conflict");
    }
    await client.close();
  });

  it("retries exact deploy at most three times with one byte-identical body and key", async () => {
    const noResponse = { isAxiosError: true, request: {}, code: "ETIMEDOUT" };
    const unavailable = { isAxiosError: true, response: { status: 503 } };
    vi.mocked(apiClient.post)
      .mockRejectedValueOnce(noResponse)
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce({
        data: {
          composeId: "compose_1",
          operationId: "operation_1",
          sourceRevision: "a".repeat(40),
          resolvedRevision: "a".repeat(40),
          status: "accepted",
          deduplicated: false,
          idempotencyKey: "stable-key",
        },
      });

    const client = await createConnectedClient();
    const result = await client.callTool({
      name: "compose_deploy_exact",
      arguments: {
        composeId: "compose_1",
        expectedRevision: "a".repeat(40),
        idempotencyKey: "stable-key",
      },
    });
    await client.close();

    expect(apiClient.post).toHaveBeenCalledTimes(3);
    const bodies = vi.mocked(apiClient.post).mock.calls.map((call) => call[1]);
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);
    expect(JSON.stringify(bodies[1])).toBe(JSON.stringify(bodies[0]));
    expect(JSON.stringify(bodies[2])).toBe(JSON.stringify(bodies[0]));
    expect(responseText(result)).not.toContain("stable-key");
  });

  it("does not retry exact deploy on 409 or an invalid response", async () => {
    const client = await createConnectedClient();
    for (const fixture of [
      { rejected: { isAxiosError: true, response: { status: 409 } } },
      { rejected: { isAxiosError: true } },
      { resolved: { data: { composeId: "compose_1", operationId: "operation_1" } } },
    ]) {
      vi.clearAllMocks();
      if (fixture.rejected) {
        vi.mocked(apiClient.post).mockRejectedValueOnce(fixture.rejected);
      } else if (fixture.resolved) {
        vi.mocked(apiClient.post).mockResolvedValueOnce(fixture.resolved);
      }
      await client.callTool({
        name: "compose_deploy_exact",
        arguments: {
          composeId: "compose_1",
          expectedRevision: "a".repeat(40),
          idempotencyKey: "stable-key",
        },
      });
      expect(apiClient.post).toHaveBeenCalledTimes(1);
    }
    await client.close();
  });

  it("blocks reconcile repair for unavailable, queued, active, final, running, linked, and invalid state", async () => {
    const base = reconcileFixture();
    const fixtures = [
      { ...base, queue: { state: "queue-unavailable", reasonCode: "network-error" } },
      { ...base, queue: { state: "queued" } },
      { ...base, queue: { state: "active" } },
      { ...base, operationStatus: "succeeded" },
      { ...base, operationStatus: "running" },
      { ...base, composeId: "compose_other" },
      { ...base, operationId: "operation_other" },
      {
        ...base,
        deployment: {
          deploymentId: "deployment_1",
          status: "running",
          startedAt: null,
          finishedAt: null,
        },
      },
      { composeId: "compose_1", operationId: "operation_1" },
    ];
    const client = await createConnectedClient();

    for (const data of fixtures) {
      vi.clearAllMocks();
      vi.mocked(apiClient.post).mockResolvedValueOnce({ data });
      await client.callTool({
        name: "deployment_reconcile",
        arguments: { composeId: "compose_1", operationId: "operation_1", repair: true },
      });
      expect(apiClient.post).toHaveBeenCalledTimes(1);
      expect(apiClient.post).not.toHaveBeenCalledWith("/deployment/reconcile", {
        composeId: "compose_1",
        operationId: "operation_1",
        repair: true,
      });
    }
    await client.close();
  });

  it("repairs only eligible queue-empty reconcile state and never retries the repair call", async () => {
    const inspect = reconcileFixture();
    const client = await createConnectedClient();

    vi.mocked(apiClient.post)
      .mockResolvedValueOnce({ data: inspect })
      .mockResolvedValueOnce({ data: { ...inspect, repairPerformed: true } });
    await client.callTool({
      name: "deployment_reconcile",
      arguments: { composeId: "compose_1", operationId: "operation_1", repair: true },
    });
    expect(apiClient.post).toHaveBeenCalledTimes(2);
    expect(apiClient.post).toHaveBeenNthCalledWith(1, "/deployment/reconcile", {
      composeId: "compose_1",
      operationId: "operation_1",
      repair: false,
    });
    expect(apiClient.post).toHaveBeenNthCalledWith(2, "/deployment/reconcile", {
      composeId: "compose_1",
      operationId: "operation_1",
      repair: true,
    });

    vi.clearAllMocks();
    vi.mocked(apiClient.post)
      .mockResolvedValueOnce({ data: inspect })
      .mockRejectedValueOnce({ isAxiosError: true, response: { status: 503 } });
    await client.callTool({
      name: "deployment_reconcile",
      arguments: { composeId: "compose_1", operationId: "operation_1", repair: true },
    });
    expect(apiClient.post).toHaveBeenCalledTimes(2);
    await client.close();
  });

  it("projects recovery output through allowlists and removes secret or diagnostic extras", async () => {
    const response = {
      ...reconcileFixture(),
      env: "forbidden-env",
      value: "forbidden-value",
      idempotencyKey: "forbidden-key",
      logPath: "forbidden-log-path",
      errorMessage: "forbidden-exception",
      queue: { state: "queue-unavailable", reasonCode: "remote-error", data: "forbidden-queue" },
    };
    vi.mocked(apiClient.post).mockResolvedValueOnce({ data: response });
    const client = await createConnectedClient();
    const result = await client.callTool({
      name: "deployment_reconcile",
      arguments: { composeId: "compose_1", operationId: "operation_1", repair: false },
    });
    await client.close();

    const serialized = responseText(result);
    for (const forbidden of [
      "forbidden-env",
      "forbidden-value",
      "forbidden-key",
      "forbidden-log-path",
      "forbidden-exception",
      "forbidden-queue",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("keeps legacy POST tools non-idempotent, non-retried, and full-save visibly high risk", async () => {
    for (const tool of generatedTools.filter(({ method }) => method === "POST")) {
      if (tool.name !== "compose_deploy_exact") {
        expect(tool.annotations?.idempotentHint, tool.name).not.toBe(true);
      }
    }
    const fullSave = generatedTools.find(({ name }) => name === "compose-saveEnvironment");
    expect(fullSave?.description).toContain("HIGH RISK: full environment replacement");
    expect(fullSave?.annotations?.destructiveHint).toBe(true);
    expect(fullSave?.execution).toBeUndefined();

    vi.mocked(apiClient.post).mockRejectedValue({
      isAxiosError: true,
      response: { status: 503 },
    });
    const client = await createConnectedClient();
    await client.callTool({
      name: "application-redeploy",
      arguments: { applicationId: "application_1" },
    });
    await client.close();
    expect(apiClient.post).toHaveBeenCalledTimes(1);
  });
});

function FORBIDDEN_PLACEHOLDER_FIXTURES() {
  return ["__DOKPLOY_REDACTED_SECRET__", "[REDACTED]"].flatMap((placeholder) => [
    `${placeholder}suffix`,
    `prefix${placeholder}suffix`,
    `prefix${placeholder}`,
  ]);
}

function isRejectedFixture(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    "isAxiosError" in value &&
    (value as { isAxiosError?: unknown }).isAxiosError === true
  );
}

function reconcileFixture() {
  return {
    composeId: "compose_1",
    operationId: "operation_1",
    sourceRevision: "a".repeat(40),
    resolvedRevision: null,
    operationStatus: "dispatch_unknown",
    deployment: null,
    queue: { state: "queue-empty" },
    repairPerformed: false,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:01.000Z",
    checkedAt: "2026-07-20T00:00:02.000Z",
  };
}
