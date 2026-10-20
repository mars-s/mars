import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Layered Mars configuration.
//   1. default  - defaults.json, committed and shipped to everyone.
//   2. user     - <config dir>/config.json, personal and outside the repository.
//   3. env      - MARS_* variables, highest precedence for operators.
// A broken user or env layer is reported and skipped, so the host still starts on defaults.

export const DEFAULTS_PATH = new URL("./defaults.json", import.meta.url);

const ENV_KEYS = [
  ["MARS_MODEL_CONCURRENCY", ["models", "concurrency"]],
  ["MARS_MODEL_MAX_OUTPUT_TOKENS", ["models", "maxOutputTokens"]],
];

export function userConfigDir(env = process.env) {
  if (env.MARS_CONFIG_DIR) return env.MARS_CONFIG_DIR;
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "mars");
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function mergeLayers(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] = isObject(value) && isObject(base[key]) ? mergeLayers(base[key], value) : value;
  }
  return out;
}

export function validateConfig(config) {
  if (!isObject(config)) throw Error("config must be a JSON object");
  const { concurrency, maxOutputTokens } = config.models ?? {};
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw Error("models.concurrency must be an integer from 1 to 32");
  }
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw Error("models.maxOutputTokens must be a positive integer");
  }
  return config;
}

async function readJson(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  const value = JSON.parse(text);
  if (!isObject(value)) throw Error("config must be a JSON object");
  return value;
}

function envLayer(env) {
  const layer = {};
  for (const [name, [group, key]] of ENV_KEYS) {
    if (env[name] === undefined || env[name] === "") continue;
    const value = Number(env[name]);
    if (!Number.isInteger(value)) throw Error(`${name} must be an integer`);
    layer[group] = { ...layer[group], [key]: value };
  }
  return layer;
}

export async function loadConfig({ env = process.env, defaultsPath = DEFAULTS_PATH, dir = userConfigDir(env) } = {}) {
  let config = validateConfig(await readJson(defaultsPath));
  const layers = [{ name: "default", path: String(defaultsPath), applied: true }];
  const userPath = join(dir, "config.json");
  const candidates = [
    ["user", userPath, () => readJson(userPath)],
    ["env", "environment", async () => envLayer(env)],
  ];
  for (const [name, path, read] of candidates) {
    try {
      const layer = await read();
      if (!layer || !Object.keys(layer).length) {
        layers.push({ name, path, applied: false });
        continue;
      }
      config = validateConfig(mergeLayers(config, layer));
      layers.push({ name, path, applied: true });
    } catch (error) {
      layers.push({ name, path, applied: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { config, layers };
}
