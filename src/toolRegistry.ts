import { schemaToJson } from "./toolSchemas.js";
import { z } from "zod";

export interface ToolDoc {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
}

const docs: ToolDoc[] = [];

export function recordToolDoc(doc: ToolDoc) {
  const index = docs.findIndex((item) => item.name === doc.name);
  if (index >= 0) docs[index] = doc;
  else docs.push(doc);
}

export function getToolDocs(): ToolDoc[] {
  return [...docs].sort((a, b) => a.name.localeCompare(b.name));
}

export function zodRawShapeToJson(shape: z.ZodRawShape): unknown {
  return schemaToJson(z.object(shape));
}

export function openApiSpec() {
  const paths: Record<string, unknown> = {};
  for (const tool of getToolDocs()) {
    paths[`/tools/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.description,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: tool.inputSchema
            }
          }
        },
        responses: {
          "200": {
            description: "MCP tool result JSON inside content[0].text",
            content: {
              "application/json": {
                schema: tool.outputSchema ?? { type: "object" }
              }
            }
          }
        }
      }
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "autoUWLearn MCP Tools",
      version: "0.1.0",
      description:
        "Documentation view for UW LEARN MCP tools. These are MCP tools, not direct REST endpoints; call them through the MCP endpoint /mcp."
    },
    servers: [{ url: "https://mcp.example.com/mcp", description: "MCP endpoint" }],
    paths
  };
}
