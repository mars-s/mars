import assert from "node:assert/strict";
import test from "node:test";
import { remoteImageHost, safeImageSource } from "../lib/pi/safe-image.ts";

test("reply images load only from Mars itself or inline data", () => {
  assert.equal(safeImageSource("/api/attachments/abc"), "/api/attachments/abc");
  assert.equal(safeImageSource("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  assert.equal(safeImageSource("blob:https://x/1"), "blob:https://x/1");
  for (const bad of ["https://evil.example/c?d=SECRET", "//evil.example/x.png", "http://127.0.0.1:9/x", "data:text/html,<b>", "javascript:alert(1)", undefined])
    assert.equal(safeImageSource(bad), "", String(bad));
  assert.equal(remoteImageHost("https://evil.example/c?d=SECRET"), "evil.example");
  assert.equal(remoteImageHost("/api/x"), "");
});
