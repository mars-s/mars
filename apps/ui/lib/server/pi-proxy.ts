type ProxyOptions = { origin?: string; token?: string; fetcher?: typeof fetch };

export async function proxyPi(request: Request, options: ProxyOptions = {}): Promise<Response> {
  const local = new URL(request.url);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(local.hostname) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    return Response.json({ error: "Local development access only" }, { status: 403 });
  }
  const extension = /^\/extensions\/[a-f0-9]{64}\/client\.js$/.test(local.pathname);
  if (!local.pathname.startsWith("/api/") && !extension)
    return Response.json({ error: "Unsupported Pi route" }, { status: 404 });
  if (!["GET", "POST"].includes(request.method) || (extension && request.method !== "GET"))
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  if (request.method === "POST" && request.headers.get("origin") !== local.origin)
    return Response.json({ error: "Origin rejected" }, { status: 403 });
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
