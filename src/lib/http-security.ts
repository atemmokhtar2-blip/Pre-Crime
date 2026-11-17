export type TextBodyResult =
  | { ok: true; value: string }
  | { ok: false; status: 400 | 413 };

export type JsonBodyResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 413 };

/** Read UTF-8 request text while enforcing a hard byte limit, including chunked requests. */
export async function readTextBody(request: Request, maxBytes = 1024 * 1024): Promise<TextBodyResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("invalid_request_body_limit");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^[0-9]+$/.test(declaredLength)) return { ok: false, status: 400 };
    if (Number(declaredLength) > maxBytes) return { ok: false, status: 413 };
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400 };

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400 };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, status: 400 };
  }
}

/** Parse JSON while enforcing a hard byte limit, including chunked requests. */
export async function readJsonBody<T>(request: Request, maxBytes = 1024 * 1024): Promise<JsonBodyResult<T>> {
  const body = await readTextBody(request, maxBytes);
  if (body.ok === false) return { ok: false, status: body.status };

  try {
    return { ok: true, value: JSON.parse(body.value) as T };
  } catch {
    return { ok: false, status: 400 };
  }
}
