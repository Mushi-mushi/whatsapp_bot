import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type BillingCustomer, type BillingResponse } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, LoadingState, QueryError } from "@/components/QueryFeedback";
import { CircleDollarSign, Loader2, Plus } from "lucide-react";

const MAX_CHARGE_CENTS = 1_000_000;
const euro = new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" });

function chargeCents(value: string): number | null {
  if (!value.trim()) return null;
  const amount = Number(value);
  const cents = Math.round(amount * 100);
  return Number.isFinite(amount) && amount > 0 && cents <= MAX_CHARGE_CENTS &&
    Math.abs(amount * 100 - cents) < 1e-7 ? cents : null;
}

function contactLabel(customer: BillingCustomer): string {
  return customer.phone ? `${customer.name} · ${customer.phone}` : customer.name;
}

export function BillingCard() {
  const id = useId();
  const queryClient = useQueryClient();
  const billing = useQuery({ queryKey: ["billing"], queryFn: api.getBilling, retry: false });
  const customers = billing.data?.customers ?? [];
  const [senderId, setSenderId] = useState("");
  const [amount, setAmount] = useState("");
  const [notice, setNotice] = useState("");
  const selected = customers.find((customer) => customer.senderId === senderId) ?? null;
  const cents = chargeCents(amount);

  useEffect(() => {
    if (customers.length > 0 && !customers.some((customer) => customer.senderId === senderId)) {
      setSenderId(customers[0].senderId);
    }
  }, [customers, senderId]);

  const charge = useMutation({
    mutationFn: () => api.addBillingCharge({ senderId, amountCents: cents! }),
    onSuccess: ({ customer }) => {
      queryClient.setQueryData<BillingResponse>(["billing"], (current) => current && ({
        ...current,
        sampledAt: Date.now(),
        customers: current.customers.map((entry) => entry.senderId === customer.senderId ? customer : entry),
      }));
      setNotice(`Added ${euro.format(cents! / 100)} to ${customer.name}'s fake bill.`);
      setAmount("");
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><CircleDollarSign className="h-4 w-4" /> Billing</CardTitle>
        <CardDescription>Review a contact's global fake debt and add a manual charge. No real payment is involved.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {billing.isPending && <LoadingState>Loading billing records...</LoadingState>}
        {billing.error && <QueryError message={`Billing records unavailable: ${billing.error.message}`}
          onRetry={() => void billing.refetch()} retrying={billing.isFetching} retryLabel="Retry billing" />}
        {billing.data && customers.length === 0 && <EmptyState>No saved contacts are available for billing.</EmptyState>}
        {billing.data && customers.length > 0 && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1 text-sm">
                <label htmlFor={`${id}-customer`} className="text-muted-foreground">Contact</label>
                <select id={`${id}-customer`} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={selected?.senderId ?? ""} onChange={(event) => { setSenderId(event.target.value); setNotice(""); }}>
                  {customers.map((customer) => <option key={customer.senderId} value={customer.senderId}>{contactLabel(customer)}</option>)}
                </select>
              </div>
              <div className="space-y-1 text-sm">
                <label htmlFor={`${id}-amount`} className="text-muted-foreground">Charge (EUR)</label>
                <Input id={`${id}-amount`} type="number" inputMode="decimal" min="0.01" max="10000" step="0.01"
                  value={amount} aria-invalid={amount !== "" && cents === null}
                  onChange={(event) => { setAmount(event.target.value); setNotice(""); charge.reset(); }} />
              </div>
            </div>
            {selected && (
              <div className="flex flex-wrap gap-x-6 gap-y-1 border-y py-3 text-sm">
                <p><span className="text-muted-foreground">Outstanding fake debt:</span> <strong>{euro.format(selected.debtCents / 100)}</strong></p>
                <p><span className="text-muted-foreground">Mute allowance:</span> <strong>{selected.muteAllowanceMinutes.toLocaleString()} min</strong></p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">Every EUR 1.00 of outstanding debt grants one minute of mute allowance. Manual charges are added to the global balance.</p>
            <Button type="button" disabled={!selected || cents === null || charge.isPending}
              onClick={() => { setNotice(""); charge.mutate(); }}>
              {charge.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add charge
            </Button>
            {charge.error && <p role="alert" className="text-sm text-destructive">Charge failed: {charge.error.message}</p>}
            {notice && <p role="status" className="text-sm">{notice}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}