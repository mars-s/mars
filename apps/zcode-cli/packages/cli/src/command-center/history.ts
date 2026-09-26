import type { TuiPromptInput } from "@zcode/tui";
import { loginProviderIds } from "./login-flow.js";
import type { SlashCommand } from "./slash-command-types.js";
import type { CommandCenterDeps } from "./types.js";

export async function recordSlashCommandInHistory(
  deps: CommandCenterDeps,
  input: TuiPromptInput,
  command: SlashCommand,
): Promise<void> {
  if (!deps.recordInputHistory || !shouldRecordSlashCommand(command)) return;
  try {
    await deps.recordInputHistory(input, "slash_command");
  } catch {
    // Input history is recall UX; command execution must not depend on it.
  }
}

function shouldRecordSlashCommand(command: SlashCommand): boolean {
  if (command.type !== "known") return true;
  if (command.name !== "login") return true;
  // Only a bare `/login` or one naming a known provider is safe to persist.
  // Any other argument is treated as possibly carrying a secret, so the
  // command stays out of history rather than being written to disk.
  return command.args.length === 0 || loginProviderIds().includes(command.args);
}
