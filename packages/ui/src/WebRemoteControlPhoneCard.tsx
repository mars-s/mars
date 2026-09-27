import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Copy, Loader2, Play, RefreshCw, ShieldCheck, Square } from "lucide-react";
import type { PhoneRemotePairing, PhoneRemoteReach } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { usePhoneRemoteService } from "@/hooks/usePhoneRemoteService.js";

const REACH_LABEL_IDS: Record<PhoneRemoteReach, string> = {
  tailnet: "webRemoteControl.phone.reach.tailnet",
  lan: "webRemoteControl.phone.reach.lan",
  routable: "webRemoteControl.phone.reach.routable",
};

function PairingQr({ pairing }: { pairing: PhoneRemotePairing }) {
  const { intl } = useZCodeIntl();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(pairing.url, { margin: 1, width: 200 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch((error: unknown) => {
        logger.error(
          "[WebRemoteControlPhoneCard] 生成手机配对二维码失败",
          error instanceof Error ? error.message : String(error),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [pairing.url]);

  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface p-3">
      {dataUrl ? (
        <img
          src={dataUrl}
          alt={intl.formatMessage(
            { id: "webRemoteControl.phone.qrAlt" },
            { address: pairing.address },
          )}
          className="size-[200px] rounded bg-white p-1"
        />
      ) : (
        <div className="flex size-[200px] items-center justify-center rounded bg-white">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
      <div className="text-center">
        <div className="font-mono text-ui-base font-medium text-foreground">{pairing.address}</div>
        <div className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: REACH_LABEL_IDS[pairing.reach] })}
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full cursor-pointer justify-center gap-1.5"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(pairing.url)
            .then(() => setCopied(true))
            .catch((error: unknown) => {
              logger.error(
                "[WebRemoteControlPhoneCard] 复制手机配对链接失败",
                error instanceof Error ? error.message : String(error),
              );
            });
        }}
      >
        <Copy className="size-3.5" />
        {copied
          ? intl.formatMessage({ id: "webRemoteControl.phone.copied" })
          : intl.formatMessage({ id: "webRemoteControl.phone.copyUrl" })}
      </Button>
    </div>
  );
}

/**
 * The QR half of the remote control panel.
 *
 * This is a direct connection: the desktop listens on this machine and the phone
 * dials it, so there is no vendor relay and no account involved. Every address
 * the machine holds gets its own labelled QR rather than one guess, because a QR
 * carrying the wrong address looks perfectly valid and simply never connects.
 */
export function WebRemoteControlPhoneCard({ active }: { active: boolean }) {
  const { intl } = useZCodeIntl();
  const { supported, state, start, stop, retry } = usePhoneRemoteService(active);

  if (!supported) {
    return (
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "webRemoteControl.phone.title" })}
        </div>
        <p className="mt-1 text-ui-base/relaxed text-foreground-subtle">
          {intl.formatMessage({ id: "webRemoteControl.phone.unavailable" })}
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "webRemoteControl.phone.title" })}
      </div>
      <p className="mb-3 text-ui-base/relaxed text-foreground-subtle">
        {intl.formatMessage({ id: "webRemoteControl.phone.description" })}
      </p>

      {state.status === "stopped" ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full cursor-pointer justify-center gap-2"
          onClick={() => void start()}
        >
          <Play className="size-3.5" />
          {intl.formatMessage({ id: "webRemoteControl.phone.start" })}
        </Button>
      ) : null}

      {state.status === "starting" ? (
        <div className="flex items-center justify-center gap-2 py-6 text-ui-base text-foreground-subtle">
          <Loader2 className="size-4 animate-spin" />
          {intl.formatMessage({ id: "webRemoteControl.phone.starting" })}
        </div>
      ) : null}

      {state.status === "error" ? (
        <div className="space-y-3">
          <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-ui-base/relaxed text-destructive">
            {state.message}
          </p>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full cursor-pointer justify-center gap-2"
            onClick={() => void retry()}
          >
            <RefreshCw className="size-3.5" />
            {intl.formatMessage({ id: "webRemoteControl.phone.retry" })}
          </Button>
        </div>
      ) : null}

      {state.status === "running" ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {state.pairings.map((pairing) => (
              <PairingQr key={pairing.url} pairing={pairing} />
            ))}
          </div>
          <div className="flex items-start gap-2 rounded-lg bg-surface p-3">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
            <p className="text-ui-base/relaxed text-foreground-subtle">
              {intl.formatMessage({ id: "webRemoteControl.phone.privacy" })}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full cursor-pointer justify-center gap-2"
            onClick={() => void stop()}
          >
            <Square className="size-3.5" />
            {intl.formatMessage({ id: "webRemoteControl.phone.stop" })}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
