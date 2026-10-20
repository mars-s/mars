import assert from "node:assert/strict";
import test from "node:test";
import { developmentHostnames } from "../lib/server/dev-origin.ts";

test("development assets allow only the explicitly configured proxy hostname", () => {
  assert.deepEqual(developmentHostnames(undefined), []);
  assert.deepEqual(developmentHostnames("https://private.example:9443"), ["private.example"]);
  assert.deepEqual(developmentHostnames("http://127.0.0.1:3081/"), ["127.0.0.1"]);
  for (const origin of ["https://*.example", "https://user:secret@example", "https://example/path", "https://example?query=1", "https://example#fragment", "file:///tmp"]) {
    assert.throws(() => developmentHostnames(origin));
  }
});
