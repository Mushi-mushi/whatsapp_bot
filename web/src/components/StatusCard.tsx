import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useStatusStream } from "@/lib/useStatusStream";
import { Loader2, QrCode, Smartphone, Wifi, WifiOff } from "lucide-react";

const STATE_LABEL: Record<string, { text: string; variant: "success" | "muted" | "destructive" | "default" }> = {
  open: { text: "Connected", variant: "success" },
  connecting: { text: "Connecting", variant: "default" },
  qr: { text: "Scan QR", variant: "default" },
  pairing: { text: "Pairing", variant: "default" },
  close: { text: "Disconnected", variant: "destructive" },
};

export function StatusCard() {
  const status = useStatusStream();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const state = status?.state ?? "connecting";
  const label = STATE_LABEL[state] ?? STATE_LABEL.connecting;

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

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          {state === "open" ? <Wifi className="h-4 w-4 text-emerald-400" /> : <WifiOff className="h-4 w-4" />}
          Connection
        </CardTitle>
        <Badge variant={label.variant}>{label.text}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {status?.me && <p className="text-sm text-muted-foreground">Linked as {status.me}</p>}

        {state === "open" && (
          <p className="text-sm text-emerald-400">The bot is online and listening. 🎉</p>
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
                className="min-w-0"
                placeholder="Phone with country code, e.g. 34600123456"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
              <Button className="shrink-0 whitespace-nowrap" onClick={requestPairing} disabled={loading || !phone.trim()}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Get code"}
              </Button>
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
