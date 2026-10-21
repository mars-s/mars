import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const BRIDGE = fileURLToPath(new URL("./pty-bridge.py", import.meta.url));
const MAX_SESSIONS = 4;
const MAX_RECORDS = 16;
const BUFFER_BYTES = 256 * 1024;
const INPUT_BYTES = 64 * 1024;
const INPUT_BACKLOG = 1024 * 1024;
const POLL_MS = 20_000;
const KILL_GRACE_MS = 1000;
const MISSING = "python3 with the pty module was not found on the host.";
const ID = /^[a-f0-9]{24}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const clamp = (value, low, high, fallback) =>
  Number.isFinite(value) ? Math.min(high, Math.max(low, Math.round(value))) : fallback;
const size = (body) => ({ cols: clamp(body?.cols, 20, 400, 80), rows: clamp(body?.rows, 5, 200, 24) });

function loginShell() {
  const preferred = process.env.SHELL;
  if (preferred && preferred.startsWith("/") && existsSync(preferred)) return preferred;
  return ["/bin/zsh", "/bin/bash", "/bin/sh"].find((path) => existsSync(path)) ?? "/bin/sh";
}

/** Output ring with absolute byte offsets, keeping the newest `limit` bytes. */
export function createRing(limit = BUFFER_BYTES) {
  const chunks = [];
  let start = 0;
  let end = 0;
  return {
    get end() {
      return end;
    },
    push(chunk) {
      chunks.push(chunk);
      end += chunk.length;
      while (end - start > limit) {
        const extra = end - start - limit;
        if (chunks[0].length <= extra) start += chunks.shift().length;
        else {
          chunks[0] = chunks[0].subarray(extra);
          start += extra;
        }
      }
    },
    /** Bytes after `since`; a `since` older than the ring returns everything kept, marked dropped. */
    since(since) {
      const from = Math.min(Math.max(since, start), end);
      return { data: Buffer.concat(chunks).subarray(from - start), offset: end, dropped: since < start };
    },
  };
}

/**
 * Terminal sessions (docs/WORKBENCH.md "Terminal"). Each session is
 * `python3 pty-bridge.py <shell> -l` in `work`. Input bytes are never logged.
 */
export function createTerminal({ work, idleMs = Number(process.env.MARS_TERMINAL_IDLE_MS) || 30 * 60_000 }) {
  const sessions = new Map();
  let python;
  const available = () =>
    (python ??= run("python3", ["-c", "import pty"], { timeout: 5000 }).then(
      () => ({ ok: true, reason: "" }),
      () => ({ ok: false, reason: MISSING }),
    ));

  const live = () => [...sessions.values()].filter((session) => !session.exited);
  const touch = (session) => (session.lastActive = Date.now());
  const wake = (session) => {
    for (const waiter of [...session.waiters]) waiter();
  };

  function create(dimensions) {
    const id = randomBytes(12).toString("hex");
    const shell = loginShell();
    const env = {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: process.env.HOME || work,
      LANG: process.env.LANG || "en_US.UTF-8",
      TERM: "xterm-256color",
      SHELL: shell,
      USER: process.env.USER || process.env.LOGNAME || "",
      MARS_PTY_COLS: String(dimensions.cols),
      MARS_PTY_ROWS: String(dimensions.rows),
    };
    const child = spawn("python3", [BRIDGE, shell, "-l"], { cwd: work, env, stdio: ["pipe", "pipe", "pipe", "pipe"] });
    const session = {
      id,
      child,
      created: Date.now(),
      lastActive: Date.now(),
      ring: createRing(),
      waiters: new Set(),
      polling: 0,
      tty: "",
      killing: undefined,
      exited: false,
      exitCode: undefined,
    };
    child.stdout.on("data", (chunk) => {
      session.ring.push(chunk);
      wake(session);
    });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
      if (!session.tty) {
        const line = /^tty (\S+) \d+\n/.exec(errors);
        if (!line) return;
        session.tty = line[1];
        errors = errors.slice(line[0].length);
      }
      // Anything else on stderr is the bridge itself failing; show it in the terminal.
      if (errors) session.ring.push(Buffer.from(errors.replace(/\r?\n/g, "\r\n")));
      errors = "";
      wake(session);
    });
    for (const stream of [child.stdin, child.stdio[3]]) stream.on("error", () => {});
    child.on("error", () => {});
    child.on("close", (code, signal) => {
      session.exited = true;
      session.exitCode = code ?? 128 + (constants.signals[signal] || 0);
      wake(session);
    });
    sessions.set(id, session);
    return session;
  }

  /** Every process group still attached to the session's terminal, background jobs included. */
  async function attachedGroups(session) {
    if (!session.tty) return [];
    try {
      const { stdout } = await run("ps", ["-t", session.tty.replace(/^\/dev\//, ""), "-o", "pgid="], { timeout: 3000 });
      return [...new Set(stdout.split(/\s+/).map(Number).filter((pgid) => Number.isInteger(pgid) && pgid > 1))];
    } catch {
      return [];
    }
  }
  const signalGroups = (groups, signal) => {
    for (const pgid of groups)
      try {
        process.kill(-pgid, signal);
      } catch {}
  };

  /** Hang up everything on the terminal, then force whatever ignored the hang-up. */
  function kill(session) {
    if (session.exited) return Promise.resolve();
    return (session.killing ??= (async () => {
      const groups = await attachedGroups(session);
      signalGroups(groups, "SIGHUP");
      session.child.kill("SIGTERM");
      const closed = new Promise((resolve) => (session.exited ? resolve() : session.child.once("close", resolve)));
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS))]);
      signalGroups(groups, "SIGKILL");
      if (!session.exited) session.child.kill("SIGKILL");
      await closed;
    })());
  }

  function prune() {
    const now = Date.now();
    for (const session of sessions.values())
      if (!session.polling && now - session.lastActive > idleMs) {
        if (session.exited) sessions.delete(session.id);
        else void kill(session);
      }
    const ended = [...sessions.values()].filter((session) => session.exited).sort((a, b) => a.lastActive - b.lastActive);
    while (sessions.size > MAX_RECORDS && ended.length) sessions.delete(ended.shift().id);
  }
  setInterval(prune, Math.max(250, Math.min(60_000, Math.floor(idleMs / 3)))).unref();
  process.once("exit", () => {
    for (const session of live()) session.child.kill("SIGTERM");
  });

  function poll(session, since, res) {
    touch(session);
    const read = () => {
      const { data, offset, dropped } = session.ring.since(since);
      return {
        offset,
        data: data.toString("base64"),
        ...(dropped ? { dropped: true } : {}),
        ...(session.exited ? { exited: true, exitCode: session.exitCode } : {}),
      };
    };
    if (session.ring.end > since || session.exited) return Promise.resolve(read());
    return new Promise((resolve) => {
      session.polling++;
      const done = () => {
        clearTimeout(timer);
        session.waiters.delete(done);
        res.off("close", done);
        session.polling--;
        touch(session);
        resolve(read());
      };
      const timer = setTimeout(done, POLL_MS);
      session.waiters.add(done);
      res.once("close", done);
    });
  }

  function find(id) {
    const session = ID.test(id) ? sessions.get(id) : undefined;
    if (!session) throw fail("Terminal session not found", 404);
    return session;
  }

  return {
    available,
    async handle(req, res, url, route, { send, jsonBody }) {
      if (route === "terminals" && req.method === "GET") {
        prune();
        send(res, 200, {
          sessions: [...sessions.values()].map(({ id, created, lastActive, exited, exitCode }) => ({ id, created, lastActive, exited, exitCode })),
        });
        return true;
      }
      if (route === "terminal" && req.method === "POST") {
        const body = await jsonBody(req);
        const status = await available();
        if (!status.ok) throw fail(status.reason, 503);
        prune();
        if (live().length >= MAX_SESSIONS) throw fail(`At most ${MAX_SESSIONS} terminal sessions can run at once. End one first.`, 429);
        send(res, 201, { id: create(size(body)).id });
        return true;
      }
      const match = /^terminal\/([^/]+)(?:\/(input|resize|kill))?$/.exec(route);
      if (!match) return false;
      const [, id, action] = match;
      if (!action && req.method === "GET") {
        const session = find(id);
        const since = Number(url.searchParams.get("since") ?? 0);
        if (!Number.isSafeInteger(since) || since < 0) throw fail("since must be a byte offset");
        const reply = await poll(session, since, res);
        if (!res.destroyed) send(res, 200, reply);
        return true;
      }
      if (!action || req.method !== "POST") return false;
      const session = find(id);
      const body = await jsonBody(req);
      touch(session);
      if (action === "kill") {
        await kill(session);
        send(res, 200, { id, exited: true, exitCode: session.exitCode });
        return true;
      }
      if (session.exited) throw fail("This terminal session has ended", 409);
      if (action === "resize") {
        const { cols, rows } = size(body);
        session.child.stdio[3].write(`R ${cols} ${rows}\n`);
        send(res, 200, { cols, rows });
        return true;
      }
      const data = typeof body.data === "string" ? body.data : "";
      if (!BASE64.test(data) || data.length % 4) throw fail("data must be base64");
      const bytes = Buffer.from(data, "base64");
      if (bytes.length > INPUT_BYTES) throw fail("Terminal input is limited to 64 KiB per request", 413);
      if (session.child.stdin.writableLength > INPUT_BACKLOG) throw fail("The terminal is not reading input yet. Try again shortly.", 429);
      session.child.stdin.write(bytes);
      send(res, 200, { accepted: bytes.length });
      return true;
    },
  };
}
