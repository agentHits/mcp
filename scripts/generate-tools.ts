import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type JsonSchema, jsonSchemaToZod } from "json-schema-to-zod";

interface OpenAPISpec {
  paths: Record<string, Record<string, OperationObject>>;
}

interface OperationObject {
  operationId: string;
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: ParameterObject[];
  requestBody?: {
    content: {
      "application/json": {
        schema: JsonSchema;
      };
    };
  };
  responses?: Record<
    string,
    {
      content?: {
        "application/json"?: {
          schema: JsonSchema;
        };
      };
    }
  >;
}

interface ParameterObject {
  name: string;
  in: string;
  schema: JsonSchema;
  required?: boolean;
  description?: string;
}

const SPEC_PATH = resolve(import.meta.dirname, "../src/generated/openapi.json");
const OUTPUT_PATH = resolve(import.meta.dirname, "../src/generated/tools.ts");
const TOOLS_MD_PATH = resolve(import.meta.dirname, "../TOOLS.md");
const API_PATH_OVERRIDES: Record<string, string> = {
  "/application.env.upsert": "/application/env/upsert",
};

interface ExactPathPolicy {
  name: string;
  title: string;
  tag: string;
  description: string;
  execution: "compose-env-upsert" | "compose-deploy-exact" | "deployment-reconcile";
  idempotent?: boolean;
}

const EXACT_PATH_POLICIES: Record<string, ExactPathPolicy> = {
  "POST /compose/env/upsert": {
    name: "compose_env_upsert",
    title: "Compose Env Upsert",
    tag: "compose",
    description:
      "Safely preview or conditionally apply partial compose environment updates without full environment replacement.",
    execution: "compose-env-upsert",
  },
  "POST /compose/deploy/exact": {
    name: "compose_deploy_exact",
    title: "Compose Deploy Exact",
    tag: "compose",
    description:
      "Deploy an exact compose Git revision with a caller-owned idempotency key and bounded identical-request retries.",
    execution: "compose-deploy-exact",
    idempotent: true,
  },
  "POST /deployment/reconcile": {
    name: "deployment_reconcile",
    title: "Deployment Reconcile",
    tag: "deployment",
    description:
      "Inspect deployment recovery state and conditionally repair only an eligible queue-empty operation.",
    execution: "deployment-reconcile",
  },
};

function deriveAnnotations(
  method: string,
  operationId: string,
  path: string,
  policy?: ExactPathPolicy,
): string {
  const id = operationId.toLowerCase();
  const isRead = method === "get";
  const isDelete = id.includes("delete") || id.includes("remove");

  const annotations: Record<string, boolean> = {};

  if (isRead) {
    annotations.readOnlyHint = true;
    annotations.idempotentHint = true;
  }
  if (isDelete || policy || path === "/compose.saveEnvironment") {
    annotations.destructiveHint = true;
  }
  if (policy?.idempotent) {
    annotations.idempotentHint = true;
  }
  annotations.openWorldHint = true;

  return JSON.stringify(annotations);
}

function getProjectingResponseSchema(op: OperationObject): string | undefined {
  const schema = op.responses?.["200"]?.content?.["application/json"]?.schema;
  if (!schema) {
    return undefined;
  }

  const removeAdditionalProperties = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(removeAdditionalProperties);
    }
    if (typeof value !== "object" || value === null) {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "additionalProperties")
        .map(([key, entry]) => [key, removeAdditionalProperties(entry)]),
    );
  };

  return jsonSchemaToZod(removeAdditionalProperties(schema) as JsonSchema);
}

function formatTitle(operationId: string): string {
  // "application-create" -> "Application Create"
  return operationId
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getZodSchema(op: OperationObject, method: string, path: string): string {
  if (method === "post" && op.requestBody?.content?.["application/json"]?.schema) {
    const sourceSchema = op.requestBody.content["application/json"].schema;
    const schema =
      path === "/compose/env/upsert" &&
      typeof sourceSchema === "object" &&
      sourceSchema !== null &&
      sourceSchema.type === "object" &&
      sourceSchema.properties?.variables
        ? {
            ...sourceSchema,
            properties: {
              ...sourceSchema.properties,
              variables: {
                ...sourceSchema.properties.variables,
                minProperties: 1,
              },
            },
          }
        : sourceSchema;
    return customZodObjectSchema(schema) ?? jsonSchemaToZod(schema);
  }

  if (op.parameters && op.parameters.length > 0) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const param of op.parameters) {
      const paramSchema =
        typeof param.schema === "object" && param.schema !== null
          ? { ...param.schema, ...(param.description ? { description: param.description } : {}) }
          : param.schema;
      properties[param.name] = paramSchema;
      if (param.required) {
        required.push(param.name);
      }
    }

    return jsonSchemaToZod({
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    });
  }

  return "z.object({})";
}

interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  anyOf?: JsonSchemaObject[];
  enum?: string[];
  items?: JsonSchemaObject;
  additionalProperties?: JsonSchemaObject | boolean;
  propertyNames?: JsonSchemaObject;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minProperties?: number;
}

function zodStringSchema(schema: JsonSchemaObject): string {
  let zod = "z.string()";
  if (schema.pattern) {
    zod += `.regex(new RegExp(${JSON.stringify(schema.pattern)}))`;
  }
  if (typeof schema.minLength === "number") {
    zod += `.min(${schema.minLength})`;
  }
  if (typeof schema.maxLength === "number") {
    zod += `.max(${schema.maxLength})`;
  }
  return zod;
}

function customZodRecordSchema(schema: JsonSchemaObject): string | null {
  if (
    schema.type !== "object" ||
    typeof schema.additionalProperties !== "object" ||
    schema.additionalProperties === null ||
    schema.additionalProperties.type !== "string" ||
    schema.propertyNames?.pattern === undefined
  ) {
    return null;
  }

  let zod = `z.record(${zodStringSchema(schema.propertyNames)}, ${zodStringSchema(schema.additionalProperties)})`;

  if (typeof schema.minProperties === "number" && schema.minProperties > 0) {
    zod += `.refine((value) => Object.keys(value).length >= ${schema.minProperties}, "At least ${schema.minProperties} propert${
      schema.minProperties === 1 ? "y is" : "ies are"
    } required")`;
  }

  return zod;
}

function customZodObjectSchema(schema: JsonSchema): string | null {
  if (
    typeof schema !== "object" ||
    schema === null ||
    schema.type !== "object" ||
    !schema.properties
  ) {
    return null;
  }

  const objectSchema = schema as JsonSchemaObject;
  const requiredSet = new Set(objectSchema.required || []);
  const propertyEntries = Object.entries(objectSchema.properties).map(([name, propSchema]) => ({
    name,
    propSchema,
    customSchema: customZodRecordSchema(propSchema),
  }));

  if (!propertyEntries.some((entry) => entry.customSchema !== null)) {
    return null;
  }

  const entries = propertyEntries.map(({ name, propSchema, customSchema }) => {
    const propertySchema = customSchema ?? jsonSchemaToZod(propSchema as JsonSchema);
    return `${JSON.stringify(name)}: ${propertySchema}${requiredSet.has(name) ? "" : ".optional()"}`;
  });

  let zod = `z.object({ ${entries.join(", ")} })`;
  if (objectSchema.additionalProperties === false) {
    zod += ".strict()";
  }
  return zod;
}

interface ToolMdEntry {
  operationId: string;
  method: string;
  tag: string;
  description: string;
  params: { name: string; type: string; required: boolean }[];
}

function schemaTypeToString(schema: JsonSchemaObject): string {
  if (schema.enum) {
    return schema.enum.map((v) => `"${v}"`).join(" | ");
  }
  if (schema.anyOf) {
    return schema.anyOf.map((s) => s.type || "unknown").join(" | ");
  }
  if (schema.type === "array" && schema.items) {
    return `${schemaTypeToString(schema.items)}[]`;
  }
  return schema.type || "unknown";
}

function extractParams(op: OperationObject, method: string): ToolMdEntry["params"] {
  const params: ToolMdEntry["params"] = [];

  if (method === "post" && op.requestBody?.content?.["application/json"]?.schema) {
    const schema = op.requestBody.content["application/json"].schema;
    if (typeof schema === "object" && schema !== null && "properties" in schema) {
      const s = schema as JsonSchemaObject;
      const requiredSet = new Set(s.required || []);
      for (const [name, propSchema] of Object.entries(s.properties || {})) {
        params.push({
          name,
          type: schemaTypeToString(propSchema),
          required: requiredSet.has(name),
        });
      }
    }
  }

  if (op.parameters) {
    for (const param of op.parameters) {
      const pSchema = typeof param.schema === "object" && param.schema !== null ? param.schema : {};
      params.push({
        name: param.name,
        type: schemaTypeToString(pSchema as JsonSchemaObject),
        required: param.required ?? false,
      });
    }
  }

  return params;
}

function generateToolsMd(entries: ToolMdEntry[]): string {
  const grouped = new Map<string, ToolMdEntry[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.tag) || [];
    list.push(entry);
    grouped.set(entry.tag, list);
  }

  const lines: string[] = [
    "# Dokploy MCP Server - Tools Documentation",
    "",
    "> Auto-generated from the [Dokploy OpenAPI spec](https://docs.dokploy.com/openapi.json). Run `pnpm generate` to update.",
    "",
    `- **Total Tools**: ${entries.length}`,
    `- **Categories**: ${grouped.size}`,
    "",
    "## Categories",
    "",
  ];

  // Table of contents
  const sortedTags = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [tag, tools] of sortedTags) {
    lines.push(`- [${tag}](#${tag}) (${tools.length} tools)`);
  }
  lines.push("");

  // Each category
  for (const [tag, tools] of sortedTags) {
    lines.push(`## ${tag}`, "");
    lines.push("| Tool | Method | Parameters |");
    lines.push("|------|--------|------------|");

    for (const tool of tools) {
      const requiredParams = tool.params.filter((p) => p.required);
      const optionalParams = tool.params.filter((p) => !p.required);

      const parts: string[] = [];
      if (requiredParams.length > 0) {
        parts.push(requiredParams.map((p) => `\`${p.name}\` (${p.type})`).join(", "));
      }
      if (optionalParams.length > 0) {
        const optCount = optionalParams.length;
        if (optCount <= 3) {
          parts.push(optionalParams.map((p) => `\`${p.name}\`?`).join(", "));
        } else {
          parts.push(`+${optCount} optional`);
        }
      }
      if (parts.length === 0) {
        parts.push("None");
      }

      lines.push(`| \`${tool.operationId}\` | ${tool.method} | ${parts.join(", ")} |`);
    }
    lines.push("");
  }

  lines.push(
    "## Annotations",
    "",
    "All tools include semantic annotations to help MCP clients understand their behavior:",
    "",
    "- **readOnlyHint**: GET endpoints that only retrieve data",
    "- **destructiveHint**: Mutations that delete, replace, deploy, or conditionally repair resources",
    "- **idempotentHint**: GET endpoints and exact deploy repeated with identical arguments only",
    "- **openWorldHint**: All tools interact with the external Dokploy API",
    "",
  );

  return lines.join("\n");
}

function main() {
  console.log("Reading OpenAPI spec...");
  const spec: OpenAPISpec = JSON.parse(readFileSync(SPEC_PATH, "utf-8"));
  const paths = Object.entries(spec.paths);
  console.log(`Processing ${paths.length} paths...`);

  const tools: string[] = [];
  const mdEntries: ToolMdEntry[] = [];
  let errorCount = 0;

  for (const [path, methods] of paths) {
    for (const [method, op] of Object.entries(methods)) {
      const operationId = op.operationId;
      if (!operationId) {
        console.warn(`Skipping ${method.toUpperCase()} ${path}: no operationId`);
        continue;
      }

      try {
        const exactPolicy = EXACT_PATH_POLICIES[`${method.toUpperCase()} ${path}`];
        const toolName = exactPolicy?.name ?? operationId;
        const apiPath = API_PATH_OVERRIDES[path] ?? path;
        const zodSchema = getZodSchema(op, method, path);
        const sourceDescription =
          path === "/compose.saveEnvironment"
            ? "HIGH RISK: full environment replacement. Use only when intentionally replacing the complete compose environment; never use redacted or reconstructed values."
            : exactPolicy?.description ||
              op.summary ||
              op.description ||
              `${method.toUpperCase()} ${path}`;
        const description = sourceDescription.replace(/`/g, "'").replace(/\\/g, "\\\\");
        const title = exactPolicy?.title ?? formatTitle(operationId);
        const annotations = deriveAnnotations(method, operationId, path, exactPolicy);
        const tag = exactPolicy?.tag ?? op.tags?.[0] ?? "unknown";
        const outputSchema = exactPolicy ? getProjectingResponseSchema(op) : undefined;

        if (exactPolicy && !outputSchema) {
          throw new Error("missing 200 application/json response schema for recovery tool");
        }

        tools.push(`  {
    name: ${JSON.stringify(toolName)},
    description: ${JSON.stringify(description)},
    tag: ${JSON.stringify(tag)},
    method: ${JSON.stringify(method.toUpperCase() as "GET" | "POST")},
    path: ${JSON.stringify(apiPath)},
    schema: ${zodSchema},
    annotations: {
      title: ${JSON.stringify(title)},
      ...${annotations},
    },${
      exactPolicy
        ? `\n    execution: { kind: ${JSON.stringify(exactPolicy.execution)}, maxAttempts: 3 },\n    outputSchema: ${outputSchema},`
        : ""
    }
  }`);

        mdEntries.push({
          operationId: toolName,
          method: method.toUpperCase(),
          tag,
          description,
          params: extractParams(op, method),
        });
      } catch (err) {
        errorCount++;
        console.error(`Error processing ${operationId}:`, (err as Error).message);
      }
    }
  }

  // Write generated tools.ts
  const output = `// AUTO-GENERATED FILE — DO NOT EDIT MANUALLY
// Generated from openapi.json
// Run \`pnpm generate\` to regenerate

import { z } from "zod";
import type { ToolDefinition } from "../types.js";

export const generatedTools: ToolDefinition[] = [
${tools.join(",\n")},
];
`;

  writeFileSync(OUTPUT_PATH, output);
  console.log(`Generated ${tools.length} tools (${errorCount} errors) -> ${OUTPUT_PATH}`);

  // Write TOOLS.md
  const md = generateToolsMd(mdEntries);
  writeFileSync(TOOLS_MD_PATH, md);
  console.log(`Generated TOOLS.md with ${mdEntries.length} tools -> ${TOOLS_MD_PATH}`);
}

main();
