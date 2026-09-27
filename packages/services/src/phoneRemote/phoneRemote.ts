import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * How reachable an address is from a phone. A machine can hold several at once
 * (a Tailscale address plus the home wifi one) and which one actually works
 * depends on where the phone is standing, so the UI offers all of them instead
 * of guessing one.
 */
export type PhoneRemoteReach = "tailnet" | "lan" | "routable";

export interface PhoneRemotePairing {
  /** IPv4 literal, never a hostname: the QR is read by a camera, not resolved. */
  readonly address: string;
  readonly reach: PhoneRemoteReach;
  /** Full URL including the pairing token, which is what the QR encodes. */
  readonly url: string;
}

export type PhoneRemoteState =
  /** Nothing is listening. The default: no socket exists until the user asks. */
  | { readonly status: "stopped" }
  | { readonly status: "starting" }
  | {
      readonly status: "running";
      readonly port: number;
      readonly pairings: readonly PhoneRemotePairing[];
    }
  | { readonly status: "error"; readonly message: string };

/**
 * Lets a phone browser drive this desktop window.
 *
 * The transport is the desktop's own HTTP listener on the local network. There
 * is no vendor relay, and there is no discovery: the desktop names itself and
 * the QR carries the address and a per-start token.
 */
export interface IPhoneRemoteService {
  /**
   * Starts listening if not already, and returns the resulting state. Safe to
   * call repeatedly: a second call returns the same pairings rather than
   * rotating the token out from under a phone that already scanned.
   */
  start(): Promise<PhoneRemoteState>;
  /** Stops listening and revokes the token. Idempotent. */
  stop(): Promise<void>;
  getState(): Promise<PhoneRemoteState>;
  /**
   * Task ids currently being driven over a paired phone connection. Feeds the
   * "Phone is using this task" badge in the task list.
   */
  listActiveTaskIds(): Promise<string[]>;
}

export const IPhoneRemoteService = createServiceDescriptor<IPhoneRemoteService>(
  ServiceChannels.PhoneRemote,
);
