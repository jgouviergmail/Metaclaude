/**
 * Settings — account security, system health and the audit trail.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Page } from '@/components/ui/layout';
import { TabPanel, Tabs, TabStrip, TabTrigger } from '@/components/ui/tabs';
import {
  Check,
  Copy,
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
import { type Lang, type TranslateFn, useI18n, usePlural, useT } from '@/lib/i18n';
import { toast } from 'sonner';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { TotpQr } from '@/components/auth/TotpQr';
import { DoctorReportView } from '@/components/system/DoctorReportView';
import { ResourceMeters } from '@/components/system/ResourceMeters';
import { RetrievalStatus } from '@/components/system/RetrievalStatus';
import { ClaudeCredentialCard } from '@/components/settings/ClaudeCredentialCard';
import { GoogleConnectionCard } from '@/components/settings/GoogleConnectionCard';
import { ConfigurationCard } from '@/components/settings/ConfigurationCard';
import { McpGatewayCard } from '@/components/settings/McpGatewayCard';
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
import { SegmentedControl } from '@/components/ui/controls';
import { useAuthStore, useUiStore, type Density, type ThemeMode } from '@/lib/store';
import {
  cn,
  copyToClipboard,
  formatDateTime,
  formatDuration,
  formatRelative,
} from '@/lib/utils';

/**
 * Which tab the page opens on, from the URL's query string.
 *
 * Google's OAuth callback redirects to `/settings?google=connected|failed`,
 * and the toast that reports the outcome lives in the connection card — which
 * Radix *unmounts* while its tab is inactive. Landing on the default Security
 * tab would therefore swallow the outcome entirely: no card, no effect, no
 * toast, and the query parameter left in place. The parameter that carries
 * the outcome has to also pick the tab that can read it.
 */
export function initialSettingsTab(search: string): string {
  return new URLSearchParams(search).has('google') ? 'connections' : 'security';
}

export function SettingsPage() {
  const t = useT();
  const user = useAuthStore((state) => state.user);

  return (
    <AppShell>
      <ContentHeader
        title={t('Settings')}
        subtitle={user ? t(
          'Signed in as {name} ({role})',
          { name: user.username, role: user.role },
        ) : undefined}
        showSidebarToggle={false}
      />

      <Page width="prose" gap="none">
          <Tabs defaultValue={initialSettingsTab(window.location.search)}>
            <TabStrip label={t('Settings sections')}>
              <TabTrigger value="security">
                {t('Security')}
              </TabTrigger>
              <TabTrigger value="appearance">
                {t('Appearance')}
              </TabTrigger>
              <TabTrigger value="system">
                {t('System')}
              </TabTrigger>
              {user?.role === 'owner' ? (
                <TabTrigger value="connections">
                  {t('Connections')}
                </TabTrigger>
              ) : null}
              {user?.role === 'owner' ? (
                <TabTrigger value="configuration">
                  {t('Configuration')}
                </TabTrigger>
              ) : null}
              {user?.role === 'owner' ? (
                <TabTrigger value="audit">
                  {t('Audit log')}
                </TabTrigger>
              ) : null}
            </TabStrip>

            <TabPanel value="security" className="space-y-4">
              <PasswordCard />
              <TotpCard />
              <PasskeysCard />
              <SessionsCard />
            </TabPanel>

            <TabPanel value="appearance">
              <AppearanceCard />
            </TabPanel>

            <TabPanel value="system" className="space-y-4">
              <SystemCard />
              {user?.role === 'owner' ? <DoctorCard /> : null}
              {user?.role === 'owner' ? <UpdateCard /> : null}
            </TabPanel>

            {/* Owner only: connecting Google stores a credential that reaches a
                live mailbox, which is a wider blast radius than any other
                registry write. */}
            {user?.role === 'owner' ? (
              <TabPanel value="connections" className="space-y-4">
                <GoogleConnectionCard />
                {/* The other direction: what *reaches in*. Owner-only for the
                    same reason — a token that may start runs is a credential
                    for executing things here. */}
                <McpGatewayCard />
              </TabPanel>
            ) : null}

            {/* Owner only, exactly like the API behind it: how long a run may
                take and how many may run at once is not an operator's call. */}
            {user?.role === 'owner' ? (
              <TabPanel value="configuration">
                <ConfigurationCard />
              </TabPanel>
            ) : null}

            {user?.role === 'owner' ? (
              <TabPanel value="audit">
                <AuditCard />
              </TabPanel>
            ) : null}
          </Tabs>
      </Page>
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */
/* Security                                                                    */
/* -------------------------------------------------------------------------- */

function PasswordCard() {
  const t = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  const change = useMutation({
    mutationFn: () => api.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      toast.success(t('Password changed. Sign in again with the new one.'));
      // Every session was revoked server-side, including this one.
      setTimeout(() => window.location.assign('/login'), 1200);
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not change the password.')),
  });

  const mismatch = confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < 12;

  return (
    <Card>
      <CardHeader
        title={t('Password')}
        description={t('Changing it signs out every device, including this one.')}
      />
      <div className="space-y-4 p-4">
        <Label htmlFor="pw-current">
          {t('Current password')}
          <Input
            id="pw-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            className="mt-1.5"
          />
        </Label>

        <Label htmlFor="pw-new" hint={t(
          'At least 12 characters. Length matters more than symbols.',
        )}>
          {t('New password')}
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
          {t('Confirm new password')}
          <Input
            id="pw-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            className={cn('mt-1.5', mismatch && 'border-danger')}
          />
        </Label>

        {mismatch ? <p className="text-[12.5px] text-danger">{t(
          'The passwords do not match.',
        )}</p> : null}
        {tooShort ? (
          <p className="text-[12.5px] text-warning">{t('Use at least 12 characters.')}</p>
        ) : null}

        <Button
          variant="primary"
          size="sm"
          loading={change.isPending}
          disabled={!current || !next || mismatch || tooShort}
          onClick={() => change.mutate()}
        >
          <KeyRound className="size-4" aria-hidden />
          {t('Change password')}
        </Button>
      </div>
    </Card>
  );
}

function TotpCard() {
  const plural = usePlural();
  const t = useT();
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
    onError: () => toast.error(t('That password is incorrect.')),
  });

  const confirm = useMutation({
    mutationFn: () => api.totpConfirm(code),
    onSuccess: (data) => {
      setRecoveryCodes(data.recoveryCodes);
      setEnrolling(null);
      setCode('');
      if (user) setUser({ ...user, totpEnabled: true }, data.recoveryCodes.length);
      toast.success(t('Two-factor authentication is on.'));
    },
    onError: () => toast.error(t('That code was not accepted. Check your device clock.')),
  });

  const disable = useMutation({
    mutationFn: () => api.totpDisable(password),
    onSuccess: () => {
      if (user) setUser({ ...user, totpEnabled: false }, 0);
      setDisabling(false);
      setPassword('');
      toast.success(t('Two-factor authentication is off.'));
    },
    onError: () => toast.error(t('That password is incorrect.')),
  });

  return (
    <Card>
      <CardHeader
        title={t('Two-factor authentication')}
        description={t(
          'A second factor is what keeps a leaked password from becoming a compromised agent OS.',
        )}
        actions={
          user?.totpEnabled ? (
            <Badge tone="success">
              <ShieldCheck className="size-3" aria-hidden />
              {t('on')}
            </Badge>
          ) : (
            <Badge tone="warning">{t('off')}</Badge>
          )
        }
      />

      <div className="space-y-3 p-4">
        {user?.totpEnabled ? (
          <>
            <p className="text-[13px] text-muted">
              {plural(
                recoveryCodesRemaining,
                '{n} recovery code remaining.',
                '{n} recovery codes remaining.',
              )}
              {recoveryCodesRemaining <= 2 ? (
                <span className="text-warning"> {t(
                  'Consider re-enrolling to get a fresh set.',
                )}</span>
              ) : null}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => setConfirmingIdentity(true)}>
                <Smartphone className="size-4" aria-hidden />
                {t('Re-enrol')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setDisabling(true)}>
                {t('Turn off')}
              </Button>
            </div>
          </>
        ) : (
          <Button variant="primary" size="sm" onClick={() => setConfirmingIdentity(true)}>
            <Smartphone className="size-4" aria-hidden />
            {t('Set up')}
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
        title={t('Confirm your password')}
        description={
          user?.totpEnabled
            ? t('Re-enrolling replaces your current authenticator and issues new recovery codes.')
            : t('Enrolling a device changes how you sign in, so it needs your password.')
        }
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmingIdentity(false)}>
              {t('Cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={begin.isPending}
              disabled={!enrolPassword}
              onClick={() => begin.mutate()}
            >
              {t('Continue')}
            </Button>
          </>
        }
      >
        <Label htmlFor="totp-enrol-pw">
          {t('Password')}
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
        title={t('Set up two-factor authentication')}
        description={t(
          'Add this secret to your authenticator app, then confirm with the code it shows.',
        )}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={closeEnrolment}>
              {t('Cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={confirm.isPending}
              disabled={!/^\d{6}$/.test(code)}
              onClick={() => confirm.mutate()}
            >
              {t('Confirm')}
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
                {t("Can't scan? Enter this setup key instead")}
              </p>
              <CopyableCode value={enrolling.secret} />
            </div>

            <Label htmlFor="totp-code">
              {t('Code from your app')}
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
        title={t('Save your recovery codes')}
        description={t(
          'Each works once, in place of a code from your app. This is the only time they are shown.',
        )}
        footer={
          <Button variant="primary" size="sm" onClick={() => setRecoveryCodes(null)}>
            {t('I have saved them')}
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
                ok ? toast.success(t('Copied')) : toast.error(t('Could not copy')),
              );
            }}
          >
            <Copy className="size-4" aria-hidden />
            {t('Copy all')}
          </Button>
        </div>
      </Modal>

      {/* Disable */}
      <Modal
        open={disabling}
        onOpenChange={setDisabling}
        title={t('Turn off two-factor authentication?')}
        description={t("Confirm with your password. This weakens your account's security.")}
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDisabling(false)}>
              {t('Cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={disable.isPending}
              disabled={!password}
              onClick={() => disable.mutate()}
            >
              {t('Turn off')}
            </Button>
          </>
        }
      >
        <Label htmlFor="totp-disable-pw">
          {t('Password')}
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
  const plural = usePlural();
  const t = useT();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['auth-sessions'],
    queryFn: () => api.authSessions(),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeAuthSession(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['auth-sessions'] });
      toast.success(t('Signed out that device'));
    },
  });

  const revokeOthers = useMutation({
    mutationFn: () => api.revokeOtherSessions(),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['auth-sessions'] });
      toast.success(
        plural(result.revoked, 'Signed out {n} other device', 'Signed out {n} other devices'),
      );
    },
  });

  const sessions = data?.sessions ?? [];

  return (
    <Card>
      <CardHeader
        title={t('Signed-in devices')}
        description={t('Anything you do not recognise should be signed out immediately.')}
        actions={
          sessions.length > 1 ? (
            <Button
              variant="outline"
              size="sm"
              loading={revokeOthers.isPending}
              onClick={() => revokeOthers.mutate()}
            >
              {t('Sign out others')}
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
                  <span className="truncate">{describeUserAgent(session.userAgent, t)}</span>
                  {session.current ? <Badge tone="accent">{t('this device')}</Badge> : null}
                </p>
                <p className="text-[11.5px] text-subtle">
                  {session.ipAddress ?? t('unknown address')} · {t('active')}{' '}
                  {formatRelative(session.lastSeenAt)}
                </p>
              </div>
              {!session.current ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Sign out this device')}
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

export function AppearanceCard() {
  const { theme, setTheme, density, setDensity, showThinking, setShowThinking, expandTools, setExpandTools } =
    useUiStore();
  const { lang, setLang, t } = useI18n();
  const user = useAuthStore((state) => state.user);

  /**
   * Switching the interface's language also tells the server what to *write*
   * in — memories, distilled lessons, a merged note.
   *
   * One control, because "the app is in French" is one idea. They are two
   * settings underneath and they have to be: the interface is a per-browser
   * preference, while a corpus of text has exactly one language whoever is
   * reading it. So the browser half always applies, and the server half is
   * attempted — best effort, because only an owner may change a deployment
   * setting and a viewer's own reading language is still theirs to choose.
   */
  const chooseLanguage = (value: Lang): void => {
    void setLang(value);
    if (user?.role !== 'owner') return;
    void api.setRuntimeSetting('language', value).catch(() => {
      // Already reported by the interface changing; a failure here leaves the
      // deployment writing in whatever it wrote in before, which is safe.
    });
  };

  const options: Array<{ value: ThemeMode; label: string; icon: React.ReactNode }> = [
    { value: 'light', label: t('Light'), icon: <Sun /> },
    { value: 'dark', label: t('Dark'), icon: <Moon /> },
    { value: 'system', label: t('System'), icon: <Monitor /> },
  ];

  // Translated here rather than at the render site: the table lives inside the
  // component, so `t` is in scope, and a literal sentence sitting in a constant
  // is exactly what the untranslated-copy ratchet is built to catch.
  const densities: Array<{ value: Density; label: string; hint: string }> = [
    { value: 'compact', label: t('Compact'), hint: t('More rows at a glance.') },
    { value: 'comfortable', label: t('Comfortable'), hint: t('More room, and help always shown.') },
  ];

  // Each language names itself in itself — the one string a switch must
  // never translate, or the person who cannot read the current language
  // cannot find their way back.
  const languages: Array<{ value: Lang; label: string }> = [
    { value: 'en', label: 'English' },
    { value: 'fr', label: 'Français' },
  ];

  return (
    <Card>
      <CardHeader
        title={t('Appearance')}
        description={t('The theme and the transcript options live in this browser only.')}
      />
      <div className="space-y-5 p-4">
        <div>
          <SegmentedControl
            label={t('Language')}
            value={lang}
            onChange={chooseLanguage}
            options={languages}
          />
          <p className="mt-2 text-[12px] text-muted">
            {user?.role === 'owner'
              ? t(
                  'Metaclaude writes in this language too — memories, distilled lessons, what it proposes. A workspace can override it. The guide and the changelog stay in English for now.',
                )
              : t('The guide and the changelog stay in English for now.')}
          </p>
        </div>

        <div>
          <SegmentedControl label={t('Theme')} value={theme} onChange={setTheme} options={options} />
        </div>

        <div>
          <SegmentedControl
            label={t('Density')}
            value={density}
            onChange={setDensity}
            options={densities}
          />
        </div>

        <div className="space-y-3">
          <p className="text-[13px] font-medium text-ink">{t('Transcript')}</p>
          <PreferenceToggle
            checked={showThinking}
            onChange={setShowThinking}
            label={t("Show the model's reasoning")}
            hint={t('Collapsible blocks showing how the agent worked through the problem.')}
          />
          <PreferenceToggle
            checked={expandTools}
            onChange={setExpandTools}
            label={t('Expand tool calls by default')}
            hint={t("Show each tool's full input and result instead of a one-line summary.")}
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
  const t = useT();
  const doctorQuery = useQuery({
    queryKey: ['doctor'],
    queryFn: () => api.doctor(),
    enabled: false,
  });

  return (
    <Card>
      <CardHeader
        title={t('Doctor')}
        description={t(
          'Every self-check the system knows how to run — database, audit chain, vault, disk, CLI, automations.',
        )}
        actions={
          <Button
            variant="secondary"
            size="sm"
            loading={doctorQuery.isFetching}
            onClick={() => void doctorQuery.refetch()}
          >
            {t('Run checks')}
          </Button>
        }
      />
      <div className="px-4 pb-4">
        {doctorQuery.data ? (
          <DoctorReportView report={doctorQuery.data} />
        ) : doctorQuery.isError ? (
          <p className="text-[12.5px] text-muted">{t('The examination could not run.')}</p>
        ) : (
          <p className="text-[12.5px] text-subtle">{t('Not run yet.')}</p>
        )}
      </div>
    </Card>
  );
}

function SystemCard() {
  const t = useT();
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
        <Stat label={t('Version')} value={data.version} />
        <Stat label={t('Uptime')} value={formatDuration(data.uptimeMs)} />
        {/* The clock every cron expression is read in. A schedule typed for
            eight on a UTC host fired at ten in Paris, and nothing said which. */}
        <Stat label={t('Server timezone')} value={data.timezone} hint={t('Cron schedules are read in it.')} />
      </div>
      {/* The same three meters the dashboard shows, from the same payload.
          Two separate renderings of "how full is the disk" would eventually
          disagree, and the one nobody is looking at would be the wrong one. */}
      <ResourceMeters resources={data.resources} />

      <Card>
        <CardHeader title={t(
          'Claude CLI',
        )} description={t('Every agent run goes through this binary.')} />
        <dl className="divide-y divide-[var(--mc-border)]">
          <Row label={t('Available')}>
            {data.claudeCli.available ? (
              <Badge tone="success">{t('yes')}</Badge>
            ) : (
              <Badge tone="danger">{t('not found')}</Badge>
            )}
          </Row>
          <Row label={t('Version')}>{data.claudeCli.version ?? '—'}</Row>
          <Row label={t('Authentication')}>
            <div className="flex flex-wrap items-center gap-2">
              {data.claudeCli.authMode === 'subscription' ? (
                <Badge tone="success">{t('subscription (Pro / Max)')}</Badge>
              ) : data.claudeCli.authMode === 'api_key' ? (
                <Badge tone="warning">{t('API key (pay as you go)')}</Badge>
              ) : (
                <Badge tone="danger">{t('none configured')}</Badge>
              )}
              {data.claudeCli.authHint ? (
                <code className="font-mono text-[12px] text-muted">{data.claudeCli.authHint}</code>
              ) : null}
              {data.claudeCli.authSource ? (
                <span className="text-[12px] text-subtle">
                  {data.claudeCli.authSource === 'stored'
                    ? t('paired here')
                    : data.claudeCli.authSource === 'cli-login'
                      ? t('CLI account sign-in')
                      : t('from the environment')}
                </span>
              ) : null}
            </div>
          </Row>
        </dl>
      </Card>

      <ClaudeCredentialCard />

      <NotificationsCard />

      <Card>
        <CardHeader title={t('Kernel')} />
        <dl className="divide-y divide-[var(--mc-border)]">
          <Row label={t('Active runs')}>{data.activeRuns}</Row>
          <Row label={t('Queued runs')}>{data.queuedRuns}</Row>
          <Row label={t('Stored memories')}>{data.memoryCount}</Row>
          <Row label={t('Retrieval')}>
            <RetrievalStatus status={data.retrieval} />
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
  const t = useT();
  const [verifying, setVerifying] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['audit'],
    queryFn: () => api.audit({ limit: 200 }),
  });

  const verify = useMutation({
    mutationFn: () => api.verifyAudit(),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success(t('Chain intact across {n} entries.', { n: result.entries }));
      } else {
        toast.error(t(
          'Chain broken at entry {id}. The log may have been altered.',
          { id: result.brokenAt ?? '?' },
        ));
      }
      setVerifying(false);
    },
    onError: () => {
      toast.error(t('Could not verify the chain.'));
      setVerifying(false);
    },
  });

  const entries = data?.entries ?? [];

  return (
    <Card>
      <CardHeader
        title={t('Audit log')}
        description={t(
          'Every entry commits to the hash of the one before it, so an edit anywhere invalidates everything after.',
        )}
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
            {t('Verify chain')}
          </Button>
        }
      />

      {isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState title={t('No entries')} />
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
function describeUserAgent(userAgent: string | null, t: TranslateFn): string {
  if (!userAgent) return t('Unknown device');

  const browser =
    /Firefox\/[\d.]+/.test(userAgent)
      ? 'Firefox'
      : /Edg\//.test(userAgent)
        ? 'Edge'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : t('Browser');

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
            : t('Unknown');

  // The platform names are proper nouns and stay as they are; only the
  // joining word is copy.
  return t('{browser} on {platform}', { browser, platform });
}
