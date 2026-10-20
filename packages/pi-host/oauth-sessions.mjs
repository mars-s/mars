const PROVIDERS = new Set(["openai", "anthropic"]);
export function oauthProvider(value = "openai") {
  if (!PROVIDERS.has(value)) throw Error("Unsupported sign-in provider");
  return value;
}
export function modelSelection(value) {
  if (typeof value !== "string") throw Error("Unknown model");
  for (const provider of ["anthropic", "opencode-go"])
    if (value.startsWith(provider + "/"))
      return { provider, modelId: value.slice(provider.length + 1) };
  return { provider: "openai", modelId: value };
}
export class OAuthSessions {
  constructor(models, { deviceId, timeoutMs = 15 * 60 * 1000 } = {}) {
    this.models = models;
    this.deviceId = deviceId;
    this.timeoutMs = timeoutMs;
    this.sessions = new Map();
  }
  state(provider) {
    return (
      this.sessions.get(oauthProvider(provider))?.state ?? {
        state: "idle",
        events: [],
        prompt: null,
      }
    );
  }
  begin(provider) {
    provider = oauthProvider(provider);
    if (this.sessions.get(provider)?.job) return;
    const session = {
      state: { state: "pending", events: [], prompt: null },
      abort: new AbortController(),
    };
    this.sessions.set(provider, session);
    const timer = setTimeout(() => session.abort.abort(), this.timeoutMs);
    session.job = Promise.resolve()
      .then(() =>
        this.models.login(
          provider,
          "oauth",
          {
            signal: session.abort.signal,
            notify: (event) => {
              session.state.events.push(event);
              if (session.state.events.length > 12) session.state.events.shift();
            },
            prompt: (prompt) => {
              // Pi offers browser and copy-code methods. The latter works from the owner's Mac.
              if (provider === "anthropic" && prompt.type === "select") {
                if (!prompt.options?.some((option) => option.id === "copy_code"))
                  throw Error("Headless Claude sign-in unavailable");
                return Promise.resolve("copy_code");
              }
              return new Promise((resolve, reject) => {
                session.state.prompt = {
                  type: prompt.type,
                  message: prompt.message,
                  placeholder: prompt.placeholder,
                };
                const signal = prompt.signal ?? session.abort.signal;
                const abort = () => reject(Error("Sign-in closed"));
                session.answer = (value) => {
                  signal.removeEventListener("abort", abort);
                  session.state.prompt = null;
                  session.answer = null;
                  resolve(value);
                };
                if (signal.aborted) abort();
                else signal.addEventListener("abort", abort, { once: true });
              });
            },
          },
          { getDeviceId: () => this.deviceId, agentName: "Mars Pi Durable" },
        ),
      )
      .then(() => {
        session.state.state = "connected";
      })
      .catch(() => {
        session.state.state = "failed";
        session.state.error =
          provider === "anthropic"
            ? "Claude sign-in did not complete. Start again and paste the code shown after authorisation."
            : "Sign-in did not complete. Start again and use the final callback URL if signing in from another computer.";
      })
      .finally(() => {
        clearTimeout(timer);
        session.state.prompt = null;
        session.answer = null;
        session.job = null;
      });
  }
  answer(provider, value) {
    provider = oauthProvider(provider);
    const session = this.sessions.get(provider);
    if (!session?.answer || typeof value !== "string" || !value.trim() || value.length > 16000)
      throw Error("No active sign-in prompt or invalid answer");
    session.answer(value.trim());
  }
  close() {
    for (const session of this.sessions.values()) session.abort.abort();
  }
}
