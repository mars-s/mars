/**
 * Refresh-rotation locking tests.
 *
 * ChatGPT refresh tokens are single-use, so the only safe protocol is:
 * read -> exchange -> write back, all under one cross-process lock, and adopt a
 * peer's pair instead of replaying a token it already spent. These tests prove
 * that protocol against the real file-lock primitive, including a real second
 * OS process.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { ChatGptGrantStore } from "../src/oauth/providers/chatgpt/chatgptGrantStore.js";

const FIXED_NOW = 1_700_000_000_000;

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function makeStorePath(): Promise<{ dir: string; storePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-chatgpt-grant-"));
  return { dir, storePath: join(dir, "oauth-grant.json") };
}

function newStore(storePath: string): ChatGptGrantStore {
  return new ChatGptGrantStore({ storePath, now: () => FIXED_NOW });
}

test("rotate exchanges the stored refresh token and writes the new pair back", async () => {
  const { dir, storePath } = await makeStorePath();
  try {
    const store = newStore(storePath);
    await store.write({
      accessToken: "at-1",
      refreshToken: "rt-1",
      accountId: "acct",
      expiresAt: 1,
    });

    let submitted: string | null = null;
    const outcome = await store.rotate({
      expectedRefreshToken: "rt-1",
      exchange: async (grant) => {
        submitted = grant.refreshToken;
        return { accessToken: "at-2", refreshToken: "rt-2", expiresAt: 2 };
      },
    });

    assert.equal(outcome.status, "rotated");
    assert.equal(submitted, "rt-1");
    assert.equal(outcome.grant?.accessToken, "at-2");
    assert.equal(outcome.grant?.rotation, 2);

    const persisted = await store.read();
    assert.equal(persisted?.refreshToken, "rt-2");
    assert.equal(persisted?.accessToken, "at-2");
    // A corrupt store must never be a way to end up with an unencrypted file.
    assert.match(await readFile(storePath, "utf-8"), /"version": 1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a peer that already rotated is adopted, and no token is submitted", async () => {
  const { dir, storePath } = await makeStorePath();
  try {
    const store = newStore(storePath);
    await store.write({
      accessToken: "at-1",
      refreshToken: "rt-1",
      accountId: null,
      expiresAt: null,
    });

    let submitted = 0;
    const first = await store.rotate({
      expectedRefreshToken: "rt-1",
      exchange: async () => {
        submitted += 1;
        return { accessToken: "at-2", refreshToken: "rt-2", expiresAt: null };
      },
    });
    assert.equal(first.status, "rotated");

    // A second holder of the now-dead rt-1 must adopt, not replay it.
    const second = await store.rotate({
      expectedRefreshToken: "rt-1",
      exchange: async () => {
        submitted += 1;
        return { accessToken: "at-3", refreshToken: "rt-3", expiresAt: null };
      },
    });

    assert.equal(submitted, 1, "a spent refresh token must never be submitted twice");
    assert.equal(second.status, "adopted");
    assert.equal(second.grant?.refreshToken, "rt-2");
    assert.equal(second.grant?.accessToken, "at-2");
    assert.equal(second.grant?.rotation, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent rotations in one process exchange exactly once", async () => {
  const { dir, storePath } = await makeStorePath();
  try {
    const store = newStore(storePath);
    await store.write({
      accessToken: "at-1",
      refreshToken: "rt-1",
      accountId: null,
      expiresAt: null,
    });

    let exchanges = 0;
    const rotate = () =>
      store.rotate({
        expectedRefreshToken: "rt-1",
        exchange: async () => {
          exchanges += 1;
          // The write-back must be atomic with the read, so a concurrent reader
          // can never observe a half-rotated grant.
          await sleep(20);
          assert.equal((await store.read())?.refreshToken, "rt-1");
          return {
            accessToken: `at-${exchanges + 1}`,
            refreshToken: `rt-${exchanges + 1}`,
            expiresAt: null,
          };
        },
      });

    const outcomes = await Promise.all([rotate(), rotate(), rotate(), rotate()]);
    const rotated = outcomes.filter((outcome) => outcome.status === "rotated");
    const adopted = outcomes.filter((outcome) => outcome.status === "adopted");

    assert.equal(exchanges, 1, "only the holder of the live token may exchange it");
    assert.equal(rotated.length, 1);
    assert.equal(adopted.length, 3);
    for (const outcome of adopted) {
      assert.equal(outcome.grant?.refreshToken, "rt-2");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rotation reports unlocked when this app owns no grant", async () => {
  const { dir, storePath } = await makeStorePath();
  try {
    const outcome = await newStore(storePath).rotate({
      expectedRefreshToken: "rt-1",
      exchange: async () => {
        throw new Error("must not exchange without a stored grant");
      },
    });
    assert.equal(outcome.status, "unlocked");
    assert.equal(outcome.grant, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt store fails loudly instead of looking like no grant", async () => {
  const { dir, storePath } = await makeStorePath();
  try {
    await writeFile(storePath, "{ truncated", "utf-8");
    await assert.rejects(() => newStore(storePath).read(), /corrupt/);

    // A hand-edited file that dropped the token material must not be read as an
    // empty store, or a later login would overwrite a live grant elsewhere.
    await writeFile(
      storePath,
      JSON.stringify({ version: 1, accessToken: "", refreshToken: "" }),
      "utf-8",
    );
    await assert.rejects(() => newStore(storePath).read(), /missing token material/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a genuine second process cannot rotate the grant while the first holds it", async () => {
  const { dir, storePath } = await makeStorePath();
  const markerPath = join(dir, "child-in-critical-section");
  const scriptPath = join(dir, "child.mts");
  try {
    const store = newStore(storePath);
    await store.write({
      accessToken: "at-1",
      refreshToken: "rt-1",
      accountId: null,
      expiresAt: null,
    });

    // The child takes the real cross-process lock, announces it is inside the
    // critical section, and only then does the parent attempt a rotation.
    const childSource = `
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { ChatGptGrantStore } from ${JSON.stringify(
      fileURLToPath(
        new URL("../src/oauth/providers/chatgpt/chatgptGrantStore.js", import.meta.url),
      ),
    )};

const store = new ChatGptGrantStore({ storePath: ${JSON.stringify(storePath)} });
const outcome = await store.rotate({
  expectedRefreshToken: "rt-1",
  exchange: async () => {
    await writeFile(${JSON.stringify(markerPath)}, "inside", "utf-8");
    await sleep(700);
    return { accessToken: "at-child", refreshToken: "rt-child", expiresAt: null };
  },
});
await writeFile(${JSON.stringify(join(dir, "child-result.json"))}, JSON.stringify(outcome.status), "utf-8");
`;
    await writeFile(scriptPath, childSource, "utf-8");

    const child = spawn(process.execPath, ["--import", "tsx", scriptPath], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    const childExit = new Promise<number>((resolve, reject) => {
      child.on("exit", (code) => resolve(code ?? -1));
      child.on("error", reject);
    });

    const deadline = Date.now() + 30_000;
    while (!(await pathExists(markerPath))) {
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error("child process never entered the critical section");
      }
      await sleep(25);
    }

    // The child is provably inside the read -> POST -> write-back section right
    // now. The parent must block, not exchange the same refresh token.
    let parentExchanges = 0;
    const startedAt = Date.now();
    const parentOutcome = await store.rotate({
      expectedRefreshToken: "rt-1",
      exchange: async () => {
        parentExchanges += 1;
        return { accessToken: "at-parent", refreshToken: "rt-parent", expiresAt: null };
      },
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(await childExit, 0);
    const childStatus: unknown = JSON.parse(
      await readFile(join(dir, "child-result.json"), "utf-8"),
    );
    assert.equal(childStatus, "rotated");
    assert.equal(parentExchanges, 0, "the parent must not submit a token the child is spending");
    assert.equal(parentOutcome.status, "adopted");
    assert.equal(parentOutcome.grant?.refreshToken, "rt-child");
    assert.ok(
      elapsedMs >= 300,
      `parent must have waited for the child lock, waited ${elapsedMs}ms`,
    );

    const final = await store.read();
    assert.equal(final?.refreshToken, "rt-child");
    assert.equal(final?.rotation, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
