// How long a template match takes, which only Node can time: inside workerd the clock stands
// still while synchronous code runs. Every write matches its uri against the listed templates,
// and a later phase matches templates a client names.
import { describe, expect, it } from 'vitest';
import { templateMatcher } from '../../src/server-role/uri-templates';

describe("a template's match", () => {
  it('takes time in proportion to the uri, however many expressions sit side by side', () => {
    // A backtracking regular expression took 1.5 seconds for this, and five times that with one
    // more expression.
    const matcher = templateMatcher('https://a.example/notes/{+a}{+b}{+c}{+d}!')!;
    const uri = `https://a.example/notes/${'x'.repeat(400)}`;
    const started = performance.now();
    expect(matcher(uri)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
    expect(matcher(`https://a.example/notes/${'x'.repeat(400)}!`)).toBe(true);
  });

  it("takes RFC 6570's dotted variable names, as in {type.name}", () => {
    expect(templateMatcher('https://a.example/{type.name}/archive')?.('https://a.example/notes/archive')).toBe(true);
  });

  it('matches {name} as one segment and {+name} across slashes, and covers nothing beneath a match', () => {
    const simple = templateMatcher('tickets/{id}')!;
    const reserved = templateMatcher('tickets/{+rest}')!;
    expect([simple('tickets/ticket-3'), simple('tickets/ticket-3/x'), simple('tickets/')]).toEqual([true, false, false]);
    expect([reserved('tickets/ticket-3'), reserved('tickets/ticket-3/x')]).toEqual([true, true]);
  });
});
