/**
 * The screen that decides which of the CLI's own tools the agent has.
 *
 * What is worth pinning here is not that a list renders. It is the four ways
 * this screen could quietly mislead: a checkbox that saves the opposite of
 * what it shows, a tool that cannot be un-refused because it is not on the
 * list, an empty list read as "the CLI offers nothing", and `ToolSearch`
 * offered as an ordinary switch when turning it off is a fifteen-thousand
 * token regression on every run.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CliSkillRecord,
  CliSkillsReport,
  CliToolRecord,
  CliToolsReport,
} from '@metaclaude/shared';

import { renderWithProviders } from '@/test/render';

import { CliToolsPage } from './CliToolsPage';

const { apiMock, toastMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  apiMock: { cliTools: vi.fn(), setCliTools: vi.fn(), cliSkills: vi.fn(), setCliSkills: vi.fn() },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('sonner', () => ({ toast: toastMock }));

/** Built from the contract's own shape rather than typed from memory. */
const tool = (name: string, over: Partial<CliToolRecord> = {}): CliToolRecord => ({
  name,
  disabled: false,
  offered: true,
  locked: null,
  ...over,
});

const report = (over: Partial<CliToolsReport> = {}): CliToolsReport => ({
  tools: [tool('Bash'), tool('Artifact', { disabled: true })],
  source: 'default',
  probed: true,
  seenAt: 1_700_000_000_000,
  ...over,
});

const skill = (name: string, over: Partial<CliSkillRecord> = {}): CliSkillRecord => ({
  name,
  enabled: false,
  offered: true,
  tokens: 202,
  ...over,
});

const skillsReport = (over: Partial<CliSkillsReport> = {}): CliSkillsReport => ({
  skills: [skill('code-review'), skill('dataviz', { tokens: 362 })],
  source: 'default',
  probed: true,
  ...over,
});

/** The checkbox for one tool. Its accessible name is the tool's own name. */
const boxFor = (name: string): HTMLInputElement =>
  screen.getByRole('checkbox', { name }) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.cliTools.mockResolvedValue(report());
  apiMock.cliSkills.mockResolvedValue(skillsReport());
  apiMock.setCliSkills.mockImplementation(async (enabled: string[] | null) =>
    skillsReport({
      source: enabled && enabled.length > 0 ? 'stored' : 'default',
      skills: [
        skill('code-review', { enabled: (enabled ?? []).includes('code-review') }),
        skill('dataviz', { tokens: 362, enabled: (enabled ?? []).includes('dataviz') }),
      ],
    }),
  );
  apiMock.setCliTools.mockImplementation(async (disabled: string[] | null) =>
    report({
      source: disabled === null ? 'default' : 'stored',
      tools: [
        tool('Bash', { disabled: (disabled ?? []).includes('Bash') }),
        tool('Artifact', { disabled: (disabled ?? ['Artifact']).includes('Artifact') }),
      ],
    }),
  );
});

describe('CliToolsPage', () => {
  it('shows a refused tool as switched off and an allowed one as on', async () => {
    renderWithProviders(<CliToolsPage />);

    await waitFor(() => expect(boxFor('Bash')).toBeTruthy());
    // Ticked means the agent *has* it, which is the way round an operator
    // reads a capability list. The stored value is the complement.
    expect(boxFor('Bash').checked).toBe(true);
    expect(boxFor('Artifact').checked).toBe(false);
  });

  it('saves the whole refused set, not just the tool that moved', async () => {
    renderWithProviders(<CliToolsPage />);
    await waitFor(() => expect(boxFor('Bash')).toBeTruthy());

    fireEvent.click(boxFor('Bash'));

    // `Artifact` was already off and has to stay off: a PUT carrying only the
    // tool that changed would switch it back on as a side effect of an
    // unrelated click.
    await waitFor(() => expect(apiMock.setCliTools).toHaveBeenCalledWith(['Artifact', 'Bash']));
  });

  it('turns a refused tool back on by removing it from the set', async () => {
    renderWithProviders(<CliToolsPage />);
    await waitFor(() => expect(boxFor('Artifact')).toBeTruthy());

    fireEvent.click(boxFor('Artifact'));

    await waitFor(() => expect(apiMock.setCliTools).toHaveBeenCalledWith([]));
  });

  /**
   * `ToolSearch` is how the CLI keeps every other tool's schema out of the
   * prompt. Measured: refusing it takes the in-window system-tool figure from
   * 23,543 tokens to 39,045, on every run, announced by nothing. It is on the
   * list — hiding it would be its own kind of lie — and it cannot be clicked.
   */
  it('shows ToolSearch and refuses to let it be switched off', async () => {
    apiMock.cliTools.mockResolvedValue(
      report({ tools: [tool('ToolSearch', { locked: 'is how the CLI loads every other tool' })] }),
    );
    renderWithProviders(<CliToolsPage />);

    await waitFor(() => expect(boxFor('ToolSearch')).toBeTruthy());
    expect(boxFor('ToolSearch').disabled).toBe(true);

    fireEvent.click(boxFor('ToolSearch'));
    expect(apiMock.setCliTools).not.toHaveBeenCalled();
  });

  /**
   * A tool with nothing to say about it must not be *described by nothing*.
   *
   * `CheckboxField` renders its hint into a `<span>` and points
   * `aria-describedby` at it, and its own comment says why an empty one is
   * worse than none: the reader announces the name and then silence. A
   * fragment is truthy, so composing the hint out of two conditionals hands it
   * an empty element for any tool this screen has no note for — which is every
   * tool the CLI adds after today, since the list is measured and the notes
   * are written.
   */
  it('describes a tool by nothing rather than by an empty hint', async () => {
    apiMock.cliTools.mockResolvedValue(report({ tools: [tool('BrandNewTool')] }));
    renderWithProviders(<CliToolsPage />);

    await waitFor(() => expect(boxFor('BrandNewTool')).toBeTruthy());
    expect(boxFor('BrandNewTool').getAttribute('aria-describedby')).toBeNull();
  });

  it('still describes a tool it does have a note for', async () => {
    renderWithProviders(<CliToolsPage />);

    await waitFor(() => expect(boxFor('Bash')).toBeTruthy());
    const describedBy = boxFor('Bash').getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toContain('shell');
  });

  /**
   * A refused tool the CLI has stopped offering still has a row, or it is
   * unclearable — the operator cannot untick what is not on the screen. The
   * badge is what stops that row reading as a capability the agent has.
   */
  it('marks a refused tool the CLI no longer offers', async () => {
    apiMock.cliTools.mockResolvedValue(
      report({ tools: [tool('LegacyThing', { disabled: true, offered: false })] }),
    );
    renderWithProviders(<CliToolsPage />);

    await waitFor(() => expect(boxFor('LegacyThing')).toBeTruthy());
    expect(screen.getByText('No longer offered')).toBeTruthy();
  });

  /**
   * "The CLI offers no tools" is never true. A screen that rendered an empty
   * list would be describing a state that cannot exist, so it says instead
   * that the question could not be asked.
   */
  /**
   * The offering is learned from runs — the CLI names its tools only on the
   * frame it emits with a first message, so no probe can ask. Before a run
   * has reported, the honest sentence is "not yet", not "the CLI failed":
   * the first version said the latter, in production, above a Skills section
   * that had answered fine.
   */
  it('says no run has reported yet rather than blaming the CLI', async () => {
    apiMock.cliTools.mockResolvedValue(report({ tools: [], probed: false, seenAt: null }));
    renderWithProviders(<CliToolsPage />);

    await waitFor(() =>
      expect(screen.getByText('No run has reported what the CLI offers yet')).toBeTruthy(),
    );
  });

  it('warns that the list is only what the deployment refuses until a run reports', async () => {
    apiMock.cliTools.mockResolvedValue(
      report({
        tools: [tool('Artifact', { disabled: true, offered: false })],
        probed: false,
        seenAt: null,
      }),
    );
    renderWithProviders(<CliToolsPage />);

    await waitFor(() => expect(boxFor('Artifact')).toBeTruthy());
    expect(screen.getByText(/only what the deployment refuses/)).toBeTruthy();
  });

  it('says when the last run saw the offering', async () => {
    renderWithProviders(<CliToolsPage />);

    await waitFor(() => expect(boxFor('Bash')).toBeTruthy());
    expect(screen.getByText(/As the CLI offered them to the last run/)).toBeTruthy();
  });

  /**
   * Provenance, for the reason the runtime settings report theirs: a screen
   * that showed the shipped default as though somebody had chosen it describes
   * a decision nobody made, and offers to undo something that was never done.
   */
  it('offers to restore the defaults only once something has been chosen', async () => {
    renderWithProviders(<CliToolsPage />);
    await waitFor(() => expect(boxFor('Bash')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Restore defaults' })).toBeNull();

    apiMock.cliTools.mockResolvedValue(report({ source: 'stored' }));
    renderWithProviders(<CliToolsPage />);

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Restore defaults' }).length).toBeGreaterThan(0),
    );
  });

  it('hands the list back to the default when asked', async () => {
    apiMock.cliTools.mockResolvedValue(report({ source: 'stored' }));
    renderWithProviders(<CliToolsPage />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore defaults' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }));

    await waitFor(() => expect(apiMock.setCliTools).toHaveBeenCalledWith(null));
  });

  it('reports a refusal from the server rather than swallowing it', async () => {
    apiMock.setCliTools.mockRejectedValue(new Error('nope'));
    renderWithProviders(<CliToolsPage />);
    await waitFor(() => expect(boxFor('Bash')).toBeTruthy());

    fireEvent.click(boxFor('Bash'));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
  });

  /* ---------------------------- The CLI's skills --------------------------- */

  /**
   * The CLI's own skills, in the same register as the tools above them: a box
   * each, off unless chosen. What is pinned is what an operator could be
   * misled about — that ticking one saves the whole chosen set, that the cost
   * is shown so the choice is informed, and that a chosen skill the CLI has
   * since dropped stays on the screen or it can never be unchosen.
   */
  it('lists the CLI’s skills switched off, with what each would cost', async () => {
    renderWithProviders(<CliToolsPage />);

    await waitFor(() => expect(boxFor('dataviz')).toBeTruthy());
    expect(boxFor('dataviz').checked).toBe(false);
    expect(boxFor('code-review').checked).toBe(false);
    const describedBy = boxFor('dataviz').getAttribute('aria-describedby');
    expect(document.getElementById(describedBy as string)?.textContent).toContain('362');
  });

  it('saves the whole chosen set when one skill is switched on', async () => {
    apiMock.cliSkills.mockResolvedValue(
      skillsReport({ source: 'stored', skills: [skill('code-review', { enabled: true }), skill('dataviz')] }),
    );
    renderWithProviders(<CliToolsPage />);
    await waitFor(() => expect(boxFor('dataviz')).toBeTruthy());

    fireEvent.click(boxFor('dataviz'));

    // `code-review` was already on and has to stay on: a PUT naming only the
    // box that moved would switch it back off as a side effect.
    await waitFor(() => expect(apiMock.setCliSkills).toHaveBeenCalledWith(['code-review', 'dataviz']));
  });

  it('offers to go back to none only once something is chosen', async () => {
    renderWithProviders(<CliToolsPage />);
    await waitFor(() => expect(boxFor('dataviz')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Offer none' })).toBeNull();

    apiMock.cliSkills.mockResolvedValue(
      skillsReport({ source: 'stored', skills: [skill('dataviz', { enabled: true })] }),
    );
    renderWithProviders(<CliToolsPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Offer none' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Offer none' }));
    await waitFor(() => expect(apiMock.setCliSkills).toHaveBeenCalledWith(null));
  });

  it('keeps a chosen skill the CLI no longer ships, and says so', async () => {
    apiMock.cliSkills.mockResolvedValue(
      skillsReport({
        source: 'stored',
        skills: [skill('retired', { enabled: true, offered: false, tokens: null })],
      }),
    );
    renderWithProviders(<CliToolsPage />);

    await waitFor(() => expect(boxFor('retired')).toBeTruthy());
    expect(boxFor('retired').checked).toBe(true);
    // No cost to show, so no description at all — not an empty one.
    expect(boxFor('retired').getAttribute('aria-describedby')).toBeNull();
    expect(screen.getAllByText('No longer offered').length).toBeGreaterThan(0);
  });

  it('says the CLI could not be asked about its skills rather than showing none', async () => {
    apiMock.cliSkills.mockResolvedValue(skillsReport({ skills: [], probed: false }));
    renderWithProviders(<CliToolsPage />);

    await waitFor(() =>
      expect(screen.getByText('The CLI could not be asked which skills it ships')).toBeTruthy(),
    );
  });
});
