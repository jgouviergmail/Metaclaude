/**
 * Form primitives, tested for the one property that is invisible on screen.
 *
 * A labelled control's accessible name is the text content of its labelling
 * element. Anything inside the `<label>` that is not the control itself becomes
 * part of that name — so an explanatory hint nested there is read out in full
 * every time focus lands on the field, and voice control has no short phrase to
 * target. Nothing about that shows up in a screenshot, and `Label` had no test.
 */

import { fireEvent, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders as render } from '@/test/render';
import { CardHeader, Input, Label, Meter, Select, Textarea } from './primitives';

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

/**
 * The heading level of a card.
 *
 * `PageHeader` renders the page's `h1`; a card sitting directly under it is
 * therefore a first-rank section. Rendering an `h3` skipped a level on every
 * screen at once — measured at 24 skips across both languages and all three
 * widths, which is a wrong outline for anyone navigating by headings.
 */
describe('the heading level of a card', () => {
  it('is h2 by default, so a card under the page h1 skips nothing', () => {
    render(<CardHeader title="Configuration" />);
    expect(screen.getByRole('heading', { name: 'Configuration', level: 2 })).toBeDefined();
  });

  it('steps down when the card really is nested under a section', () => {
    render(<CardHeader title="Password" level={3} />);
    expect(screen.getByRole('heading', { name: 'Password', level: 3 })).toBeDefined();
  });
});

/**
 * The native select, which the app had rewritten eight times.
 *
 * Three files carried the same class string —
 * `h-9 w-full rounded-lg border border-line bg-surface px-3 …` — beside an
 * `Input` that already said exactly that. Eight places to change when the
 * focus ring moves, and eight chances to forget one; the form family is one
 * shape and belongs in one place.
 */
describe('Select', () => {
  it('is the same box as an Input, so a form does not look assembled', () => {
    render(
      <>
        <Input aria-label="texte" />
        <Select aria-label="choix">
          <option value="a">A</option>
        </Select>
      </>,
    );
    const input = screen.getByLabelText('texte').className;
    const select = screen.getByLabelText('choix').className;
    for (const token of ['h-9', 'w-full', 'rounded-lg', 'border-line', 'bg-surface', 'px-3']) {
      expect(select, token).toContain(token);
      expect(input, token).toContain(token);
    }
  });

  it('behaves like a select, not merely like a box', () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="choix" value="a" onChange={onChange}>
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    );
    fireEvent.change(screen.getByLabelText('choix'), { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalled();
  });

  it('takes a ref, since a form may need to focus it', () => {
    const ref = createRef<HTMLSelectElement>();
    render(
      <Select aria-label="choix" ref={ref}>
        <option value="a">A</option>
      </Select>,
    );
    expect(ref.current?.tagName).toBe('SELECT');
  });
});

/**
 * The form family sits on the scale, not on a literal.
 *
 * `text-sm` is 14px whatever the density, so an operator who asked for a
 * compact interface still got a comfortable form. The role follows the
 * setting — 13px compact, 14px comfortable — which is the whole point of
 * having roles.
 */
describe('the form controls', () => {
  it('take their size from the scale', () => {
    render(
      <>
        <Input aria-label="texte" />
        <Textarea aria-label="paragraphe" />
        <Select aria-label="choix">
          <option value="a">A</option>
        </Select>
      </>,
    );
    for (const name of ['texte', 'paragraphe', 'choix']) {
      const className = screen.getByLabelText(name).className;
      expect(className, name).toContain('text-body');
      expect(className, name).not.toContain('text-sm');
    }
  });
});
