import { formatJson } from "@zcode/core";
import { isCliOAuthProviderId } from "@zcode/adapters";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import { loadCliDotenv } from "./env.js";
import type { RunDependencies } from "./cli-types.js";

export async function runLoginCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  noBrowser: boolean,
  args: readonly string[] = [],
): Promise<number> {
  try {
    // The fork ships no provider catalog, so there is no in-tree allowlist of
    // sign-in namespaces to check the argument against. The operator's backend
    // owns that vocabulary and rejects an unknown namespace; the CLI only
    // enforces the shape the OAuth client can round-trip.
    const providerId = args[0];
    if (args.length > 1 || !isCliOAuthProviderId(providerId)) {
      throw new Error("Usage: zcode login <provider> [--no-browser]");
    }
    const env = deps.env ?? process.env;
    const workingDirectory = (deps.cwd ?? process.cwd)();
    const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
      cwd: workingDirectory,
      env,
    });

    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    const login = deps.loginZCodeCli ?? (await loadBootstrapModule()).loginZCodeCli;
    const result = await login({
      env,
      noBrowser,
      providerId,
      onAuthorizeUrl: (data) => {
        writeAuthorizeUrl(ctx, options, data.authorize_url, noBrowser, providerId);
      },
      onBrowserOpen: (browser) => {
        if (!options.json && !browser.opened) {
          ctx.stdout.write(`Browser open failed: ${browser.reason ?? "unknown error"}\n`);
        }
      },
    });

    if (options.json) {
      ctx.stdout.write(
        formatJson({
          status: "ready",
          provider: result.providerId,
          user: {
            user_id: result.user.user_id,
            ...(result.user.email ? { email: result.user.email } : {}),
            ...(result.user.name ? { name: result.user.name } : {}),
            ...(result.user.avatar ? { avatar: result.user.avatar } : {}),
          },
          credentialsPath: result.credentialsPath,
          browserOpened: result.browser?.opened ?? false,
        }),
      );
      return 0;
    }

    ctx.stdout.write(
      [
        `Login successful${formatUserLabel(result.user)}.`,
        `Credentials: ${result.credentialsPath}`,
      ].join("\n") + "\n",
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
}

export async function runLogoutCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
): Promise<number> {
  try {
    const env = deps.env ?? process.env;
    const workingDirectory = (deps.cwd ?? process.cwd)();
    const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
      cwd: workingDirectory,
      env,
    });

    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    const logout = deps.logoutZCodeCli ?? (await loadBootstrapModule()).logoutZCodeCli;
    const result = await logout({ env });

    if (options.json) {
      ctx.stdout.write(
        formatJson({
          status: "logged_out",
          credentialsPath: result.credentialsPath,
        }),
      );
      return 0;
    }

    ctx.stdout.write(`Logged out. Credentials: ${result.credentialsPath}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
}

function writeAuthorizeUrl(
  ctx: RunContext,
  options: GlobalOptions,
  authorizeUrl: string,
  noBrowser: boolean,
  providerId: string,
): void {
  const target = options.json ? ctx.stderr : ctx.stdout;
  if (noBrowser) {
    target.write(`Open this URL to sign in:\n${authorizeUrl}\n`);
    return;
  }

  target.write(
    `Opening browser for ${providerId} authorization.\nFallback URL:\n${authorizeUrl}\n`,
  );
}

function formatUserLabel(user: { email?: string; name?: string; user_id: string }): string {
  const label = user.name || user.email || user.user_id;
  return label ? ` as ${label}` : "";
}
