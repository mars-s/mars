const $ = (s) => document.querySelector(s);
let state,
  lastMessages = "",
  authKey = "",
  pluginKey = "",
  previouslyConnected = false,
  pollBusy = false,
  disconnected = false;
async function api(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Request failed");
  return data;
}
function notice(text) {
  $("#notice").textContent = text || "";
}
function node(tag, text, cls) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
function text(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
// A native view update replaces transcript nodes. Keep open tool details by durable IDs.
function renderMessages(view) {
  const entries = view.entries || [];
  const key = JSON.stringify(entries);
  if (key === lastMessages) return;
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 180;
  lastMessages = key;
  const target = $("#messages");
  if (
    !entries.some(
      (e) =>
        Array.isArray(e.model) && e.model.some((m) => m.role === "user" || m.role === "assistant"),
    )
  )
    return;
  const openKeys = new Set(
    [...target.querySelectorAll("details[open][data-key]")].map((e) => e.dataset.key),
  );
  target.replaceChildren();
  for (const entry of entries) {
    for (const message of entry.model || []) {
      if (message.role === "system" || message.role === "developer") continue;
      if (message.role === "toolResult" || message.role === "tool") {
        const detail = node("details", undefined, "message tool");
        detail.dataset.key = "result:" + entry.id;
        detail.open = openKeys.has(detail.dataset.key);
        detail.append(
          node("summary", message.toolName || message.name || "Tool result"),
          node("pre", text(message.content)),
        );
        target.append(detail);
        continue;
      }
      const value = text(message.content);
      if (value) {
        const item = node("article", undefined, "message " + message.role);
        item.append(
          node("span", message.role === "user" ? "You" : "Pi", "role"),
          node("div", value),
        );
        target.append(item);
      }
      for (const call of (Array.isArray(message.content) ? message.content : []).filter(
        (c) => c.type === "toolCall" || c.type === "tool-call",
      )) {
        const detail = node("details", undefined, "message tool");
        detail.dataset.key = "call:" + call.id;
        detail.open = openKeys.has(detail.dataset.key);
        detail.append(
          node("summary", call.name),
          node("pre", JSON.stringify(call.arguments, null, 2)),
        );
        target.append(detail);
      }
    }
  }
  if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
}
function renderAuth(auth) {
  $("#auth-status").textContent = auth.connected
    ? "ChatGPT connected"
    : auth.state === "pending"
      ? "Waiting for ChatGPT sign-in"
      : auth.error || "ChatGPT is not connected";
  $("#login").textContent =
    auth.state === "pending"
      ? "Sign-in in progress…"
      : auth.connected
        ? "Reconnect ChatGPT"
        : "Sign in with ChatGPT";
  $("#login").disabled = auth.state === "pending";
  $("#trial").disabled = !auth.connected;
  const key = JSON.stringify({ events: auth.events, prompt: auth.prompt, state: auth.state });
  if (key === authKey) return;
  authKey = key;
  const flow = $("#auth-flow");
  flow.replaceChildren();
  if (auth.state === "pending") {
    const event = auth.events.findLast((e) => e.type === "auth_url" || e.type === "device_code");
    if (event) {
      const link = node("a", "Open ChatGPT sign-in");
      link.href = event.url || event.verificationUri;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      flow.append(node("p", "Complete sign-in in your browser."), link);
      if (event.userCode) flow.append(node("p", event.userCode));
    }
    if (auth.prompt) {
      flow.append(
        node(
          "p",
          "If the browser ends at a localhost address that will not load on your Mac, copy that entire address and paste it below. The provider checks its sign-in state.",
        ),
      );
      const form = node("form");
      const input = node("input");
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = auth.prompt.placeholder || "Final callback URL";
      input.setAttribute("aria-label", "ChatGPT final callback URL");
      const submit = node("button", "Complete sign-in");
      submit.type = "submit";
      form.append(input, submit);
      form.onsubmit = async (e) => {
        e.preventDefault();
        try {
          submit.disabled = true;
          await api("/api/login-answer", { answer: input.value });
          input.value = "";
        } catch (error) {
          notice(error.message);
          submit.disabled = false;
        }
      };
      flow.append(form);
    }
  }
  if (auth.connected && !previouslyConnected) {
    $("#settings").open = false;
    notice("ChatGPT connected. You can chat or run the comparison test.");
  }
  previouslyConnected = auth.connected;
}
async function renderPlugins(rows) {
  const key = JSON.stringify(rows.map((r) => r.hash));
  if (key === pluginKey) return;
  pluginKey = key;
  $("#plugins").replaceChildren();
  for (const row of rows) {
    const region = node("section", undefined, "extension");
    region.setAttribute("aria-label", row.title);
    const content = node("div", undefined, "extension-body");
    region.append(content);
    $("#plugins").append(region);
    try {
      const module = await import("/extensions/" + row.hash + "/client.js");
      if (typeof module.mount !== "function") throw Error("Installed UI must export mount(root)");
      module.mount(content);
    } catch (error) {
      content.append(node("p", "Plugin UI failed: " + error.message));
      notice("An installed extension UI failed to load.");
    }
  }
}
async function refresh() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    state = await api("/api/state");
    if (disconnected) {
      notice("Reconnected.");
      disconnected = false;
    }
    renderMessages(state.view);
    renderAuth(state.auth);
    $("#evaluation-status").textContent =
      state.evaluation?.message || state.evaluation?.phase || "Waiting for ChatGPT sign-in.";
    if (!$("#model").options.length) {
      for (const m of state.models) {
        const option = node("option", m.name || m.id);
        option.value = m.id;
        $("#model").append(option);
      }
    }
    const selected = state.view.docs["pi.agent"]?.model?.modelId;
    if (selected) $("#model").value = selected;
    const live = state.view.docs["pi.live"];
    const running = !!live?.run;
    $("#runtime-status").textContent = (selected || "Pi Durable") + (running ? " · Working" : "");
    $("#stop").hidden = !running;
    $("#send").disabled = !state.auth.connected;
    $("#message").disabled = !state.auth.connected;
    await renderPlugins(state.extensions);
    const partial = text(live?.generation?.message?.content);
    const activeTools = (live?.tools || [])
      .filter((t) => t.status !== "done")
      .map((t) => t.name)
      .join(", ");
    $("#stream").textContent =
      partial || (activeTools ? "Running: " + activeTools : running ? "Working…" : "");
  } catch (error) {
    disconnected = true;
    notice(error.message + " Retrying…");
  } finally {
    pollBusy = false;
  }
}
$("#login").onclick = async () => {
  try {
    notice("");
    await api("/api/login", {});
    await refresh();
  } catch (e) {
    notice(e.message);
  }
};
$("#trial").onclick = async () => {
  try {
    notice("");
    await api("/api/trial", {});
    $("#settings").open = false;
    await refresh();
  } catch (e) {
    notice(e.message);
  }
};
$("#model").onchange = async () => {
  try {
    await api("/api/model", { model: $("#model").value });
  } catch (e) {
    notice(e.message);
  }
};
$("#stop").onclick = async () => {
  try {
    await api("/api/abort", {});
    await refresh();
  } catch (e) {
    notice(e.message);
  }
};
$("#composer").onsubmit = async (e) => {
  e.preventDefault();
  const value = $("#message").value;
  if (!value.trim()) return;
  try {
    notice("");
    await api("/api/chat", { text: value, requestId: crypto.randomUUID() });
    $("#message").value = "";
    await refresh();
  } catch (error) {
    notice(error.message);
  }
};
// IME Enter confirms a composed character and must not submit the draft.
$("#message").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
};
await refresh();
setInterval(refresh, 1200);
