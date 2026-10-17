import { useState } from 'react';
import { Fingerprint, KeyRound, Plus } from 'lucide-react';
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { Button, Card, Dialog, EmptyState, ErrorState, Field, Skeleton, StatusChip, inputCls, useToast } from '../components/ui';
import { idApi } from '../lib/api';
import { when } from '../lib/format';
import { useLoad } from '../lib/useLoad';

/* Passkeys (phase 8). A passkey lets an NCL employee sign in on the web
   with a fingerprint, face or PIN instead of typing the password. It is a
   web sign-in only: inspection acceptance still needs the app, which the
   database enforces. Adding one asks for the web password again so that an
   unattended screen cannot be used to plant a lasting key. Removed keys
   stay in the list with the reason — nothing is deleted. */

export type Passkey = { id: string; name: string; created_at: string; last_used_at: string | null;
  transports?: string[] | null; removed_at: string | null; removal_reason: string | null };

/** The browser's own refusal, in words a person can act on. */
function browserMessage(e: unknown) {
  const n = (e as { name?: string })?.name;
  if (n === 'NotAllowedError' || n === 'AbortError') return 'The passkey was not added. Try again, and approve the prompt with your fingerprint, face or PIN.';
  if (n === 'InvalidStateError') return 'This device already holds a passkey for you.';
  return e instanceof Error ? e.message : 'The passkey could not be added. Try again.';
}

function PasskeyRow({ k, onRemove }: { k: Passkey; onRemove?: () => void }) {
  return (
    <div className="border border-line rounded-input p-3 flex items-start gap-3">
      <Fingerprint size={20} className={k.removed_at ? 'text-ink-muted mt-0.5' : 'text-primary mt-0.5'} />
      <div className="flex-1 min-w-0">
        <div className={'font-medium truncate ' + (k.removed_at ? 'line-through text-ink-muted' : '')}>{k.name}</div>
        <div className="text-xs text-ink-muted">Added {when(k.created_at)}</div>
        <div className="text-xs text-ink-muted">{k.last_used_at ? `Last used ${when(k.last_used_at)}` : 'Not used yet'}</div>
        {k.removed_at && <div className="text-xs text-bad mt-1">Removed {when(k.removed_at)}{k.removal_reason ? ` — “${k.removal_reason}”` : ''}</div>}
      </div>
      {k.removed_at ? <StatusChip tone="neutral">Removed</StatusChip>
        : onRemove && <Button size="sm" variant="ghost" onClick={onRemove}>Remove</Button>}
    </div>
  );
}

/** Remove a passkey — the reason is compulsory and is kept in the audit trail. */
export function RemovePasskey({ k, who, onClose, onDone }: { k: Passkey; who?: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await idApi(`/passkeys/${k.id}/revoke`, { body: { reason: reason.trim() } }); toast({ text: 'Passkey removed' }); onDone(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Dialog open title={`Remove “${k.name}”`} onClose={onClose}
      actions={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="destructive" loading={busy} disabled={!reason.trim()} onClick={go}>Remove passkey</Button></>}>
      <p className="text-sm text-ink-muted mb-4">{who ? `${who} will not be able to sign in with this passkey again.` : 'You will not be able to sign in with this passkey again.'} It stays in the list as removed.</p>
      <Field label="Reason — kept in the audit trail" required>
        <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Phone lost" />
      </Field>
      {err && <div className="mt-3"><ErrorState message={err} /></div>}
    </Dialog>
  );
}

function AddPasskey({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const { options } = await idApi('/passkeys/options', { body: { password: pw } });
      let response;
      try { response = await startRegistration({ optionsJSON: options }); }
      catch (e) { setErr(browserMessage(e)); return; }
      await idApi('/passkeys', { body: { response, name: name.trim() } });
      toast({ text: `Passkey “${name.trim()}” added`, tone: 'ok' }); onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Dialog open title="Add a passkey" onClose={onClose}
      actions={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={busy} disabled={!name.trim() || !pw} icon={<Fingerprint size={18} />} onClick={go}>Add passkey</Button></>}>
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (name.trim() && pw) go(); }}>
        <Field label="Name" required help="So you can tell your passkeys apart, e.g. Office laptop.">
          <input className={inputCls} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Office laptop" />
        </Field>
        <Field label="Your web password" required help="Asked again so that no one can add a passkey on a screen you left open.">
          <input className={inputCls} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
        </Field>
        <p className="text-xs text-ink-muted">Your browser will then ask for your fingerprint, face or PIN.</p>
      </form>
      {err && <div className="mt-3"><ErrorState message={err} /></div>}
    </Dialog>
  );
}

/** The signed-in person's own passkeys. */
export function PasskeysCard({ hasPassword }: { hasPassword?: boolean }) {
  const list = useLoad(() => idApi<Passkey[]>('/passkeys'));
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const supported = browserSupportsWebAuthn();
  const live = (list.data || []).filter((k) => !k.removed_at);
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 font-medium"><KeyRound size={18} className="text-primary" />Passkeys</div>
      <p className="text-[13px] text-ink-muted mt-1">Sign in with your fingerprint, face or PIN instead of typing your password. Inspection acceptance still needs the app.</p>
      {list.error && <div className="mt-3"><ErrorState message={list.error} retry={list.reload} /></div>}
      {!list.data && !list.error && <Skeleton className="h-16 mt-3" />}
      {list.data && list.data.length === 0 && <div className="mt-3"><EmptyState title="No passkeys yet" body="Add one to sign in without typing your password." /></div>}
      <div className="grid gap-2 mt-3">
        {list.data?.map((k) => <PasskeyRow key={k.id} k={k} onRemove={() => setRemoving(k)} />)}
      </div>
      {!supported && <div className="mt-3 text-[13px] rounded-card bg-risk-bg text-risk p-3">This browser cannot create passkeys.</div>}
      {hasPassword === false && <div className="mt-3 text-[13px] rounded-card bg-risk-bg text-risk p-3">Set a web password first — it is asked when you add a passkey.</div>}
      <Button className="mt-3" variant="secondary" icon={<Plus size={18} />} disabled={!supported || hasPassword === false || !list.data} onClick={() => setAdding(true)}>Add a passkey</Button>
      {live.length >= 5 && <div className="text-xs text-ink-muted mt-2">Five passkeys is the most; remove one to add another.</div>}
      {adding && <AddPasskey onClose={() => setAdding(false)} onDone={() => { setAdding(false); list.reload(); }} />}
      {removing && <RemovePasskey k={removing} onClose={() => setRemoving(null)} onDone={() => { setRemoving(null); list.reload(); }} />}
    </Card>
  );
}

/** An Area administrator's view of another person's passkeys (lost phone). */
export function PersonPasskeys({ personId, name }: { personId: string; name: string }) {
  const list = useLoad(() => idApi<Passkey[]>(`/persons/${personId}/passkeys`), [personId]);
  const [removing, setRemoving] = useState<Passkey | null>(null);
  return (
    <div>
      <div className="label mt-5 mb-2">Passkeys</div>
      {list.error && <ErrorState message={list.error} retry={list.reload} />}
      {!list.data && !list.error && <Skeleton className="h-12" />}
      {list.data && list.data.length === 0 && <div className="text-[13px] text-ink-muted">No passkeys.</div>}
      <div className="grid gap-2">
        {list.data?.map((k) => <PasskeyRow key={k.id} k={k} onRemove={() => setRemoving(k)} />)}
      </div>
      {removing && <RemovePasskey k={removing} who={name} onClose={() => setRemoving(null)} onDone={() => { setRemoving(null); list.reload(); }} />}
    </div>
  );
}

/** Web page for officers: who they are signed in as, and their passkeys. */
export default function ProfilePage() {
  const me = useLoad(() => idApi('/me'));
  if (me.error) return <ErrorState message={me.error} retry={me.reload} />;
  if (!me.data) return <Skeleton className="h-32" />;
  const employee = !!me.data.personnel_no;
  return (
    <div className="max-w-2xl grid gap-4">
      {employee ? <PasskeysCard hasPassword={me.data.has_password} />
        : <EmptyState title="Passkeys are for NCL employees" body="They are held by people with an Employee ID. Contractors and Non-NCL residents use the app." />}
    </div>
  );
}
