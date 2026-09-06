/**
 * Passkeys — enrolment and the honest refusal.
 *
 * The one thing this card must never do is offer a button that cannot work:
 * WebAuthn scopes a credential to a *domain*, so on a deployment visited by
 * IP address the card explains that (and what to change) instead of failing
 * the ceremony. Adding and removing a passkey both re-prove the password,
 * because each is the same authority as changing the second factor.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fingerprint, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { PasskeyRecord } from '@metaclaude/shared';
import { usePlural, useT } from '@/lib/i18n';
import { Modal } from '@/components/ui/Modal';
import { Badge, Button, Card, CardHeader, Input, Label } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { createPasskey, isCeremonyCancelled, passkeyDomainOk, passkeySupported } from '@/lib/passkeys';

export function PasskeysCard() {
  const plural = usePlural();
  const t = useT();
  const queryClient = useQueryClient();
  const supported = passkeySupported();
  const domainOk = passkeyDomainOk();

  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<PasskeyRecord | null>(null);
  const [password, setPassword] = useState('');
  const [label, setLabel] = useState('');

  const passkeys = useQuery({
    queryKey: ['passkeys'],
    queryFn: () => api.passkeys.list(),
  });

  const closeDialogs = () => {
    setAdding(false);
    setRemoving(null);
    setPassword('');
    setLabel('');
  };

  const add = useMutation({
    mutationFn: async () => {
      const { options } = await api.passkeys.begin(password);
      const response = await createPasskey(options);
      return api.passkeys.finish(label.trim() || 'Passkey', response);
    },
    onSuccess: ({ passkey }) => {
      closeDialogs();
      void queryClient.invalidateQueries({ queryKey: ['passkeys'] });
      toast.success(t('"{label}" can now sign you in.', { label: passkey.label }));
    },
    onError: (error) => {
      if (isCeremonyCancelled(error)) return;
      toast.error(error instanceof ApiError ? error.message : t('Could not add the passkey.'));
    },
  });

  const remove = useMutation({
    mutationFn: (target: PasskeyRecord) => api.passkeys.remove(target.id, password),
    onSuccess: () => {
      closeDialogs();
      void queryClient.invalidateQueries({ queryKey: ['passkeys'] });
      toast.success(t('Passkey removed.'));
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not remove the passkey.')),
  });

  const list = passkeys.data?.passkeys ?? [];

  return (
    <Card>
      <CardHeader
        title={t('Passkeys')}
        description={t(
          "Sign in with your device's own unlock — Face ID, a fingerprint, a security key — instead of the password.",
        )}
        actions={
          list.length > 0 ? (
            <Badge tone="success">{plural(list.length, '{n} key enrolled', '{n} keys enrolled')}</Badge>
          ) : null
        }
      />
      <div className="space-y-3 px-4 pb-4">
        {!supported ? (
          <p className="text-caption leading-relaxed text-muted">
            {t(
              'This browser does not support passkeys (WebAuthn). Password and authenticator-app sign-in are unaffected.',
            )}
          </p>
        ) : !domainOk ? (
          <p className="text-caption leading-relaxed text-muted">
            {t(
              'Passkeys need a domain name: the WebAuthn standard scopes a credential to a domain, and this deployment is being reached by IP address. Give the server a hostname (METACLAUDE_SITE — see the deployment guide) and enrol from there. Password and authenticator-app sign-in are unaffected.',
            )}
          </p>
        ) : (
          <>
            {list.length > 0 ? (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {list.map((passkey) => (
                  <li key={passkey.id} className="flex items-center gap-3 px-3 py-2">
                    <Fingerprint className="size-4 shrink-0 text-muted" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body font-medium text-ink">{passkey.label}</p>
                      <p className="truncate text-caption text-subtle">
                        {passkey.rpId}
                        {passkey.lastUsedAt
                          ? ` · ${t(
                            'last used',
                          )} ${new Date(passkey.lastUsedAt).toLocaleDateString()}`
                          : ` · ${t('never used')}`}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('Remove {label}', { label: passkey.label })}
                      onClick={() => {
                        setRemoving(passkey);
                        setPassword('');
                      }}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-caption text-muted">
                {t(
                  'No passkey yet. The password keeps working either way — a passkey is an addition, never a replacement.',
                )}
              </p>
            )}
            <Button
              variant={list.length > 0 ? 'secondary' : 'primary'}
              size="sm"
              onClick={() => {
                setAdding(true);
                setPassword('');
                setLabel('');
              }}
            >
              <Fingerprint className="size-3.5" aria-hidden />
              {t('Add a passkey')}
            </Button>
          </>
        )}
      </div>

      {/* Adding a sign-in method re-proves the password, like every factor change. */}
      <Modal
        open={adding}
        onOpenChange={(open) => (open ? setAdding(true) : closeDialogs())}
        title={t('Add a passkey')}
        description={t('Your password confirms it is you; your device then creates the passkey.')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={closeDialogs}>
              {t('Cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={add.isPending}
              disabled={!password}
              onClick={() => add.mutate()}
            >
              {t('Create')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Label htmlFor="passkey-label" hint={t('So you can tell your devices apart later.')}>
            {t('Name')}
            <Input
              id="passkey-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t('This phone')}
              maxLength={60}
              className="mt-1.5"
            />
          </Label>
          <Label htmlFor="passkey-add-pw">
            {t('Password')}
            <Input
              id="passkey-add-pw"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && password) add.mutate();
              }}
              autoComplete="current-password"
              className="mt-1.5"
            />
          </Label>
        </div>
      </Modal>

      <Modal
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : closeDialogs())}
        title={t('Remove "{label}"', { label: removing?.label ?? '' })}
        description={t(
          'That device will no longer sign you in. Removing a sign-in method needs your password.',
        )}
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={closeDialogs}>
              {t('Cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={remove.isPending}
              disabled={!password}
              onClick={() => removing && remove.mutate(removing)}
            >
              {t('Remove')}
            </Button>
          </>
        }
      >
        <Label htmlFor="passkey-remove-pw">
          {t('Password')}
          <Input
            id="passkey-remove-pw"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && password && removing) remove.mutate(removing);
            }}
            autoComplete="current-password"
            className="mt-1.5"
          />
        </Label>
      </Modal>
    </Card>
  );
}
