import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import type { ProviderConfig } from "./protocol.js";

const EnvConfigSchema = Schema.Struct({
  port: Schema.Number,
  host: Schema.String,
  workspace: Schema.String,
  dataDir: Schema.String,
});

export interface GatewayConfig {
  port: number;
  host: string;
  workspace: string;
  dataDir: string;
  provider: ProviderConfig;
}

export function loadGatewayConfig() {
  return Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknown(EnvConfigSchema)({
      port: Number(process.env.MARS_GATEWAY_PORT ?? 3037),
      host: process.env.MARS_GATEWAY_HOST?.trim() || "127.0.0.1",
      workspace: process.env.MARS_WORKSPACE?.trim() || process.cwd(),
      dataDir: process.env.MARS_DATA_DIR?.trim() || join(homedir(), ".mars"),
    });

    return {
      ...decoded,
      provider: {
        baseUrl: process.env.MARS_MODEL_BASE_URL?.trim() || "https://opencode.ai/zen/go/v1",
        modelId: process.env.MARS_MODEL_ID?.trim() || "gpt-5.6-luna",
        apiKey: process.env.MARS_API_KEY?.trim() || undefined,
      },
    } satisfies GatewayConfig;
  });
}
