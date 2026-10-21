import assert from "node:assert/strict";
import test from "node:test";
import { parseConversations, parseSnapshot } from "../lib/pi/live-state.ts";

test("Claude connection and model namespace stay distinct without projecting credentials", () => {
  const source = snapshot([]);
  source.anthropicAuth = {
    connected: true,
    state: "connected",
    events: [],
    accessToken: "fixture-secret",
  };
  source.providerReady = true;
  source.view.docs["pi.agent"].model = {
    provider: "anthropic",
    modelId: "claude-opus-5-5",
  };
  const state = parseSnapshot(source);
  assert.equal(state.auth.connected, false);
  assert.equal(state.anthropicAuth.connected, true);
  assert.equal(state.model, "anthropic/claude-opus-5-5");
  assert.equal(state.providerReady, true);
  assert.ok(!JSON.stringify(state).includes("fixture-secret"));
  assert.equal(parseSnapshot(snapshot([])).anthropicAuth.connected, false);
});

function snapshot(entries, live = {}) {
  return {
    runtime: "Pi Durable 1.3.0",
    conversationId: 1,
    auth: { connected: false, state: "idle", events: [] },
    models: [{ id: "gpt-6-luna", name: "Luna" }],
    extensions: [],
    view: {
      entries,
      docs: {
        "pi.agent": { model: { modelId: "gpt-6-luna" } },
        "pi.live": live,
      },
    },
  };
}
test("native tool results attach to their durable call without creating duplicate messages", () => {
  const state = parseSnapshot(
    snapshot([
      { id: 1, model: [{ role: "user", content: "Read a file" }] },
      {
        id: 2,
        model: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "read",
                arguments: { path: "README.md" },
              },
            ],
          },
        ],
      },
      {
        id: 3,
        model: [
          {
            role: "toolResult",
            toolCallId: "call-1",
            content: [{ type: "text", text: "Real file content" }],
          },
        ],
      },
    ]),
  );
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[1].tools[0].output, "Real file content");
  assert.equal(state.messages[1].id, "2:0");
  assert.equal(state.running, false);
});
test("stale compaction metadata does not imply an active run, partial generation requires run owner", () => {
  assert.equal(parseSnapshot(snapshot([], { compactions: [{ taskId: 4 }] })).running, false);
  const state = parseSnapshot(
    snapshot([], {
      run: { taskId: 5 },
      generation: { message: { content: [{ type: "text", text: "Partial" }] } },
    }),
  );
  assert.equal(state.running, true);
  assert.equal(state.messages[0].running, true);
  assert.equal(state.messages[0].text, "Partial");
});
test("boundary rejects malformed snapshots and unsafe login URLs or module hashes", () => {
  assert.throws(
    () =>
      parseSnapshot({
        runtime: "Pi",
        view: { entries: [] },
        auth: { connected: "yes" },
      }),
    /unsupported snapshot/,
  );
  const source = snapshot([]);
  source.auth.events = [{ type: "auth_url", url: "javascript:alert(1)" }];
  source.extensions = [{ name: "escape", hash: "../escape" }];
  const state = parseSnapshot(source);
  assert.equal(state.auth.url, "");
  assert.deepEqual(state.extensions, []);
});

test("native provider error and cancellation remain visible terminal failures", () => {
  const state = parseSnapshot(
    snapshot([
      {
        id: 10,
        model: [
          {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "Provider unavailable",
          },
        ],
      },
      {
        id: 11,
        model: [{ role: "assistant", content: [], stopReason: "aborted" }],
      },
    ]),
  );
  assert.equal(state.messages[0].outcome, "error");
  assert.equal(state.messages[0].text, "Provider unavailable");
  assert.equal(state.messages[1].outcome, "cancelled");
});

test("conversation and worker metadata is optional and rejects malformed IDs", () => {
  const source = snapshot([]);
  source.selectedConversationId = 2;
  source.conversations = [
    { id: 1, title: "First", running: true },
    { id: "2", title: "Second", modelId: "gpt-6-sol", provider: "openai" },
    { id: "../escape", title: "Invalid" },
  ];
  source.workers = [
    {
      id: 31,
      conversationId: 2,
      modelId: "gpt-6-sol",
      status: "running",
      task: "Compare notes",
    },
    {
      id: 32,
      conversationId: 2,
      status: "completed",
      result: { answer: "Done" },
    },
    { id: 33, conversationId: "invalid", status: "running" },
  ];
  source.usage = {
    models: {
      "openai/gpt-6-sol": {
        input: 100,
        output: 12,
        totalTokens: 112,
        cost: { total: 0.1 },
      },
      "openai/gpt-6-luna": { input: 40, output: 8, totalTokens: 48 },
      invalid: { input: -1, output: "invented" },
    },
    tools: {},
  };
  const state = parseSnapshot(source);
  assert.equal(state.conversationId, "2");
  assert.deepEqual(
    state.conversations.map((row) => row.id),
    ["1", "2"],
  );
  assert.equal(state.conversations[0].running, true);
  assert.equal(state.workers.length, 2);
  assert.equal(state.workers[1].result, '{\n  "answer": "Done"\n}');
  assert.deepEqual(state.usage, [
    { label: "Input tokens", value: 140 },
    { label: "Output tokens", value: 20 },
    { label: "Total tokens", value: 160 },
  ]);
  assert.ok(!JSON.stringify(state.usage).includes("cost"));
  const oldHost = parseSnapshot(snapshot([]));
  assert.deepEqual(oldHost.conversations, []);
  assert.deepEqual(oldHost.workers, []);
  assert.deepEqual(oldHost.usage, []);
});

test("new conversation acknowledgement requires a native conversation ID", async () => {
  const { parseCreatedConversation } = await import("../lib/pi/live-state.ts");
  assert.equal(parseCreatedConversation({ conversation: { id: 42, title: "New work" } }).id, "42");
  assert.throws(() => parseCreatedConversation({ accepted: true }), /did not confirm/);
});

test("private image receipts survive native history without model image bytes", () => {
  const id = "a".repeat(64);
  const receipt = {
    id,
    name: "sample.png",
    mimeType: "image/webp",
    size: 100,
    width: 50,
    height: 50,
    url: `/api/attachments/${id}`,
  };
  const state = parseSnapshot(
    snapshot([
      {
        id: 1,
        data: { attachments: [receipt] },
        model: [
          {
            role: "user",
            content: [
              {
                type: "image",
                data: "secret-image-base64",
                mimeType: "image/webp",
              },
            ],
          },
        ],
      },
    ]),
  );
  assert.deepEqual(state.messages[0].images, [receipt]);
  assert.equal(state.messages[0].text, "");
  assert.ok(!JSON.stringify(state).includes("secret-image-base64"));
});

test("child ownership and ordered workflow phases stay separate from workers", () => {
  const source = snapshot([]);
  source.parentConversationId = 1;
  source.conversationTitle = "Inspect image";
  source.subthreads = [{ id: 2, conversationId: 1, title: "Inspect image", status: "running" }];
  source.workflows = [
    {
      id: "flow-1",
      conversationId: 1,
      title: "Map, pick, explain",
      status: "running",
      currentStep: 1,
      steps: [
        {
          index: 0,
          title: "Map",
          status: "complete",
          conversationId: 2,
          durationMs: 1200,
          usage: { models: { "openai/Luna": { input: 20, output: 10 } } },
        },
        { index: 1, title: "Pick", status: "running", conversationId: 3 },
      ],
    },
  ];
  const state = parseSnapshot(source);
  assert.equal(state.parentConversationId, "1");
  assert.equal(state.subthreads[0].title, "Inspect image");
  assert.deepEqual(
    state.workflows[0].steps.map((step) => step.title),
    ["Map", "Pick"],
  );
  assert.equal(state.workflows[0].steps[0].usage[0].value, 20);
  assert.deepEqual(state.workers, []);
});

test("codemode history and live nested calls retain real action outcomes", () => {
  const source = snapshot(
    [
      {
        id: 1,
        model: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "code-1",
                name: "codemode",
                arguments: { code: "await tools.host_read({path:'file.txt'})" },
              },
            ],
          },
        ],
      },
      {
        id: 2,
        model: [
          {
            role: "toolResult",
            toolCallId: "code-1",
            isError: false,
            content: [{ type: "text", text: "Done" }],
            details: {
              calls: [
                {
                  id: 1,
                  name: "host_read",
                  args: '{"path":"file.txt"}',
                  status: "ok",
                  durationMs: 12,
                },
                {
                  id: 2,
                  name: "host_exec",
                  args: '{"command":"false"}',
                  status: "error",
                  error: "Failed",
                  durationMs: 20,
                },
              ],
            },
          },
        ],
      },
    ],
    {
      run: { taskId: 2 },
      nestedTools: [
        {
          callId: "live/c1",
          parentCallId: "live",
          name: "host_write",
          status: "running",
          arguments: { path: "next.txt" },
        },
      ],
    },
  );
  const state = parseSnapshot(source);
  assert.deepEqual(
    state.messages[0].tools[0].children.map((call) => call.state),
    ["complete", "failed"],
  );
  assert.equal(state.messages[0].tools[0].children[1].output, "Failed");
  assert.equal(state.messages[1].tools[0].name, "host_write");
  assert.equal(state.messages[1].tools[0].state, "running");
});

test("context usage passes through Pi numbers and never invents a window", () => {
  const missing = parseSnapshot(snapshot([]));
  assert.deepEqual(missing.context, { basis: "unavailable" });
  const source = snapshot([]);
  source.context = {
    basis: "reported",
    limit: 200000,
    used: 52000,
    compactAt: 0.918,
    autoCompact: true,
    segments: [
      { id: "instructions", label: "Instructions", tokens: 6000 },
      { id: "messages", label: "Messages", tokens: 46000 },
    ],
  };
  const state = parseSnapshot(source);
  assert.equal(state.context.basis, "reported");
  assert.equal(state.context.used, 52000);
  assert.equal(state.context.segments.length, 2);
  source.context = { basis: "reported", limit: 0, used: 10 };
  assert.deepEqual(parseSnapshot(source).context, { basis: "unavailable" });
});

test("models carry provider and Pi effort levels in order; unknown levels are dropped", () => {
  const source = snapshot([]);
  source.models = [
    { id: "gpt-6-sol", name: "Sol", provider: "openai", efforts: ["high", "off", "low", "bogus"] },
    { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5" },
  ];
  source.thinkingLevel = "low";
  const state = parseSnapshot(source);
  assert.deepEqual(state.models[0].efforts, ["off", "low", "high"]);
  assert.equal(state.models[1].provider, "anthropic");
  assert.deepEqual(state.models[1].efforts, []);
  assert.equal(state.thinkingLevel, "low");
});

test("conversation rows carry nested side chats, and a side chat's state names its parent", () => {
  const rows = parseConversations([
    { id: "1", title: "Parent", sideChats: [{ id: "8", title: "Names", running: true }, { id: "bad" }, { id: "9" }] },
    { id: "2", title: "Plain" },
  ]);
  assert.deepEqual(rows[0].sideChats, [
    { id: "8", title: "Names", running: true },
    { id: "9", title: "Side chat", running: false },
  ]);
  assert.deepEqual(rows[1].sideChats, [], "rows without side chats get an empty list");
});

test("a side chat snapshot keeps its parent for sidebar nesting", () => {
  const snapshot = parseSnapshot({
    runtime: "Pi Durable 1.3.0",
    conversationId: "8",
    parentConversationId: "1",
    sideChatOf: "1",
    auth: { connected: true },
    view: { entries: [] },
  });
  assert.equal(snapshot.sideChatOf, "1");
  assert.equal(snapshot.parentConversationId, "1");
  assert.equal(parseSnapshot({ runtime: "x", conversationId: "1", auth: { connected: true }, view: { entries: [] } }).sideChatOf, "");
});
