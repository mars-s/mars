import { execFile } from "node:child_process";
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { relative, resolve, dirname } from "node:path";
import { promisify } from "node:util";
import { tool } from "@strands-agents/sdk";
import { z } from "zod";

const execFileAsync = promisify(execFile);

function safePath(workspace: string, input: string): string {
  const target = resolve(workspace, input);
  const rel = relative(resolve(workspace), target);
  if (rel.startsWith("..") || rel === "..") {
    throw new Error("Path escapes the active Mars workspace");
  }
  return target;
}

export function createWorkspaceTools(workspace: string) {
  const readFileTool = tool({
    name: "read_file",
    description: "Read a UTF-8 text file inside the active workspace.",
    inputSchema: z.object({ path: z.string().min(1) }),
    callback: async ({ path }) => {
      const target = safePath(workspace, path);
      const content = await readFile(target, "utf8");
      return content.slice(0, 200_000);
    },
  });

  const writeFileTool = tool({
    name: "write_file",
    description: "Create or replace a UTF-8 text file inside the active workspace.",
    inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
    callback: async ({ path, content }) => {
      const target = safePath(workspace, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return { ok: true, path };
    },
  });

  const listFilesTool = tool({
    name: "list_files",
    description: "List files and directories inside the active workspace.",
    inputSchema: z.object({ path: z.string().default("."), limit: z.number().int().min(1).max(500).default(200) }),
    callback: async ({ path, limit }) => {
      const start = safePath(workspace, path);
      const out: Array<{ path: string; type: "file" | "directory" }> = [];
      const queue = [start];
      while (queue.length > 0 && out.length < limit) {
        const current = queue.shift()!;
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries) {
          if (out.length >= limit) break;
          if (entry.name === ".git" || entry.name === "node_modules") continue;
          const absolute = resolve(current, entry.name);
          const rel = relative(workspace, absolute) || ".";
          out.push({ path: rel, type: entry.isDirectory() ? "directory" : "file" });
          if (entry.isDirectory()) queue.push(absolute);
        }
      }
      return out;
    },
  });

  const runCommandTool = tool({
    name: "run_command",
    description: "Run a shell command inside the active workspace and return bounded stdout/stderr.",
    inputSchema: z.object({ command: z.string().min(1), timeoutMs: z.number().int().min(1000).max(120000).default(30000) }),
    callback: async ({ command, timeoutMs }) => {
      const result = await execFileAsync("/bin/bash", ["-lc", command], {
        cwd: workspace,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
      return {
        stdout: result.stdout.slice(-200_000),
        stderr: result.stderr.slice(-100_000),
      };
    },
  });

  return [readFileTool, writeFileTool, listFilesTool, runCommandTool];
}
