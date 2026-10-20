import type { ChatRunRequest, MarsTransport } from "./transport";

function abortError() { return new DOMException("The local response was cancelled.", "AbortError"); }

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
    function onAbort() { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(abortError()); }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function sampleReply(request: ChatRunRequest) {
  const prompt = request.messages.findLast(message => message.role === "user")?.content.toLowerCase() ?? "";
  if (/\b(hi|hello|hey)\b/.test(prompt) && prompt.length < 50) {
    return "Hi. What would you like to work on?\n\nWe can think through the Mars plan, review the example tasks, or make room for a new idea. This is a local preview, so you can explore freely without sending anything to a model.";
  }
  if (/\b(task|progress|status|working on)\b/.test(prompt)) {
    const tasks = request.context?.tasks.filter(task => task.sessionId === request.sessionId) ?? [];
    if (tasks.length) {
      return `Here’s the current example task list:\n\n${tasks.map(task => `- **${task.title}** · ${task.status.replaceAll("_", " ")} · ${task.progress}%`).join("\n")}\n\nOpen **Tasks** to inspect the steps and try the task controls. These are local sample records; they are not live jobs on your VM.`;
    }
    return "There aren’t any example tasks attached to this conversation yet.\n\nFor a first task, choose one concrete outcome and write down how you’ll know it is finished. You can use the **Tasks** panel to explore the task view.";
  }
  if (/\b(memory|remember|context)\b/.test(prompt)) {
    return "For Mars, I’d keep three kinds of context close at hand:\n\n- **The project brief:** what you’re trying to achieve and the boundaries you’ve chosen.\n- **Decisions:** what changed, why, and the source of the decision.\n- **Open work:** tasks, dependencies, and anything waiting for your input.\n\nThe conversation can stay natural while these records remain inspectable. Open **Context** to see the example brief.";
  }
  if (/\b(code|component|typescript|adapter|transport|connect|endpoint|api)\b/.test(prompt)) {
    return "The UI already has a small transport boundary. Your VM adapter can implement it without replacing the conversation components.\n\n```ts\ninterface MarsTransport {\n  readonly mode: \"demo\" | \"remote\";\n  stream(\n    request: ChatRunRequest,\n    signal: AbortSignal,\n  ): AsyncIterable<MarsRunEvent>;\n}\n```\n\nMap it to your server’s real authentication, conversation state, streaming events, and cancellation commands. This interface belongs to the workspace; it is not a native Pi endpoint.\n\nFor now, this reply is generated locally from a sample template.";
  }
  if (/\b(pi|durable|restart|milestone|plan|mars|build)\b/.test(prompt)) {
    return "I’d make the first milestone deliberately small: **one conversation that you can leave and come back to.**\n\n1. Connect the workspace to the agent process on your VM.\n2. Send a message and stream the response into this conversation.\n3. Start one task that pauses for your input.\n4. Restart the process, reconnect, and inspect the restored state.\n\nThat gives you a useful foundation for memory, routines, and independent background work. The **Context** and **Tasks** panels show how that flow could feel.\n\n*This is a local sample response. The Pi runtime is not connected yet.*";
  }
  return "Here’s a useful place to start:\n\n- Describe the outcome in one sentence.\n- Pick the smallest step that moves it forward.\n- Decide what needs your input before work continues.\n\nYou can keep the conversation here and open **Context** or **Tasks** when you need the details.\n\n*This is a sample reply from the local demo. Connect your Pi transport to receive responses from your agent.*";
}

/** Canned, deterministic text streaming. No model, network request, or tool execution. */
export const demoTransport: MarsTransport = {
  mode: "demo",
  async *stream(request, signal) {
    if (signal.aborted) throw abortError();
    await wait(420, signal);
    const text = sampleReply(request);
    const chunks = text.match(/.{1,14}(?:\s|$)|.{1,14}/gs) ?? [text];
    for (const delta of chunks) {
      await wait(24, signal);
      yield { type: "text-delta", delta };
    }
    if (signal.aborted) throw abortError();
    yield { type: "complete" };
  },
};
