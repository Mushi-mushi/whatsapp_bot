import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type Status } from "@/lib/api";
import { AlertTriangle, Loader2, QrCode, Smartphone, Wifi, WifiOff } from "lucide-react";
import { LoadingState, QueryError } from "@/components/QueryFeedback";

const STATE_LABEL: Record<string, { text: string; variant: "success" | "muted" | "destructive" | "default" | "warning" }> = {
  open: { text: "Connected", variant: "success" },
  connecting: { text: "Connecting", variant: "default" },
  qr: { text: "Scan QR", variant: "default" },
  pairing: { text: "Pairing", variant: "default" },
  close: { text: "Disconnected", variant: "destructive" },
};

export function StatusCard({ status }: { status: Status | null }) {
  const queryClient = useQueryClient();
  const siesta = useQuery({
    queryKey: ["siesta"],
    queryFn: api.getSiesta,
    refetchInterval: 5000,
  });
  const cancelSiesta = useMutation({
    mutationFn: api.cancelSiesta,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["siesta"] }),
  });
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [relinking, setRelinking] = useState(false);
  const [error, setError] = useState("");

  const state = status?.state ?? "connecting";
  const stale = state === "open" && status?.health === "stale";
  const label = stale
    ? { text: "Needs re-link", variant: "warning" as const }
    : STATE_LABEL[state] ?? STATE_LABEL.connecting;

  async function requestPairing() {
    if (!phone.trim()) return;
    setLoading(true);
    setError("");
    try {
      const res = await api.requestPairing(phone.trim());
      setCode(res.code ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pairing request failed.");
    } finally {
      setLoading(false);
    }
  }

  async function relink() {
    if (!window.confirm(
      "Re-link the WhatsApp device? This logs out the current session and shows a new QR code / pairing code to scan.",
    )) return;
    setRelinking(true);
    setError("");
    try {
      await api.relink();
      setCode(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Re-link failed.");
    } finally {
      setRelinking(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          {state === "open" && !stale ? <Wifi className="h-4 w-4 text-emerald-400" /> : <WifiOff className="h-4 w-4" />}
          Connection
        </CardTitle>
        <Badge variant={label.variant}>{label.text}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {status?.me && <p className="text-sm text-muted-foreground">Linked as {status.me}</p>}

        {siesta.data?.sleeping && (
          <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="text-sm text-amber-300">Bot siesta is active. Pet commands remain available.</p>
            <p className="text-xs text-muted-foreground">Cancelling queues a Root override announcement in the chat where the siesta started.</p>
            <Button
              variant="outline"
              onClick={() => cancelSiesta.mutate()}
              disabled={cancelSiesta.isPending}
            >
              {cancelSiesta.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Cancel siesta
            </Button>
          </div>
        )}
        {siesta.isPending && <LoadingState>Loading siesta status...</LoadingState>}
        {siesta.error && <QueryError message={`Siesta status unavailable: ${siesta.error.message}`} onRetry={() => void siesta.refetch()} retrying={siesta.isFetching} retryLabel="Retry siesta status" />}
        {cancelSiesta.error && <p role="alert" className="text-sm text-destructive">Could not cancel siesta: {cancelSiesta.error.message}</p>}
        {cancelSiesta.isSuccess && <p role="status" className="text-sm text-muted-foreground">
          {cancelSiesta.data.cancelled ? "Siesta cancelled. Root override announcement queued." : "No active siesta to cancel."}
        </p>}

        {state === "open" && !stale && (
          <p className="text-sm text-emerald-400">The bot is online and listening. 🎉</p>
        )}

        {stale && (
          <div className="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="flex items-start gap-2 text-sm text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                The link looks stale — WhatsApp may have logged this device out.
                Incoming messages aren't arriving. Re-link the device to fix it.
              </span>
            </p>
            <Button variant="destructive" onClick={relink} disabled={relinking}>
              {relinking ? <Loader2 className="h-4 w-4 animate-spin" /> : "Re-link device"}
            </Button>
          </div>
        )}

        {state === "qr" && status?.qrDataUrl && (
          <div className="flex flex-col items-center gap-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <QrCode className="h-4 w-4" /> Scan in WhatsApp → Linked devices
            </div>
            <img src={status.qrDataUrl} alt="WhatsApp QR" className="h-52 w-52 rounded-lg bg-white p-2" />
          </div>
        )}

        {(state === "pairing" || code) && (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-center">
            <p className="text-xs text-muted-foreground">Pairing code</p>
            <p className="font-mono text-2xl tracking-widest">{status?.pairingCode ?? code}</p>
          </div>
        )}

        {state !== "open" && (
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Smartphone className="h-3.5 w-3.5" /> Or link by pairing code
            </p>
            <div className="flex gap-2">
              <Input
                aria-label="Phone with country code"
                className="min-w-0"
                placeholder="Phone with country code, e.g. 34600123456"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
              <Button className="shrink-0 whitespace-nowrap" onClick={requestPairing} disabled={loading || !phone.trim()}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Get code"}
              </Button>
            </div>
          </div>
        )}

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
