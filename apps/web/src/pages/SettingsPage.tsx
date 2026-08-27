/**
 * Settings — account security, system health and the audit trail.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Copy,
  Cpu,
  HardDrive,
  KeyRound,
  Monitor,
  Moon,
  ScrollText,
  ShieldCheck,
  Smartphone,
  Sun,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { toast } from 'sonner';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { TotpQr } from '@/components/auth/TotpQr';
import { DoctorReportView } from '@/components/system/DoctorReportView';
import { ClaudeCredentialCard } from '@/components/settings/ClaudeCredentialCard';
import { NotificationsCard } from '@/components/settings/NotificationsCard';
import { PasskeysCard } from '@/components/settings/PasskeysCard';
import { UpdateCard } from '@/components/settings/UpdateCard';
import { CopyableCode } from '@/components/ui/CopyableCode';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Input,
  Label,
  Spinner,
  Stat,
} from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { useAuthStore, useUiStore, type ThemeMode } from '@/lib/store';
import {
  cn,
  copyToClipboard,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatRelative,
} from '@/lib/utils';

const TAB_CLASS =
  'px-3 py-2 text-[13px] font-medium text-muted border-b-2 border-transparent transition-colors data-[state=active]:border-accent data-[state=active]:text-ink hover:text-ink';

export function SettingsPage() {
  const user = useAuthStore((state) => state.user);

  return (
    <AppShell>
      <ContentHeader
        title="Settings"
        subtitle={user ? `Signed in as ${user.username} (${user.role})` : undefined}
        showSidebarToggle={false}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-4 sm:p-6">
          <Tabs.Root defaultValue="security">
            <Tabs.List
              className="mb-5 flex gap-1 overflow-x-auto border-b border-line"
              aria-label="Settings sections"
            >
              <Tabs.Trigger value="security" className={TAB_CLASS}>
                Security
              </Tabs.Trigger>
              <Tabs.Trigger value="appearance" className={TAB_CLASS}>
                Appearance
              </Tabs.Trigger>
              <Tabs.Trigger value="system" className={TAB_CLASS}>
                System
              </Tabs.Trigger>
              {user?.role === 'owner' ? (
                <Tabs.Trigger value="audit" className={TAB_CLASS}>
                  Audit log
                </Tabs.Trigger>
              ) : null}
            </Tabs.List>

            <Tabs.Content value="security" className="space-y-4">
              <PasswordCard />
              <TotpCard />
              <PasskeysCard />
              <SessionsCard />
            </Tabs.Content>

            <Tabs.Content value="appearance">
              <AppearanceCard />
            </Tabs.Content>

            <Tabs.Content value="system" className="space-y-4">
              <SystemCard />
              {user?.role === 'owner' ? <DoctorCard /> : null}
              {user?.role === 'owner' ? <UpdateCard /> : null}
            </Tabs.Content>

            {user?.role === 'owner' ? (
              <Tabs.Content value="audit">
                <AuditCard />
              </Tabs.Content>
            ) : null}
          </Tabs.Root>
        </div>
      </div>
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */
/* Security                                                                    */
/* -------------------------------------------------------------------------- */

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  const change = useMutation({
    mutationFn: () => api.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      toast.success('Password changed. Sign in again with the new one.');
      // Every session was revoked server-side, including this one.
      setTimeout(() => window.location.assign('/login'), 1200);
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not change the password.'),
  });

  const mismatch = confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < 12;

  return (
    <Card>
      <CardHeader
        title="Password"
        description="Changing it signs out every device, including this one."
      />
      <div className="space-y-4 p-4">
        <Label htmlFor="pw-current">
          Current password
          <Input
            id="pw-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            className="mt-1.5"
          />
        </Label>

        <Label htmlFor="pw-new" hint="At least 12 characters. Length matters more than symbols.">
          New password
          <Input
            id="pw-new"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            className="mt-1.5"
          />
        </Label>

        <Label htmlFor="pw-confirm">
          Confirm new password
          <Input
            id="pw-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            className={cn('mt-1.5', mismatch && 'border-danger')}
          />
        </Label>

        {mismatch ? <p className="text-[12.5px] text-danger">The passwords do not match.</p> : null}
        {tooShort ? (
          <p className="text-[12.5px] text-warning">Use at least 12 characters.</p>
        ) : null}

        <Button
          variant="primary"
          size="sm"
          loading={change.isPending}
          disabled={!current || !next || mismatch || tooShort}
          onClick={() => change.mutate()}
        >
          <KeyRound className="size-4" aria-hidden />
          Change password
        </Button>
      </div>
    </Card>
  );
}

function TotpCard() {
  const { user, recoveryCodesRemaining, setUser } = useAuthStore();
  const [enrolling, setEnrolling] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState('');
  // Enrolment is password-gated server-side, so the UI asks first rather than
  // letting the request come back 403.
  const [confirmingIdentity, setConfirmingIdentity] = useState(false);
  const [enrolPassword, setEnrolPassword] = useState('');

  const closeEnrolment = () => {
    setEnrolling(null);
    setCode('');
    // Drop the staged secret so an abandoned enrolment leaves nothing behind.
    void api.totpCancel().catch(() => undefined);
  };

  const begin = useMutation({
    mutationFn: () => api.totpBegin(enrolPassword),
    onSuccess: (data) => {
      setConfirmingIdentity(false);
      setEnrolPassword('');
      setEnrolling(data);
    },
    onError: () => toast.error('That password is incorrect.'),
  });

  const confirm = useMutation({
    mutationFn: () => api.totpConfirm(code),
    onSuccess: (data) => {
      setRecoveryCodes(data.recoveryCodes);
      setEnrolling(null);
      setCode('');
      if (user) setUser({ ...user, totpEnabled: true }, data.recoveryCodes.length);
      toast.success('Two-factor authentication is on.');
    },
    onError: () => toast.error('That code was not accepted. Check your device clock.'),
  });

  const disable = useMutation({
    mutationFn: () => api.totpDisable(password),
    onSuccess: () => {
      if (user) setUser({ ...user, totpEnabled: false }, 0);
      setDisabling(false);
      setPassword('');
      toast.success('Two-factor authentication is off.');
    },
    onError: () => toast.error('That password is incorrect.'),
  });

  return (
    <Card>
      <CardHeader
        title="Two-factor authentication"
        description="A second factor is what keeps a leaked password from becoming a compromised agent OS."
        actions={
          user?.totpEnabled ? (
            <Badge tone="success">
              <ShieldCheck className="size-3" aria-hidden />
              on
            </Badge>
          ) : (
            <Badge tone="warning">off</Badge>
          )
        }
      />

      <div className="space-y-3 p-4">
        {user?.totpEnabled ? (
          <>
            <p className="text-[13px] text-muted">
              {recoveryCodesRemaining} recovery code{recoveryCodesRemaining === 1 ? '' : 's'}{' '}
              remaining.
              {recoveryCodesRemaining <= 2 ? (
                <span className="text-warning"> Consider re-enrolling to get a fresh set.</span>
              ) : null}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => setConfirmingIdentity(true)}>
                <Smartphone className="size-4" aria-hidden />
                Re-enrol
              </Button>
              <Button variant="outline" size="sm" onClick={() => setDisabling(true)}>
                Turn off
              </Button>
            </div>
          </>
        ) : (
          <Button variant="primary" size="sm" onClick={() => setConfirmingIdentity(true)}>
            <Smartphone className="size-4" aria-hidden />
            Set up
          </Button>
        )}
      </div>

      {/* Re-prove the first factor before touching the second. */}
      <Modal
        open={confirmingIdentity}
        onOpenChange={(open) => {
          setConfirmingIdentity(open);
          if (!open) setEnrolPassword('');
        }}
        title="Confirm your password"
        description={
          user?.totpEnabled
            ? 'Re-enrolling replaces your current authenticator and issues new recovery codes.'
            : 'Enrolling a device changes how you sign in, so it needs your password.'
        }
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmingIdentity(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={begin.isPending}
              disabled={!enrolPassword}
              onClick={() => begin.mutate()}
            >
              Continue
            </Button>
          </>
        }
      >
        <Label htmlFor="totp-enrol-pw">
          Password
          <Input
            id="totp-enrol-pw"
            type="password"
            value={enrolPassword}
            onChange={(event) => setEnrolPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && enrolPassword) begin.mutate();
            }}
            autoFocus
            className="mt-1.5"
          />
        </Label>
      </Modal>

      {/* Enrolment */}
      <Modal
        open={Boolean(enrolling)}
        onOpenChange={(open) => {
          if (!open) closeEnrolment();
        }}
        title="Set up two-factor authentication"
        description="Add this secret to your authenticator app, then confirm with the code it shows."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={closeEnrolment}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={confirm.isPending}
              disabled={!/^\d{6}$/.test(code)}
              onClick={() => confirm.mutate()}
            >
              Confirm
            </Button>
          </>
        }
      >
        {enrolling ? (
          <div className="space-y-4">
            <div className="flex justify-center">
              <TotpQr uri={enrolling.uri} />
            </div>

            <div>
              <p className="mb-1.5 text-[13px] font-medium text-ink">
                Can't scan? Enter this setup key instead
              </p>
              <CopyableCode value={enrolling.secret} />
            </div>

            <Label htmlFor="totp-code">
              Code from your app
              <Input
                id="totp-code"
                value={code}
                onChange={(event) => setCode(event.target.value.trim())}
                inputMode="numeric"
                placeholder="123456"
                autoFocus
                className="mt-1.5 text-center font-mono text-lg tracking-[0.35em]"
              />
            </Label>
          </div>
        ) : null}
      </Modal>

      {/* Recovery codes — shown exactly once. */}
      <Modal
        open={Boolean(recoveryCodes)}
        onOpenChange={(open) => !open && setRecoveryCodes(null)}
        title="Save your recovery codes"
        description="Each works once, in place of a code from your app. This is the only time they are shown."
        footer={
          <Button variant="primary" size="sm" onClick={() => setRecoveryCodes(null)}>
            I have saved them
          </Button>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-sunken p-3">
            {recoveryCodes?.map((recoveryCode) => (
              <code key={recoveryCode} className="font-mono text-[13px] text-ink">
                {recoveryCode}
              </code>
            ))}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void copyToClipboard((recoveryCodes ?? []).join('\n')).then((ok) =>
                ok ? toast.success('Copied') : toast.error('Could not copy'),
              );
            }}
          >
            <Copy className="size-4" aria-hidden />
            Copy all
          </Button>
        </div>
      </Modal>

      {/* Disable */}
      <Modal
        open={disabling}
        onOpenChange={setDisabling}
        title="Turn off two-factor authentication?"
        description="Confirm with your password. This weakens your account's security."
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDisabling(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={disable.isPending}
              disabled={!password}
              onClick={() => disable.mutate()}
            >
              Turn off
            </Button>
          </>
        }
      >
        <Label htmlFor="totp-disable-pw">
          Password
          <Input
            id="totp-disable-pw"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1.5"
          />
        </Label>
      </Modal>
    </Card>
  );
}

function SessionsCard() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['auth-sessions'],
    queryFn: () => api.authSessions(),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeAuthSession(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['auth-sessions'] });
      toast.success('Signed out that device');
    },
  });

  const revokeOthers = useMutation({
    mutationFn: () => api.revokeOtherSessions(),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['auth-sessions'] });
      toast.success(`Signed out ${result.revoked} other device(s)`);
    },
  });

  const sessions = data?.sessions ?? [];

  return (
    <Card>
      <CardHeader
        title="Signed-in devices"
        description="Anything you do not recognise should be signed out immediately."
        actions={
          sessions.length > 1 ? (
            <Button
              variant="outline"
              size="sm"
              loading={revokeOthers.isPending}
              onClick={() => revokeOthers.mutate()}
            >
              Sign out others
            </Button>
          ) : null
        }
      />

      {isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <ul className="divide-y divide-[var(--mc-border)]">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-[13px] text-ink">
                  <span className="truncate">{describeUserAgent(session.userAgent)}</span>
                  {session.current ? <Badge tone="accent">this device</Badge> : null}
                </p>
                <p className="text-[11.5px] text-subtle">
                  {session.ipAddress ?? 'unknown address'} · active{' '}
                  {formatRelative(session.lastSeenAt)}
                </p>
              </div>
              {!session.current ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Sign out this device"
                  onClick={() => revoke.mutate(session.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Appearance                                                                  */
/* -------------------------------------------------------------------------- */

function AppearanceCard() {
  const { theme, setTheme, showThinking, setShowThinking, expandTools, setExpandTools } =
    useUiStore();

  const options: Array<{ value: ThemeMode; label: string; icon: React.ReactNode }> = [
    { value: 'light', label: 'Light', icon: <Sun /> },
    { value: 'dark', label: 'Dark', icon: <Moon /> },
    { value: 'system', label: 'System', icon: <Monitor /> },
  ];

  return (
    <Card>
      <CardHeader title="Appearance" description="These preferences live in this browser only." />
      <div className="space-y-5 p-4">
        <div>
          <p className="mb-2 text-[13px] font-medium text-ink">Theme</p>
          <div className="flex gap-2">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setTheme(option.value)}
                aria-pressed={theme === option.value}
                className={cn(
                  'flex flex-1 flex-col items-center gap-1.5 rounded-xl border px-3 py-3 transition-colors',
                  '[&>svg]:size-5',
                  theme === option.value
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-line text-muted hover:bg-raised',
                )}
              >
                {option.icon}
                <span className="text-[12px] font-medium">{option.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-[13px] font-medium text-ink">Transcript</p>
          <PreferenceToggle
            checked={showThinking}
            onChange={setShowThinking}
            label="Show the model's reasoning"
            hint="Collapsible blocks showing how the agent worked through the problem."
          />
          <PreferenceToggle
            checked={expandTools}
            onChange={setExpandTools}
            label="Expand tool calls by default"
            hint="Show each tool's full input and result instead of a one-line summary."
          />
        </div>
      </div>
    </Card>
  );
}

function PreferenceToggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-[var(--mc-accent)]"
      />
      <span className="min-w-0">
        <span className="block text-[13px] text-ink">{label}</span>
        <span className="block text-[12px] leading-relaxed text-muted">{hint}</span>
      </span>
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * On demand rather than on mount: a full examination probes the CLI binary
 * and walks the audit chain, and running that on every tab visit would be
 * noise. The button is the request.
 */
function DoctorCard() {
  const doctorQuery = useQuery({
    queryKey: ['doctor'],
    queryFn: () => api.doctor(),
    enabled: false,
  });

  return (
    <Card>
      <CardHeader
        title="Doctor"
        description="Every self-check the system knows how to run — database, audit chain, vault, disk, CLI, automations."
        actions={
          <Button
            variant="secondary"
            size="sm"
            loading={doctorQuery.isFetching}
            onClick={() => void doctorQuery.refetch()}
          >
            Run checks
          </Button>
        }
      />
      <div className="px-4 pb-4">
        {doctorQuery.data ? (
          <DoctorReportView report={doctorQuery.data} />
        ) : doctorQuery.isError ? (
          <p className="text-[12.5px] text-muted">The examination could not run.</p>
        ) : (
          <p className="text-[12.5px] text-subtle">Not run yet.</p>
        )}
      </div>
    </Card>
  );
}

function SystemCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['system'],
    queryFn: () => api.system(),
    refetchInterval: 30_000,
  });

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Version" value={data.version} />
        <Stat label="Uptime" value={formatDuration(data.uptimeMs)} />
        <Stat
          label="Memory (RSS)"
          value={formatBytes(data.rssBytes)}
          icon={<Cpu />}
        />
        <Stat label="Disk free" value={formatBytes(data.diskFreeBytes)} icon={<HardDrive />} />
      </div>

      <Card>
        <CardHeader title="Claude CLI" description="Every agent run goes through this binary." />
        <dl className="divide-y divide-[var(--mc-border)]">
          <Row label="Available">
            {data.claudeCli.available ? (
              <Badge tone="success">yes</Badge>
            ) : (
              <Badge tone="danger">not found</Badge>
            )}
          </Row>
          <Row label="Version">{data.claudeCli.version ?? '—'}</Row>
          <Row label="Authentication">
            <div className="flex flex-wrap items-center gap-2">
              {data.claudeCli.authMode === 'subscription' ? (
                <Badge tone="success">subscription (Pro / Max)</Badge>
              ) : data.claudeCli.authMode === 'api_key' ? (
                <Badge tone="warning">API key (pay as you go)</Badge>
              ) : (
                <Badge tone="danger">none configured</Badge>
              )}
              {data.claudeCli.authHint ? (
                <code className="font-mono text-[12px] text-muted">{data.claudeCli.authHint}</code>
              ) : null}
              {data.claudeCli.authSource ? (
                <span className="text-[12px] text-subtle">
                  {data.claudeCli.authSource === 'stored'
                    ? 'paired here'
                    : data.claudeCli.authSource === 'cli-login'
                      ? 'CLI account sign-in'
                      : 'from the environment'}
                </span>
              ) : null}
            </div>
          </Row>
        </dl>
      </Card>

      <ClaudeCredentialCard />

      <NotificationsCard />

      <Card>
        <CardHeader title="Kernel" />
        <dl className="divide-y divide-[var(--mc-border)]">
          <Row label="Active runs">{data.activeRuns}</Row>
          <Row label="Queued runs">{data.queuedRuns}</Row>
          <Row label="Stored memories">{data.memoryCount}</Row>
          <Row label="Embedding provider">
            <code className="font-mono text-[12px]">{data.embeddingProvider}</code>
          </Row>
        </dl>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="text-[13px] font-medium text-ink">{children}</dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

function AuditCard() {
  const [verifying, setVerifying] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['audit'],
    queryFn: () => api.audit({ limit: 200 }),
  });

  const verify = useMutation({
    mutationFn: () => api.verifyAudit(),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success(`Chain intact across ${result.entries} entries.`);
      } else {
        toast.error(`Chain broken at entry ${result.brokenAt}. The log may have been altered.`);
      }
      setVerifying(false);
    },
    onError: () => {
      toast.error('Could not verify the chain.');
      setVerifying(false);
    },
  });

  const entries = data?.entries ?? [];

  return (
    <Card>
      <CardHeader
        title="Audit log"
        description="Every entry commits to the hash of the one before it, so an edit anywhere invalidates everything after."
        actions={
          <Button
            variant="outline"
            size="sm"
            loading={verifying}
            onClick={() => {
              setVerifying(true);
              verify.mutate();
            }}
          >
            <ScrollText className="size-4" aria-hidden />
            Verify chain
          </Button>
        }
      />

      {isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState title="No entries" />
      ) : (
        <div className="max-h-[28rem] overflow-y-auto">
          <ul className="divide-y divide-[var(--mc-border)]">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-start gap-3 px-4 py-2.5">
                <Badge tone={entry.outcome === 'success' ? 'neutral' : 'danger'}>
                  {entry.outcome === 'success' ? (
                    <Check className="size-2.5" aria-hidden />
                  ) : (
                    '!'
                  )}
                </Badge>

                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
                    <code className="font-mono font-medium text-ink">{entry.action}</code>
                    <span className="text-muted">{entry.actor}</span>
                  </p>
                  {entry.detail ? (
                    <p className="truncate text-[11.5px] text-subtle">{entry.detail}</p>
                  ) : null}
                </div>

                <span
                  className="shrink-0 text-[11px] text-subtle"
                  title={formatDateTime(entry.at)}
                >
                  {formatRelative(entry.at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */


/** Turn a user-agent string into something a human can recognise. */
function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';

  const browser =
    /Firefox\/[\d.]+/.test(userAgent)
      ? 'Firefox'
      : /Edg\//.test(userAgent)
        ? 'Edge'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : 'Browser';

  const platform = /iPhone|iPad/.test(userAgent)
    ? 'iOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Macintosh/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : 'Unknown';

  return `${browser} on ${platform}`;
}
