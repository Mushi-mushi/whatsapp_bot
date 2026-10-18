import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PetGroup, type PetsResponse, type PetSettings, type PetUpdate, type PetRequestChoice } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, LoadingState, QueryError } from "@/components/QueryFeedback";

const FIELDS: { key: keyof PetSettings; label: string; min: number; max: number; step?: number }[] = [
  { key: "wakeStart", label: "Waking start (UTC hour)", min: 0, max: 23 },
  { key: "wakeEnd", label: "Waking end (UTC hour)", min: 0, max: 23 },
  { key: "firstRequestMinutes", label: "First request delay (active minutes)", min: 1, max: 1440 },
  { key: "requestMinHours", label: "Minimum interval (active hours)", min: 0.25, max: 168, step: 0.25 },
  { key: "requestMaxHours", label: "Maximum interval (active hours)", min: 0.25, max: 168, step: 0.25 },
  { key: "maxRequestsPerDay", label: "Maximum requests per UTC day (0 = off)", min: 0, max: 24 },
  { key: "activityWindowHours", label: "Recent group activity window (hours)", min: 0.25, max: 168, step: 0.25 },
  { key: "responseMinutes", label: "Care / game deadline (active minutes)", min: 1, max: 1440 },
  { key: "silenceMinutes", label: "Silence challenge (minutes)", min: 1, max: 30 },
];
const SELECT_CLASS = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const REQUEST_CHOICES: { value: PetRequestChoice; label: string }[] = [
  { value: "random", label: "Random (normal stage unlocks)" },
  { value: "feed", label: "Food" },
  { value: "water", label: "Water" },
  { value: "clean", label: "Cleaning" },
  { value: "play", label: "Number game" },
  { value: "silence", label: "Silence" },
];

export function PetsCard() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["pets"], queryFn: api.getPets, retry: false, refetchInterval: 15_000 });
  const [selected, setSelected] = useState("");
  const [reload, setReload] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const group = query.data?.groups.find((item) => item.id === selected) ?? query.data?.groups[0];
  const canDiscard = () => !dirty || window.confirm("Discard unsaved pet settings?");
  const updateStatus = (pet: NonNullable<PetGroup["pet"]>, revision: string) => {
    client.setQueryData<PetsResponse>(["pets"], (current) => current ? {
      ...current, groups: current.groups.map((item) => item.id === group?.id ? { ...item, pet, revision } : item),
    } : current);
  };

  return <Card>
    <CardHeader><CardTitle>Group pets</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">
        One pet per approved group. Save group approvals in Access first.
        Pet settings and actions save immediately here, separately from the top Save changes button.
      </p>
      {query.error && <QueryError message={query.error.message} retryLabel="Retry pets" retrying={pending || query.isFetching} onRetry={() => void query.refetch()} />}
      <Button variant="outline" disabled={pending || query.isFetching} onClick={async () => {
        if (!canDiscard()) return;
        const result = await query.refetch();
        if (!result.error) { setReload((n) => n + 1); setDirty(false); }
      }}>Reload pets</Button>
      {query.isPending && <LoadingState>Loading pets...</LoadingState>}
      {query.data && <>
        <label className="block space-y-1">Group
          <select className={SELECT_CLASS} value={group?.id ?? ""} disabled={pending} onChange={(event) => {
            if (canDiscard()) { setSelected(event.target.value); setDirty(false); }
          }}>
            {query.data.groups.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.id})</option>)}
          </select>
        </label>
        {!group && !query.error && <EmptyState>No approved groups. Add and save one in Access, then reload pets.</EmptyState>}
        {group && <PetEditor key={`${group.id}:${reload}`} group={group} data={query.data}
          onDirty={setDirty} onPending={setPending} onStatus={updateStatus} onSaved={(pet, revision) => {
            setDirty(false);
            updateStatus(pet, revision);
          }} />}
      </>}
    </CardContent>
  </Card>;
}

function PetEditor({ group, data, onDirty, onPending, onSaved, onStatus }: {
  group: PetGroup;
  data: PetsResponse;
  onDirty: (dirty: boolean) => void;
  onPending: (pending: boolean) => void;
  onSaved: (pet: NonNullable<PetGroup["pet"]>, revision: string) => void;
  onStatus: (pet: NonNullable<PetGroup["pet"]>, revision: string) => void;
}) {
  const pet = group.pet;
  const [revision, setRevision] = useState(group.revision);
  const [name, setName] = useState(group.pet?.name ?? "Mochi");
  const [species, setSpecies] = useState(group.pet?.species ?? "random");
  const [settings, setSettings] = useState(group.pet?.settings ?? data.defaults);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [requestMessage, setRequestMessage] = useState("");
  const [requestKind, setRequestKind] = useState<PetRequestChoice>("random");
  const [evolutionMessage, setEvolutionMessage] = useState("");

  async function evolveNow() {
    if (!pet?.evolution.nextForm || !window.confirm(
      `Evolve ${pet.name} into ${pet.evolution.nextForm} now? This advances one form, updates healthy-time progress to its threshold, cancels any active request, and queues a picture announcement.`,
    )) return;
    setPending(true); onPending(true); setError(""); setEvolutionMessage("");
    try {
      const result = await api.evolvePet(group.id, pet.stage);
      onStatus(result.pet, result.revision);
      setEvolutionMessage("Pet evolved! The picture announcement is queued for WhatsApp.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not evolve the pet.");
    } finally {
      setPending(false); onPending(false);
    }
  }

  async function requestNow() {
    setPending(true); onPending(true); setError(""); setRequestMessage("");
    try {
      const result = await api.requestPet(group.id, requestKind);
      onStatus(result.pet, result.revision);
      setRequestMessage("Request queued for WhatsApp. Its timer starts after delivery. Reload pets to check its status.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request a challenge.");
    } finally {
      setPending(false); onPending(false);
    }
  }

  async function submit(action: PetUpdate["action"]) {
    setPending(true); onPending(true); setError(""); setSaved(false);
    try {
      const result = await api.updatePet(group.id, revision, { action, name, species, settings });
      setRevision(result.revision); setSpecies(result.pet.species);
      setName(result.pet.name); setSettings(result.pet.settings); setSaved(true);
      onSaved(result.pet, result.revision);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save pet settings.");
    } finally {
      setPending(false); onPending(false);
    }
  }
  const changed = () => { onDirty(true); setSaved(false); };

  return <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(pet ? "save" : "enable"); }}>
    {pet && <div className="rounded-lg border p-3">
      <p className="font-medium">{data.species[pet.species].emoji[pet.stage]} {pet.name} — {data.species[pet.species].forms[pet.stage]}</p>
      <p>{!pet.enabled ? "Disabled" : pet.paused ? "Paused" : pet.hibernating ? "Hibernating" : "Awake"}</p>
      <p className="text-sm">Food {Math.round(pet.hunger)} · Happiness {Math.round(pet.happiness)} · Energy {Math.round(pet.energy)}</p>
      <p className="text-sm">Water {Math.round(pet.hydration)} · Cleanliness {Math.round(pet.cleanliness)}</p>
      <EvolutionTimer evolution={pet.evolution} />
      <p className="text-sm">{pet.healthyDays.toFixed(1)} healthy days · {pet.request
        ? `${pet.request.kind} request ${pet.request.delivered ? "active" : "waiting for delivery"}`
        : `Next request eligible in ${Math.ceil(pet.nextRequestActiveMinutes)} active minutes`}</p>
    </div>}
    <fieldset disabled={pending} className="space-y-4">
      <label className="block space-y-1">Pet name
        <Input required maxLength={40} value={name} onChange={(e) => { setName(e.target.value); changed(); }} />
      </label>
      <label className="block space-y-1">Species
        <select className={SELECT_CLASS} value={species} disabled={!!pet} onChange={(e) => { setSpecies(e.target.value); changed(); }}>
          <option value="random">Random</option>
          {Object.entries(data.species).map(([id, item]) => <option key={id} value={id}>{item.name}</option>)}
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((field) => <label key={field.key} className="block space-y-1 text-sm">{field.label}
          <Input type="number" required min={field.min} max={field.max} step={field.step ?? 1}
            value={Number.isNaN(settings[field.key]) ? "" : settings[field.key]}
            onChange={(e) => { setSettings({ ...settings, [field.key]: e.target.valueAsNumber }); changed(); }} />
        </label>)}
      </div>
      <p className="text-xs text-muted-foreground">
        Intervals are random between the minimum and maximum. Overnight waking hours are supported.
        Offline time and pauses do not count. Changing deadlines affects future requests only.
        A daily limit of zero stops new requests, not care or evolution.
      </p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {saved && <p role="status" className="text-sm">Pet settings saved.</p>}
      {requestMessage && <p role="status" className="text-sm">{requestMessage}</p>}
      {evolutionMessage && <p role="status" className="text-sm">{evolutionMessage}</p>}
      {pet && <label className="block space-y-1">Request type
        <select className={SELECT_CLASS} value={requestKind} onChange={(e) => {
          const choice = REQUEST_CHOICES.find((item) => item.value === e.target.value);
          if (choice) setRequestKind(choice.value);
        }}>
          {REQUEST_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </select>
      </label>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit">{pending ? "Saving..." : pet ? "Save pet settings" : "Spawn pet"}</Button>
        {pet && <>
          <Button type="button" variant="outline" disabled={!pet.evolution.canForce}
            onClick={() => void evolveNow()}>Evolve now</Button>
          <Button type="button" variant="outline"
            disabled={!pet.enabled || pet.paused || pet.hibernating || !!pet.request}
            onClick={() => void requestNow()}>Request now</Button>
          {!pet.enabled
            ? <Button type="button" variant="outline" onClick={() => void submit("enable")}>Enable pet</Button>
            : <>
              <Button type="button" variant="outline" onClick={() => void submit(pet.paused ? "resume" : "pause")}>{pet.paused ? "Resume pet" : "Pause pet"}</Button>
              <Button type="button" variant="outline" onClick={() => void submit("disable")}>Disable pet</Button>
            </>}
        </>}
      </div>
      {pet && <p className="text-xs text-muted-foreground">
        Request now sends your chosen type at any evolution stage, using saved settings.
        Random uses the normal stage unlocks. This selection does not change automatic requests.
        It overrides waking hours, recent activity, spacing and the daily cap, but requires an online,
        awake pet with no active or queued request. Manual requests count toward the daily total.
      </p>}
    </fieldset>
    <p className="text-sm text-muted-foreground">In WhatsApp: bot.pet · bot.pet feed · bot.pet water · bot.pet clean · bot.pet play · bot.pet revive</p>
  </form>;
}

export function EvolutionTimer({ evolution }: { evolution: NonNullable<PetGroup["pet"]>["evolution"] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!evolution.nextForm) return <p className="text-sm">Final form unlocked!</p>;
  const age = Math.max(0, now - evolution.sampledAt);
  const elapsed = evolution.running ? Math.min(15_000, age) : 0;
  const seconds = Math.ceil(Math.max(0, evolution.remainingHealthyMs - elapsed) / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return <div className="text-sm">
    <p>Next evolution: {evolution.nextForm} — <span aria-label="Evolution countdown">{days}d {hours}h {minutes}m {seconds % 60}s</span> healthy time remaining</p>
    <p className="text-xs text-muted-foreground">{evolution.frozenReason
      ? `Frozen: ${evolution.frozenReason}`
      : age > 30_000 ? "Waiting for fresh pet status; countdown held."
      : seconds === 0 ? "Ready to evolve; waiting for the next scheduler tick."
      : "Counts only while healthy and online. Status refreshes every 15 seconds."}</p>
  </div>;
}
