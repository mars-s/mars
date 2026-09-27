import { useCallback, useEffect, useRef, useState } from "react";
import type { IPhoneRemoteService, PhoneRemoteState } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

/**
 * Drives the "phone remote control" panel.
 *
 * The desktop opens its listener lazily, on the first `start()`, so a machine
 * that never uses the feature never opens a port. A second `start()` returns the
 * same pairing, which matters because the phone has usually already scanned the
 * QR by the time the user reopens the panel.
 *
 * `supported` is false on hosts that do not register the service at all (remote
 * and bot hosts have no address a phone could dial), which is a normal state and
 * not an error.
 */
export function usePhoneRemoteService(enabled: boolean) {
  const services = useServices();
  const service: IPhoneRemoteService | undefined = services.phoneRemoteService;
  const supported = Boolean(service);
  const [state, setState] = useState<PhoneRemoteState>({ status: "stopped" });
  const startedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const start = useCallback(async () => {
    if (!service || startedRef.current) return;
    startedRef.current = true;
    setState({ status: "starting" });
    try {
      const next = await service.start();
      if (mountedRef.current) setState(next);
    } catch (error) {
      startedRef.current = false;
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[usePhoneRemoteService] start failed", message);
      if (mountedRef.current) setState({ status: "error", message });
    }
  }, [service]);

  const stop = useCallback(async () => {
    if (!service) return;
    try {
      await service.stop();
    } catch (error) {
      logger.error(
        "[usePhoneRemoteService] stop failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    startedRef.current = false;
    if (mountedRef.current) setState({ status: "stopped" });
  }, [service]);

  const retry = useCallback(async () => {
    startedRef.current = false;
    await start();
  }, [start]);

  useEffect(() => {
    if (enabled && supported) {
      void start();
    }
  }, [enabled, supported, start]);

  return { supported, state, start, stop, retry };
}
