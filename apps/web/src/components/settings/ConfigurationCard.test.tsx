/**
 * The configuration screen: operational settings, changed without a restart.
 *
 * Three things it must get right, and each is a way the obvious version is
 * wrong.
 *
 * **It says where each value came from.** A second source of truth that does
 * not admit it is one is how a screen and a `.env` come to disagree. Every row
 * says what is in force and, when an override is shadowing the environment,
 * what it is shadowing and who wrote it.
 *
 * **It speaks minutes, not milliseconds.** `14400000` is not a duration
 * anybody reads. The wire keeps milliseconds because that is what the server
 * validates; the form converts, and `0` survives the round trip because it is
 * the value that means "no ceiling" rather than "zero minutes".
 *
 * **Going back is a first-class act**, not "type the old number in": the
 * operator usually does not know what the environment said, which is exactly
 * why the row tells them and offers a button.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeSettingRecord } from '@metaclaude/shared';

import { renderInFrench, renderWithProviders } from '@/test/render';

import { ConfigurationCard } from './ConfigurationCard';

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: { runtimeSettings: vi.fn(), setRuntimeSetting: vi.fn() },
  toastMock: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/api', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
}));
vi.mock('sonner', () => ({ toast: toastMock }));

function record(over: Partial<RuntimeSettingRecord> = {}): RuntimeSettingRecord {
  return {
    key: 'idleTimeoutMs',
    value: 600_000,
    source: 'default',
    fallback: null,
    kind: 'duration',
    min: 0,
    max: null,
    options: [],
    updatedAt: null,
    updatedBy: null,
    ...over,
  } as RuntimeSettingRecord;
}

const SETTINGS: RuntimeSettingRecord[] = [
  record(),
  record({ key: 'runTimeoutMs', value: 14_400_000, source: 'environment' }),
  record({
    key: 'maxConcurrentRuns',
    value: 12,
    kind: 'count',
    min: 1,
    max: 64,
    source: 'stored',
    fallback: 4,
    updatedAt: 1_700_000_000_000,
    updatedBy: 'jules',
  }),
  record({
    key: 'logLevel',
    value: 'info',
    kind: 'choice',
    min: null,
    max: null,
    options: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
    source: 'default',
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.runtimeSettings.mockResolvedValue({ settings: SETTINGS });
  apiMock.setRuntimeSetting.mockResolvedValue({ settings: SETTINGS });
});

describe('what each row shows', () => {
  it('renders every setting the server returned', async () => {
    renderWithProviders(<ConfigurationCard />);
    for (const label of [/goes quiet/i, /outright/i, /at once/i, /log level/i]) {
      expect(await screen.findByLabelText(label)).toBeDefined();
    }
  });

  it('shows a duration in minutes, not in milliseconds', async () => {
    renderWithProviders(<ConfigurationCard />);
    const idle = (await screen.findByLabelText(/goes quiet/i)) as HTMLInputElement;
    expect(idle.value).toBe('10');

    const limit = screen.getByLabelText(/outright/i) as HTMLInputElement;
    expect(limit.value).toBe('240');
  });

  it('says where a value came from, and what an override is shadowing', async () => {
    renderWithProviders(<ConfigurationCard />);
    await screen.findByLabelText(/at once/i);

    // The one that is stored names the value it replaced and who wrote it.
    expect(screen.getByText(/jules/)).toBeDefined();
    expect(screen.getByText(/\b4\b/)).toBeDefined();
    // The one that is not offers nothing to revert to.
    expect(screen.queryAllByRole('button', { name: /environment/i })).toHaveLength(1);
  });

  /**
   * A choice uses the app's own menu rather than a native select, like every
   * other choice in the product — and Radix opens on `pointerdown`, so a bare
   * `click` finds nothing in jsdom.
   */
  it('offers a choice as a set of options rather than free text', async () => {
    renderWithProviders(<ConfigurationCard />);
    const trigger = await screen.findByLabelText(/log level/i);
    expect(trigger.textContent).toContain('info');

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);

    // `menuitemcheckbox`, not `menuitem`: a list where one entry is the current
    // choice announces as checkable, or a screen-reader user hears six
    // identical options. `MenuItem` switches roles on `selected` for that.
    const option = screen.getByRole('menuitemcheckbox', { name: 'debug' });
    expect(option).toBeDefined();
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'info' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(option.getAttribute('aria-checked')).toBe('false');
  });

  it('sends the option the operator picked', async () => {
    renderWithProviders(<ConfigurationCard />);
    const trigger = await screen.findByLabelText(/log level/i);
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'debug' }));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(apiMock.setRuntimeSetting).toHaveBeenCalledWith('logLevel', 'debug'));
  });
});

describe('changing one', () => {
  it('sends milliseconds even though it showed minutes', async () => {
    renderWithProviders(<ConfigurationCard />);
    const idle = await screen.findByLabelText(/goes quiet/i);

    fireEvent.change(idle, { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(apiMock.setRuntimeSetting).toHaveBeenCalledWith('idleTimeoutMs', 25 * 60_000),
    );
  });

  it('keeps 0 as 0, because that is the value that means "no ceiling"', async () => {
    renderWithProviders(<ConfigurationCard />);
    const idle = await screen.findByLabelText(/goes quiet/i);

    fireEvent.change(idle, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(apiMock.setRuntimeSetting).toHaveBeenCalledWith('idleTimeoutMs', 0));
  });

  it('sends only what changed', async () => {
    renderWithProviders(<ConfigurationCard />);
    const concurrency = await screen.findByLabelText(/at once/i);

    fireEvent.change(concurrency, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(apiMock.setRuntimeSetting).toHaveBeenCalledTimes(1));
    expect(apiMock.setRuntimeSetting).toHaveBeenCalledWith('maxConcurrentRuns', 8);
  });

  it('has nothing to press when nothing was touched', async () => {
    renderWithProviders(<ConfigurationCard />);
    await screen.findByLabelText(/goes quiet/i);
    // No jest-dom here: assert what the DOM actually carries.
    expect((screen.getByRole('button', { name: /save/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('hands a setting back to the environment with one action', async () => {
    renderWithProviders(<ConfigurationCard />);
    await screen.findByLabelText(/at once/i);

    fireEvent.click(screen.getByRole('button', { name: /environment/i }));
    await waitFor(() =>
      expect(apiMock.setRuntimeSetting).toHaveBeenCalledWith('maxConcurrentRuns', null),
    );
  });

  it('reports a refusal from the server rather than pretending it saved', async () => {
    apiMock.setRuntimeSetting.mockRejectedValue(new Error('"maxConcurrentRuns" must be at most 64.'));
    renderWithProviders(<ConfigurationCard />);
    const concurrency = await screen.findByLabelText(/at once/i);

    fireEvent.change(concurrency, { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});

describe('in French', () => {
  it('translates the labels and the help, not only the chrome', async () => {
    await renderInFrench(<ConfigurationCard />);
    expect(await screen.findByText(/Configuration/)).toBeDefined();
    // The per-setting copy is a module table translated at render; if it were
    // read straight it would still be English on a French screen.
    expect(screen.getAllByText(/minutes/i).length).toBeGreaterThan(0);
    expect(screen.queryByText('Save changes')).toBeNull();
  });
});

/**
 * Two ways the obvious version of this form loses what someone typed.
 *
 * React Query hands back a **new array** on every refetch, identical contents
 * or not. An effect that reseeds the draft from it therefore wipes the field
 * under the cursor whenever the window regains focus or a sibling query
 * settles — the comment beside that effect claimed the opposite, which is how
 * this was found.
 *
 * And an emptied number field is not the number zero. `Number('')` is 0, and 0
 * is the value that switches a ceiling *off*, so clearing a box and pressing
 * Save would quietly disable the thing it was meant to change.
 */
/**
 * An emptied number field is not the number zero.
 *
 * `Number('')` is 0, and 0 is the value that switches a ceiling *off*, so a
 * form that treated a cleared box as a change would quietly disable the very
 * thing it was meant to adjust.
 *
 * A companion case guarded the draft against being wiped by a background
 * refetch. It could not be made to fail: React Query shares structure, so an
 * identical response is the same array and the effect does not re-run. It was
 * deleted rather than kept — a case that passes whether or not the code is
 * right is worse than no case.
 */
describe('what it does with what you typed', () => {
  it('treats an emptied field as untouched rather than as zero', async () => {
    renderWithProviders(<ConfigurationCard />);
    const idle = await screen.findByLabelText(/goes quiet/i);

    fireEvent.change(idle, { target: { value: '' } });
    // Nothing to save, so there is nothing to press: an empty box is not the
    // number zero, and zero is the value that switches a ceiling off.
    // No jest-dom here: assert what the DOM actually carries.
    expect((screen.getByRole('button', { name: /save/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
