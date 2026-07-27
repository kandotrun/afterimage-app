import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

interface McpAuthRow {
  id: string;
  user_id: string;
}

interface TranscriptionListRow {
  id: string;
  filename: string;
  captured_at: string;
  duration_ms: number | null;
  transcript: string;
  transcript_language: string | null;
}

interface TranscriptionDetailRow extends TranscriptionListRow {
  content_type: string;
}

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "mcp-session-id",
};

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unauthorized(): Response {
  return Response.json(
    { error: "invalid_token", error_description: "A valid Afterimage MCP token is required." },
    {
      status: 401,
      headers: {
        ...corsHeaders,
        "www-authenticate": 'Bearer realm="afterimage-mcp"',
      },
    },
  );
}

function encodeCursor(capturedAt: string, id: string): string {
  return btoa(JSON.stringify({ capturedAt, id }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeCursor(cursor: string | undefined): { capturedAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const padded = cursor.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(cursor.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded)) as { capturedAt?: unknown; id?: unknown };
    if (typeof parsed.capturedAt !== "string" || typeof parsed.id !== "string") return null;
    if (Number.isNaN(Date.parse(parsed.capturedAt)) || !/^[0-9a-f-]{36}$/i.test(parsed.id)) return null;
    return { capturedAt: parsed.capturedAt, id: parsed.id };
  } catch {
    return null;
  }
}

function preview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

function textResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function createMcpServer(bindings: Env, userId: string): McpServer {
  const server = new McpServer(
    { name: "afterimage", version: "1.0.0" },
    { instructions: "Read-only access to the authenticated user's Afterimage video transcriptions." },
  );

  server.registerTool(
    "list_transcriptions",
    {
      title: "List Afterimage transcriptions",
      description: "List the authenticated user's transcribed video memories, newest first. Optionally search transcript text.",
      inputSchema: {
        query: z.string().trim().min(1).max(200).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        cursor: z.string().max(512).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, from, to, cursor, limit }) => {
      const decodedCursor = decodeCursor(cursor);
      if (cursor && !decodedCursor) {
        return {
          content: [{ type: "text", text: "Invalid pagination cursor." }],
          isError: true,
        };
      }

      const clauses = [
        "user_id = ?",
        "kind = 'video'",
        "status = 'ready'",
        "transcription_status = 'completed'",
        "transcript IS NOT NULL",
        "length(trim(transcript)) > 0",
      ];
      const values: unknown[] = [userId];
      if (query) {
        clauses.push("transcript LIKE ? ESCAPE '\\' COLLATE NOCASE");
        values.push(`%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
      }
      if (from) {
        clauses.push("captured_at >= ?");
        values.push(from);
      }
      if (to) {
        clauses.push("captured_at <= ?");
        values.push(to);
      }
      if (decodedCursor) {
        clauses.push("(captured_at < ? OR (captured_at = ? AND id < ?))");
        values.push(decodedCursor.capturedAt, decodedCursor.capturedAt, decodedCursor.id);
      }
      values.push(limit + 1);

      const result = await bindings.DB.prepare(
        `SELECT id, filename, captured_at, duration_ms, transcript, transcript_language
           FROM assets
          WHERE ${clauses.join(" AND ")}
          ORDER BY captured_at DESC, id DESC
          LIMIT ?`,
      ).bind(...values).all<TranscriptionListRow>();
      const rows = result.results.slice(0, limit);
      const last = rows.at(-1);
      const payload = {
        items: rows.map((row) => ({
          id: row.id,
          filename: row.filename,
          capturedAt: row.captured_at,
          durationMs: row.duration_ms,
          language: row.transcript_language,
          transcriptPreview: preview(row.transcript),
          transcriptCharacters: row.transcript.length,
        })),
        nextCursor: result.results.length > limit && last ? encodeCursor(last.captured_at, last.id) : null,
      };
      return textResult(payload);
    },
  );

  server.registerTool(
    "get_transcription",
    {
      title: "Get an Afterimage transcription",
      description: "Get the complete transcript for one video memory owned by the authenticated user.",
      inputSchema: {
        assetId: z.string().uuid(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ assetId }) => {
      const row = await bindings.DB.prepare(
        `SELECT id, filename, content_type, captured_at, duration_ms, transcript, transcript_language
           FROM assets
          WHERE id = ? AND user_id = ? AND kind = 'video' AND status = 'ready'
            AND transcription_status = 'completed' AND transcript IS NOT NULL`,
      ).bind(assetId, userId).first<TranscriptionDetailRow>();
      if (!row) {
        return {
          content: [{ type: "text", text: "Transcription not found." }],
          isError: true,
        };
      }
      return textResult({
        id: row.id,
        filename: row.filename,
        contentType: row.content_type,
        capturedAt: row.captured_at,
        durationMs: row.duration_ms,
        language: row.transcript_language,
        transcript: row.transcript,
      });
    },
  );

  return server;
}

export async function handleMcpRequest(request: Request, bindings: Env, now: Date): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const authorization = request.headers.get("authorization");
  const match = authorization ? /^Bearer (aft_mcp_[A-Za-z0-9_-]{43})$/.exec(authorization) : null;
  if (!match?.[1]) return unauthorized();

  const auth = await bindings.DB.prepare(
    `SELECT id, user_id FROM mcp_tokens
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(await sha256Hex(match[1]), now.toISOString()).first<McpAuthRow>();
  if (!auth) return unauthorized();

  const lastUsedCutoff = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  await bindings.DB.prepare(
    `UPDATE mcp_tokens SET last_used_at = ?
      WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
  ).bind(now.toISOString(), auth.id, lastUsedCutoff).run();

  const server = createMcpServer(bindings, auth.user_id);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
