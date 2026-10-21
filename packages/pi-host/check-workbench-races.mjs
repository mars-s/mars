// Swap races from the independent security review: a folder flipped between a real
// directory and a symlink to outside WORK, or a page flipped to a FIFO, while the host
// serves reads and saves. Runs against a real host on a temporary root for a few seconds.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHost } from "./workbench/test-host.mjs";

const SECONDS = Number(process.env.MARS_RACE_SECONDS || 3);
const flipper = `
import os, sys, time
w, out, name, mode = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
end = time.time() + float(sys.argv[5])
p = w + "/" + name
while time.time() < end:
    try:
        if mode == "link":
            os.rename(p, p + ".bak"); os.symlink(out, p); os.unlink(p); os.rename(p + ".bak", p)
        else:
            os.rename(p, p + ".r"); os.mkfifo(p); os.unlink(p); os.rename(p + ".r", p)
    except OSError:
        pass
`;
const flip = (...args) => {
  const child = spawn("python3", ["-c", flipper, ...args, String(SECONDS + 0.5)], { stdio: "ignore" });
  return new Promise((resolve) => child.once("close", resolve));
};
const timed = (promise, ms = 4000) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve({ status: "TIMEOUT", text: "" }), ms))]);

const host = await startHost();
try {
  const outside = join(host.root, "..", "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "f.txt"), "OUTSIDE-RACE-SECRET\n");
  mkdirSync(join(host.work, "real"));
  writeFileSync(join(host.work, "real", "f.txt"), "inside\n");

  // 1) File reads never return a file from outside WORK.
  let reads = 0;
  let leaks = 0;
  const filesDone = flip(host.work, outside, "real", "link");
  for (const end = Date.now() + SECONDS * 1000; Date.now() < end; reads++) {
    const reply = await timed(host.request("/api/workbench/file?path=real/f.txt"));
    assert.notEqual(reply.status, "TIMEOUT", "a read hung");
    if (reply.text.includes("OUTSIDE-RACE-SECRET")) leaks++;
  }
  await filesDone;
  assert.equal(leaks, 0, `${leaks} of ${reads} racing reads returned a file from outside the workspace`);

  // 2) Page saves never leave text outside WORK.
  const pagesOut = join(host.root, "..", "pages-outside");
  mkdirSync(pagesOut, { recursive: true });
  mkdirSync(join(host.work, "pages"), { recursive: true });
  let saves = 0;
  const pagesDone = flip(host.work, pagesOut, "pages", "link");
  for (const end = Date.now() + SECONDS * 1000; Date.now() < end; saves++)
    assert.notEqual((await timed(host.request("/api/workbench/pages", { method: "POST", body: { name: `p${saves}`, text: "PAGE-TEXT\n" } }))).status, "TIMEOUT");
  await pagesDone;
  const landed = readdirSync(pagesOut).filter((name) => statSync(join(pagesOut, name)).size > 0);
  assert.deepEqual(landed, [], `page text landed outside the workspace after ${saves} racing saves`);

  // 3) A page swapped for a FIFO never hangs a worker thread.
  writeFileSync(join(host.work, "pages", "a.md"), "# A\n");
  let hung = 0;
  let fifoReads = 0;
  const fifoDone = flip(host.work, "", "pages/a.md", "fifo");
  for (const end = Date.now() + SECONDS * 1000; Date.now() < end; fifoReads += 8) {
    const batch = await Promise.all(Array.from({ length: 8 }, () => timed(host.request("/api/workbench/pages/a"), 3000)));
    hung += batch.filter((reply) => reply.status === "TIMEOUT").length;
  }
  await fifoDone;
  assert.equal(hung, 0, `${hung} of ${fifoReads} page reads hung on a FIFO`);
  assert.equal((await timed(host.request("/api/workbench/pages/a"))).status, 200, "the host still answers afterwards");
  console.log(`PASS workbench races: ${reads} racing file reads with no outside file, ${saves} racing page saves with no text outside, ${fifoReads} page reads against a FIFO swap with none hung`);
} finally {
  await host.stop();
}
