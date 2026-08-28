/**
 * Form primitives, tested for the one property that is invisible on screen.
 *
 * A labelled control's accessible name is the text content of its labelling
 * element. Anything inside the `<label>` that is not the control itself becomes
 * part of that name — so an explanatory hint nested there is read out in full
 * every time focus lands on the field, and voice control has no short phrase to
 * target. Nothing about that shows up in a screenshot, and `Label` had no test.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders as render } from '@/test/render';
import { Input, Label, Meter } from './primitives';

describe('Label', () => {
  it('keeps the hint out of the field name', () => {
    render(
      <Label htmlFor="skill-name" hint="Lowercase and dashes; this is the directory name.">
        Name
        <Input id="skill-name" defaultValue="" />
      </Label>,
    );

    // The field is findable by its short name alone, which is only true when
    // the hint is not concatenated into it.
    const input = screen.getByLabelText('Name');
    expect(input.id).toBe('skill-name');
    expect(screen.queryByLabelText(/directory name/)).toBeNull();
  });

  it('still renders the hint, and gives it an id a caller can describe with', () => {
    render(
      <Label htmlFor="skill-name" hint="Lowercase and dashes.">
        Name
        <Input id="skill-name" defaultValue="" />
      </Label>,
    );
    const hint = screen.getByText('Lowercase and dashes.');
    expect(hint.id).toBe('skill-name-hint');
  });

  it('is announced as a description when the caller opts in', () => {
    render(
      <Label htmlFor="skill-name" hint="Lowercase and dashes.">
        Name
        <Input id="skill-name" aria-describedby="skill-name-hint" defaultValue="" />
      </Label>,
    );
    const input = screen.getByLabelText('Name');
    expect(input.getAttribute('aria-describedby')).toBe('skill-name-hint');
    expect(document.getElementById('skill-name-hint')?.textContent).toBe('Lowercase and dashes.');
  });

  it('works without a hint at all', () => {
    render(
      <Label htmlFor="plain">
        Plain
        <Input id="plain" defaultValue="" />
      </Label>,
    );
    expect(screen.getByLabelText('Plain').id).toBe('plain');
  });
});

/**
 * The meter draws a proportion, and its third state is the interesting one.
 *
 * "No reading" is not the same as "zero", and the difference is invisible in a
 * screenshot: an empty track at full strength reads as a gauge parked at the
 * bottom, which is a measurement. The resource meters spend their whole life
 * in that state on a machine without cgroups.
 */
describe('Meter', () => {
  it('fills to the proportion given, and clamps beyond the ends', () => {
    const { container, rerender } = render(<Meter value={0.42} label="Disk 42 %" />);
    expect(screen.getByLabelText('Disk 42 %')).toBeDefined();
    expect(container.querySelector('[style*="width"]')?.getAttribute('style')).toContain('42%');

    rerender(<Meter value={4} label="over" />);
    expect(container.querySelector('[style*="width"]')?.getAttribute('style')).toContain('100%');

    rerender(<Meter value={-1} label="under" />);
    expect(container.querySelector('[style*="width"]')?.getAttribute('style')).toContain('0%');
  });

  it('draws no fill at all — and dims the track — when there is no reading', () => {
    const { container } = render(<Meter value={null} label="CPU —" />);

    expect(container.querySelector('[style*="width"]')).toBeNull();
    expect(screen.getByLabelText('CPU —').className).toContain('opacity-50');
  });

  it('takes its tone from the caller, because the good direction differs', () => {
    // High confidence is good; high memory pressure is bad. The same bar
    // serves both, so it never decides the colour itself.
    const { container, rerender } = render(<Meter value={0.9} tone="success" label="a" />);
    expect(container.querySelector('.bg-success')).not.toBeNull();

    rerender(<Meter value={0.9} tone="danger" label="a" />);
    expect(container.querySelector('.bg-danger')).not.toBeNull();
  });
});
