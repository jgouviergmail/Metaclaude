import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { extractPlainText } from './text.js';

const read = (name: string, mime: string, data: Buffer | string) =>
  extractPlainText({ name, mime, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') });

describe('extractPlainText', () => {
  it('keeps markdown exactly as written — its headings are already sections', () => {
    const markdown = readFileSync(new URL('./fixtures/sample.md', import.meta.url));
    const { text, pageUnit, pageBreaks } = read('sample.md', 'text/markdown', markdown);
    expect(text).toContain('# Conventions');
    expect(text).toContain('## Commits');
    expect(pageUnit).toBeNull();
    expect(pageBreaks).toEqual([]);
  });

  it('normalises CRLF and a run of blank lines', () => {
    expect(read('a.txt', 'text/plain', 'Un.\r\n\r\n\r\n\r\nDeux.\r\n').text).toBe('Un.\n\nDeux.');
  });

  it('drops a byte order mark rather than leaving it inside the first word', () => {
    expect(read('a.txt', 'text/plain', '﻿Début').text).toBe('Début');
  });

  it('gives minified JSON lines to be cited by', () => {
    // One line of ten thousand characters is a document with no locations at
    // all: every passage would start and end mid-key.
    const { text } = read('a.json', 'application/json', '{"a":1,"b":{"c":[1,2]}}');
    expect(text.split('\n').length).toBeGreaterThan(3);
    expect(text).toContain('"c": [');
  });

  it('leaves a .json that is not JSON alone, rather than refusing it', () => {
    expect(read('a.json', 'application/json', 'pas du json {').text).toBe('pas du json {');
  });

  it('does not reformat a .txt that happens to look like JSON', () => {
    expect(read('a.txt', 'text/plain', '{"a":1}').text).toBe('{"a":1}');
  });
});
