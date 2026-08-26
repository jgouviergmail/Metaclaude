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
import { Input, Label } from './primitives';

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
