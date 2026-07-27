/**
 * Soniox async transcription client for afterimage.
 * Adapted from wayo-voice/worker/src/soniox.ts — simplified for fire-and-forget video transcription.
 */

const DEFAULT_MODEL = "stt-async-v5";
const DEFAULT_LANGUAGE_HINTS = ["ja", "en"];

interface SonioxEnv {
  SONIOX_API_KEY: string;
  SONIOX_MODEL?: string;
  SONIOX_LANGUAGE_HINTS?: string;
}

function sonioxBase(): string {
  return "https://api.soniox.com/v1";
}

function sonioxHeaders(env: SonioxEnv): Headers {
  return new Headers({ authorization: "Bearer " + env.SONIOX_API_KEY });
}

function parseLanguageHints(env: SonioxEnv): string[] {
  const raw = env.SONIOX_LANGUAGE_HINTS;
  if (!raw) return DEFAULT_LANGUAGE_HINTS;
  const hints = raw.split(",").map((p) => p.trim()).filter(Boolean);
  return hints.length > 0 ? hints : DEFAULT_LANGUAGE_HINTS;
}

async function checkedResponse(response: Response, action: string): Promise<Response> {
  if (response.ok) return response;
  let body: any = {};
  try {
    body = await response.json();
  } catch {
    body = { message: await response.text().catch(() => "") };
  }
  const err = new Error(body.message || body.error_message || `${action} failed`) as Error & {
    status?: number;
    code?: string;
  };
  err.status = 502;
  err.code = body.error_type || "soniox_error";
  throw err;
}

/** Upload audio/video bytes to Soniox, returns file_id. */
export async function uploadToSoniox(
  env: SonioxEnv,
  data: ArrayBuffer,
  filename: string,
  contentType: string,
): Promise<string> {
  if (!env.SONIOX_API_KEY) {
    throw Object.assign(new Error("SONIOX_API_KEY is not configured"), { status: 500, code: "missing_soniox_key" });
  }
  const form = new FormData();
  form.set("file", new File([data], filename, { type: contentType }));
  const response = await fetch(`${sonioxBase()}/files`, {
    method: "POST",
    headers: sonioxHeaders(env),
    body: form,
  });
  await checkedResponse(response, "file upload");
  const body = (await response.json()) as any;
  return body.id;
}

/** Create an async transcription job, returns transcription_id. */
export async function createTranscription(
  env: SonioxEnv,
  fileId: string,
): Promise<string> {
  const payload = {
    model: env.SONIOX_MODEL || DEFAULT_MODEL,
    file_id: fileId,
    language_hints: parseLanguageHints(env),
    language_hints_strict: false,
    enable_speaker_diarization: true,
    enable_language_identification: true,
  };
  const response = await fetch(`${sonioxBase()}/transcriptions`, {
    method: "POST",
    headers: new Headers({ ...Object.fromEntries(sonioxHeaders(env)), "content-type": "application/json" }),
    body: JSON.stringify(payload),
  });
  await checkedResponse(response, "transcription create");
  const body = (await response.json()) as any;
  return body.id;
}

/** Check transcription status. Returns { status, error_type?, error_message? }. */
export async function getTranscriptionStatus(
  env: SonioxEnv,
  transcriptionId: string,
): Promise<{ status: string; error_type?: string; error_message?: string }> {
  const response = await fetch(`${sonioxBase()}/transcriptions/${transcriptionId}`, {
    headers: sonioxHeaders(env),
  });
  await checkedResponse(response, "transcription status");
  return response.json() as any;
}

/** Fetch the completed transcript. Returns { text, tokens?, language? }. */
export async function getTranscript(
  env: SonioxEnv,
  transcriptionId: string,
): Promise<{ text: string; tokens?: any[]; language?: string }> {
  const response = await fetch(`${sonioxBase()}/transcriptions/${transcriptionId}/transcript`, {
    headers: sonioxHeaders(env),
  });
  await checkedResponse(response, "transcript fetch");
  return response.json() as any;
}

/** Best-effort cleanup of Soniox resources. */
export async function cleanupSoniox(env: SonioxEnv, transcriptionId?: string | null, fileId?: string | null): Promise<void> {
  if (transcriptionId) {
    try {
      await fetch(`${sonioxBase()}/transcriptions/${transcriptionId}`, { method: "DELETE", headers: sonioxHeaders(env) });
    } catch { /* best-effort */ }
  }
  if (fileId) {
    try {
      await fetch(`${sonioxBase()}/files/${fileId}`, { method: "DELETE", headers: sonioxHeaders(env) });
    } catch { /* best-effort */ }
  }
}
