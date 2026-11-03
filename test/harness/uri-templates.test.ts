// How long a template match takes, which only Node can time: inside workerd the clock stands
// still while synchronous code runs. Every write matches its uri against the listed templates,
// and a later phase matches templates a client names.
import { describe, expect, it } from 'vitest';
import { templateCovers, templateMatcher } from '../../src/server-role/uri-templates';

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

describe("R24's check, that a listed template covers every uri a client's could match", () => {
  it('answers the table in § A template the server does not list', () => {
    const rows: [string, string, boolean][] = [
      ['skill://{skill}/{+path}', 'skill://code-review/{+path}', true],
      ['skill://{skill}/{+path}', 'skill://code-review/scripts/{+file}', true],
      ['{type}/{id}', 'tickets/{id}', true],
      ['tickets/{id}', 'tickets/{+rest}', false],
    ];
    expect(rows.map(([listed, client]) => [listed, client, templateCovers(listed, client)])).toEqual(rows);
  });

  it('never matches a stand-in with a listed literal spelled like one', () => {
    expect(templateCovers('tickets/SEG', 'tickets/{id}')).toBe(false);
    // A one-character literal is where a stand-in, one token, could slip through.
    expect(templateCovers('tickets/x', 'tickets/{id}')).toBe(false);
    expect(templateCovers('tickets/ANY', 'tickets/{+rest}')).toBe(false);
    expect(templateCovers('tickets/SEG', 'tickets/SEG')).toBe(true);
  });

  it('refuses a template A cannot match, on either side', () => {
    expect([templateCovers('tickets/{id', 'tickets/{id}'), templateCovers('tickets/{id}', 'tickets/{?id}')]).toEqual([false, false]);
  });
});
