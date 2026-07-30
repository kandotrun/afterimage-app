import { z } from "zod";

const SONIOX_BASE = "https://api.soniox.com/v1" as const;
const DEFAULT_MODEL = "stt-async-v5" as const;
const DEFAULT_LANGUAGE_HINTS = ["ja", "en"] as const;

const sonioxIdSchema = z.object({
  id: z.string().min(1),
});

const sonioxErrorSchema = z.object({
  message: z.string().optional(),
  error_message: z.string().optional(),
  error_type: z.string().optional(),
});

const transcriptionStatusSchema = z.object({
  status: z.enum(["queued", "processing", "completed", "error"]),
  error_type: z.string().nullish(),
  error_message: z.string().nullish(),
});

const transcriptSchema = z.object({
  text: z.string(),
  language: z.string().nullish(),
});

interface SonioxEnv {
  readonly SONIOX_API_KEY: string;
  readonly SONIOX_MODEL?: string;
  readonly SONIOX_LANGUAGE_HINTS?: string;
}

export interface SonioxUpload {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly filename: string;
  readonly contentType: string;
}

class SonioxError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sonioxHeaders(env: SonioxEnv): Headers {
  return new Headers({ authorization: `Bearer ${env.SONIOX_API_KEY}` });
}

function parseLanguageHints(env: SonioxEnv): readonly string[] {
  const raw = env.SONIOX_LANGUAGE_HINTS;
  if (!raw) return DEFAULT_LANGUAGE_HINTS;
  const hints = raw.split(",").map((part) => part.trim()).filter(Boolean);
  return hints.length > 0 ? hints : DEFAULT_LANGUAGE_HINTS;
}

async function checkedResponse(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const parsed = sonioxErrorSchema.safeParse(payload);
  const message = parsed.success
    ? parsed.data.message ?? parsed.data.error_message ?? `${action} failed`
    : `${action} failed`;
  const code = parsed.success
    ? parsed.data.error_type ?? "soniox_error"
    : "soniox_error";
  throw new SonioxError(message, 502, code);
}

async function parseResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
): Promise<T> {
  const payload: unknown = await response.json();
  return schema.parse(payload);
}

export async function uploadToSoniox(
  env: SonioxEnv,
  upload: SonioxUpload,
): Promise<string> {
  if (!env.SONIOX_API_KEY) {
    throw new SonioxError(
      "SONIOX_API_KEY is not configured",
      500,
      "missing_soniox_key",
    );
  }

  const boundary = `afterimage-${crypto.randomUUID().replaceAll("-", "")}`;
  const encodedFilename = encodeURIComponent(upload.filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}\r\nContent-Type: ${upload.contentType}\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const reader = upload.body.getReader();
  let headerSent = false;
  let bodyFinished = false;
  let footerSent = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true;
        controller.enqueue(prefix);
        return;
      }
      if (!bodyFinished) {
        const chunk = await reader.read();
        if (!chunk.done) {
          controller.enqueue(chunk.value);
          return;
        }
        bodyFinished = true;
      }
      if (!footerSent) {
        footerSent = true;
        controller.enqueue(suffix);
        return;
      }
      controller.close();
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  const contentLength = prefix.byteLength + upload.size + suffix.byteLength;
  const fixedBody = body.pipeThrough(new FixedLengthStream(contentLength));
  const headers = sonioxHeaders(env);
  headers.set("content-type", `multipart/form-data; boundary=${boundary}`);
  const response = await fetch(`${SONIOX_BASE}/files`, {
    method: "POST",
    headers,
    body: fixedBody,
  });
  await checkedResponse(response, "file upload");
  return (await parseResponse(response, sonioxIdSchema)).id;
}

export async function createTranscription(
  env: SonioxEnv,
  source: { readonly fileId: string } | { readonly audioUrl: string },
): Promise<string> {
  const headers = sonioxHeaders(env);
  headers.set("content-type", "application/json");
  const response = await fetch(`${SONIOX_BASE}/transcriptions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...("fileId" in source
        ? { file_id: source.fileId }
        : { audio_url: source.audioUrl }),
      model: env.SONIOX_MODEL || DEFAULT_MODEL,
      language_hints: parseLanguageHints(env),
      language_hints_strict: false,
      enable_speaker_diarization: true,
      enable_language_identification: true,
    }),
  });
  await checkedResponse(response, "transcription create");
  return (await parseResponse(response, sonioxIdSchema)).id;
}

export async function getTranscriptionStatus(
  env: SonioxEnv,
  transcriptionId: string,
) {
  const response = await fetch(
    `${SONIOX_BASE}/transcriptions/${transcriptionId}`,
    { headers: sonioxHeaders(env) },
  );
  await checkedResponse(response, "transcription status");
  return parseResponse(response, transcriptionStatusSchema);
}

export async function getTranscript(
  env: SonioxEnv,
  transcriptionId: string,
) {
  const response = await fetch(
    `${SONIOX_BASE}/transcriptions/${transcriptionId}/transcript`,
    { headers: sonioxHeaders(env) },
  );
  await checkedResponse(response, "transcript fetch");
  return parseResponse(response, transcriptSchema);
}

export async function cleanupSoniox(
  env: SonioxEnv,
  transcriptionId?: string | null,
  fileId?: string | null,
): Promise<void> {
  const requests = [
    ...(transcriptionId
      ? [fetch(`${SONIOX_BASE}/transcriptions/${transcriptionId}`, {
        method: "DELETE",
        headers: sonioxHeaders(env),
      })]
      : []),
    ...(fileId
      ? [fetch(`${SONIOX_BASE}/files/${fileId}`, {
        method: "DELETE",
        headers: sonioxHeaders(env),
      })]
      : []),
  ];
  await Promise.allSettled(requests);
}

export async function deleteSonioxResources(
  env: SonioxEnv,
  transcriptionId: string | null,
  fileId: string | null,
): Promise<void> {
  if (!transcriptionId && !fileId) return;
  if (!env.SONIOX_API_KEY) throw new Error("SONIOX_API_KEY is not configured");
  const targets = [
    ...(transcriptionId ? [`${SONIOX_BASE}/transcriptions/${transcriptionId}`] : []),
    ...(fileId ? [`${SONIOX_BASE}/files/${fileId}`] : []),
  ];
  for (const target of targets) {
    const response = await fetch(target, {
      method: "DELETE",
      headers: sonioxHeaders(env),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error("Soniox resource deletion failed");
    }
  }
}
