import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// An unclosed rule silently swallows every later rule, including the mobile media
// queries; the page then renders the desktop grid on a phone. Fail fast instead.
describe('stylesheets', () => {
  it.each(['src/styles.css', 'src/workspace.css'])('%s has balanced braces outside comments', (file) => {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0;
    for (const char of css) {
      if (char === '{') depth++;
      if (char === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});
