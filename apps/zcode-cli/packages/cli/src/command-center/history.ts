import type { TuiPromptInput } from "@zcode/tui";
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
  // Only a bare `/login` is safe to persist. The guard used to be the shipped
  // provider catalog, which proved a known namespace and nothing else; with no
  // catalog the shape check cannot tell a namespace from a pasted api key,
  // because both are single whitespace-free tokens. Fail closed instead of
  // writing an unclassifiable `/login` argument to disk.
  return command.args.length === 0;
}
