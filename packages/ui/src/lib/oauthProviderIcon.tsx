import { LogInIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";

/**
 * Generic OAuth provider icon.
 *
 * The Z.ai / BigModel per-provider icon table is gone with those OAuth providers, and no
 * replacement vendor is registered here, so every provider renders the neutral login glyph.
 * The `provider` argument is kept because this file backs the `@zcode/ui/oauth-provider-icon`
 * entry point, which is consumed from outside this package.
 */
export function renderOAuthProviderIcon(_provider: string, className?: string) {
  return <LogInIcon className={cn("shrink-0", className)} />;
}
