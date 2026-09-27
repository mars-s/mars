import { createHttpServer } from "@zcode/server";
import type { ServiceCollection } from "@zcode/services";
import type { AddressInfo } from "node:net";
import {
  buildPhoneRemoteUrl,
  createPhoneRemoteToken,
  resolvePhoneRemoteCandidates,
  type PhoneRemoteCandidate,
} from "./phoneRemoteNetwork.js";

export interface PhoneRemotePairing {
  readonly address: string;
  readonly reach: "tailnet" | "lan" | "routable";
  readonly url: string;
}

export interface PhoneRemoteServerHandle {
  /** The best pairing URL, for callers that only render one QR. */
  readonly url: string;
  /**
   * Every pairing URL, best first. A machine with both a tailnet and a wifi
   * address should offer both, because which one works depends on where the
   * phone is standing, and that is not something the desktop can know.
   */
  readonly pairings: readonly PhoneRemotePairing[];
  readonly port: number;
  readonly host: string;
  /** Invalidates the pairing and stops accepting phone connections. */
  dispose(): Promise<void>;
}

export interface StartPhoneRemoteServerOptions {
  readonly services: ServiceCollection;
  readonly staticRoot: string;
  readonly log?: (message: string) => void;
  /** Test seam. Defaults to the real interfaces on this machine. */
  readonly resolveCandidates?: () => PhoneRemoteCandidate[];
  /** Test seam. Defaults to port 0 so a second window can never collide. */
  readonly port?: number;
}

/**
 * Serves this host's services to a phone browser on the local network.
 *
 * The phone never reaches the desktop over the vendor, and there is no
 * peer-to-peer discovery: the desktop names itself and the QR carries the
 * address. The WebSocket a phone ends up on is the same `/ws` the bundled web
 * client already speaks, and it already exposes the whole v4 surface, so this
 * adds a listener and a token rather than a new protocol.
 */
export async function startPhoneRemoteServer(
  options: StartPhoneRemoteServerOptions,
): Promise<PhoneRemoteServerHandle> {
  const candidates = (options.resolveCandidates ?? resolvePhoneRemoteCandidates)();
  if (candidates.length === 0) {
    throw new Error(
      "Phone remote control needs a reachable network address, and this machine has none. Connect to a network and try again.",
    );
  }

  const token = createPhoneRemoteToken();
  const server = createHttpServer(options.services, options.port ?? 0, {
    host: "0.0.0.0",
    authToken: token,
    authRequired: true,
    staticRoot: options.staticRoot,
    spaFallback: true,
    name: "phone-remote",
  });

  const port = await resolveListeningPort(server);
  const pairings: PhoneRemotePairing[] = candidates.map((candidate) => ({
    address: candidate.address,
    reach: candidate.reach,
    url: buildPhoneRemoteUrl({ host: candidate.address, port, token }),
  }));
  const [primary] = pairings;
  if (!primary) {
    throw new Error("Phone remote control produced no pairing URL.");
  }
  options.log?.(
    `phone remote control listening on port ${port} for ${pairings.length} address(es): ${pairings
      .map((pairing) => `${pairing.address} (${pairing.reach})`)
      .join(", ")}`,
  );

  let disposed = false;
  return {
    url: primary.url,
    pairings,
    port,
    host: primary.address,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/**
 * `serve()` starts listening asynchronously, so the ephemeral port is not
 * readable until the socket is actually up. Resolving early would hand the
 * phone a port of 0.
 */
function resolveListeningPort(server: { address(): AddressInfo | string | null }): Promise<number> {
  const current = listeningPort(server);
  if (current !== null) return Promise.resolve(current);
  return new Promise<number>((resolve, reject) => {
    (server as { once?: (event: string, fn: () => void) => void }).once?.("listening", () => {
      const port = listeningPort(server);
      if (port === null) {
        reject(new Error("Phone remote control started without a listening port."));
      } else {
        resolve(port);
      }
    });
  });
}

function listeningPort(server: { address(): AddressInfo | string | null }): number | null {
  const address = server.address();
  return address && typeof address !== "string" ? address.port : null;
}
