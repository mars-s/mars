type ProxyOptions = { origin?: string; token?: string; fetcher?: typeof fetch; production?: boolean };

const LOCAL_NAMES = ["localhost", "127.0.0.1", "[::1]"];
/** The Host header the browser actually sent. Next rewrites request.url to localhost whatever the browser used. */
function sentHost(request: Request): URL | undefined {
  // Requests built in tests carry no Host header; then the URL's host is what was sent.
  const host = request.headers.get("host") ?? new URL(request.url).host;
  try {
    return new URL(`${new URL(request.url).protocol}//${host}`);
  } catch {
    return undefined;
  }
}

// A workbench browse path carrying a per-port key (docs/WORKBENCH.md "Services and
// browser"). The sandboxed page's own requests are cross-site and cookieless, so this
// one shape skips the same-site, origin and JSON checks. It is forwarded WITHOUT the
// owner token: the host accepts it only for a live key bound to that port.
const KEYED_BROWSE = /^\/api\/workbench\/browse\/\d{1,5}\/~[A-Za-z0-9_-]{43}(?:\/|$)/;
const BROWSE_BODY_LIMIT = 20 * 1024 * 1024;
const BROWSE_HEADERS = ["content-type", "content-security-policy", "location", "cache-control", "last-modified", "content-disposition"];

/** Read a request body up to `limit` bytes; a chunked body cannot grow past it. */
async function boundedBody(request: Request, limit: number): Promise<ArrayBuffer> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw Object.assign(Error("Request too large"), { status: 413 });
      }
      chunks.push(value);
    }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function proxyKeyedBrowse(request: Request, local: URL, target: URL, fetcher: typeof fetch): Promise<Response> {
  if (!["GET", "POST", "HEAD"].includes(request.method)) return Response.json({ error: "Method not allowed" }, { status: 405 });
  if (Number(request.headers.get("content-length")) > BROWSE_BODY_LIMIT)
    return Response.json({ error: "Request too large" }, { status: 413 });
  const headers: Record<string, string> = {};
  for (const name of ["accept", "accept-language", "content-type", "if-none-match", "if-modified-since", "range"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  try {
    const upstream = await fetcher(new URL(local.pathname + local.search, target), {
      method: request.method,
      body: request.method === "POST" ? await boundedBody(request, BROWSE_BODY_LIMIT) : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(35000),
      headers,
    });
    const out = new Headers({
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      // Module scripts and fetches from the opaque-origin frame are CORS requests. The
      // keyed path never carries credentials, so allowing the opaque origin exposes
      // only this service's own responses back to its own page.
      "access-control-allow-origin": "null",
    });
    for (const name of BROWSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    // Whatever the host said, the response stays sandboxed.
    if (!out.get("content-security-policy")?.includes("sandbox"))
      out.set("content-security-policy", "sandbox allow-scripts allow-forms allow-popups; frame-ancestors 'self'");
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch (failure) {
    if ((failure as { status?: number }).status === 413) return Response.json({ error: "Request too large" }, { status: 413 });
    return Response.json({ error: "Cannot reach the private Pi backend." }, { status: 502 });
  }
}

export async function proxyPi(request: Request, options: ProxyOptions = {}): Promise<Response> {
  // Production browsers reach /api on the Pi host itself, which forwards only pages to
  // Next. This proxy adds the owner token for its caller, so it exists for local
  // development only and is off in a production build.
  if (options.production ?? process.env.NODE_ENV === "production")
    return Response.json({ error: "Not found" }, { status: 404 });
  const local = new URL(request.url);
  const keyedBrowse = KEYED_BROWSE.test(local.pathname);
  const sent = sentHost(request);
  if (
    !LOCAL_NAMES.includes(local.hostname) ||
    // DNS rebinding: an attacker's name resolving to 127.0.0.1 still sends its own Host.
    !sent ||
    !LOCAL_NAMES.includes(sent.hostname) ||
    (request.headers.get("sec-fetch-site") === "cross-site" && !keyedBrowse)
  ) {
    return Response.json({ error: "Local development access only" }, { status: 403 });
  }
  const extension = /^\/extensions\/[a-f0-9]{64}\/client\.js$/.test(local.pathname);
  if (!local.pathname.startsWith("/api/") && !extension)
    return Response.json({ error: "Unsupported Pi route" }, { status: 404 });
  if (!keyedBrowse) {
    if (!["GET", "POST"].includes(request.method) || (extension && request.method !== "GET"))
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    // The page's own origin is the local host the browser addressed, so 127.0.0.1 and localhost both work.
    if (request.method === "POST" && request.headers.get("origin") !== sent.origin)
      return Response.json({ error: "Origin rejected" }, { status: 403 });
  }
  const origin = options.origin ?? process.env.MARS_PI_ORIGIN;
  const token = options.token ?? process.env.MARS_PI_TOKEN;
  if (!origin || !token)
    return Response.json(
      {
        error:
          "Set MARS_PI_ORIGIN and MARS_PI_TOKEN in .env.local to connect this development client.",
      },
      { status: 503 },
    );
  let target: URL;
  try {
    target = new URL(origin);
    const localHttp =
      target.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname);
    if (
      (!localHttp && target.protocol !== "https:") ||
      target.username ||
      target.password ||
      target.pathname !== "/" ||
      target.search ||
      target.hash
    )
      throw Error();
  } catch {
    return Response.json({ error: "Invalid private Pi origin" }, { status: 503 });
  }
  if (keyedBrowse) return proxyKeyedBrowse(request, local, target, options.fetcher ?? fetch);
  const imageUpload = local.pathname === "/api/attachments" && request.method === "POST";
  const contentType = request.headers.get("content-type") || "";
  let body: ArrayBuffer | undefined;
  if (request.method === "POST") {
    if (imageUpload ? !/^image\/(png|jpeg|webp|gif)$/.test(contentType) : !contentType.startsWith("application/json"))
      return Response.json({ error: imageUpload ? "Supported image required" : "JSON required" }, { status: 415 });
    const maximum = (imageUpload ? 10 : 2) * 1024 * 1024;
    if (Number(request.headers.get("content-length")) > maximum)
      return Response.json({ error: "Request too large" }, { status: 413 });
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximum) {
          await reader.cancel();
          return Response.json({ error: "Request too large" }, { status: 413 });
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    body = bytes.buffer;
  }
  const remote = new URL(local.pathname + local.search, target);
  try {
    const upstream = await (options.fetcher ?? fetch)(remote, {
      method: request.method,
      body,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(25000),
      headers: {
        authorization: `Bearer ${token}`,
        origin: target.origin,
        ...(body ? { "content-type": imageUpload ? contentType : "application/json" } : {}),
        ...(imageUpload ? { "x-file-name": request.headers.get("x-file-name") || "image" } : {}),
      },
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": extension
          ? "text/javascript"
          : (upstream.headers.get("content-type") ?? "application/json"),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        // Downloads keep their attachment name (docs/WORKBENCH.md "File downloads").
        ...(local.pathname === "/api/workbench/download" && upstream.headers.get("content-disposition")
          ? { "content-disposition": upstream.headers.get("content-disposition") as string }
          : {}),
        // Keep the host's policy (a sandbox on browse pages, frame-ancestors elsewhere).
        ...(upstream.headers.get("content-security-policy")
          ? { "content-security-policy": upstream.headers.get("content-security-policy") as string }
          : {}),
      },
    });
  } catch {
    return Response.json(
      {
        error:
          "Cannot reach the private Pi backend. Check Tailscale and the development connection settings.",
      },
      { status: 502 },
    );
  }
}
