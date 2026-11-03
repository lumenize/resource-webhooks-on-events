// Matching a uri against a template, which tells A which listed uri-specification covers a
// resource, and so its timeline (R1). RFC 6570 defines expanding a template, not matching one, so
// A matches a simple `{name}` as exactly one path segment and a reserved expansion `{+name}` as
// one or more characters, slashes included, and refuses a template with any other expression.
//
// A match walks every position in the template at once, so it costs the uri's length times the
// template's, whatever the template. A regular expression would backtrack, and a template such as
// `{+a}{+b}…{+j}!` would stall every match against it.

// RFC 6570's varname, without percent-encoding.
const VARNAME = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

// One step of a template: a literal character, one character of an expression's class, or more
// of that class. An expression is a `one` and then a `more`.
type Step = { kind: 'char'; char: string } | { kind: 'one' | 'more'; slashes: boolean };

/** A test of whether a template matches a uri, or undefined for a template A does not match. */
export function templateMatcher(template: string): ((uri: string) => boolean) | undefined {
  const steps: Step[] = [];
  let rest = template;
  for (;;) {
    const open = rest.indexOf('{');
    const literal = open === -1 ? rest : rest.slice(0, open);
    if (literal.includes('}')) return undefined;
    for (const char of literal) steps.push({ kind: 'char', char });
    if (open === -1) break;
    const close = rest.indexOf('}', open);
    if (close === -1) return undefined;
    const expression = rest.slice(open + 1, close);
    const reserved = expression.startsWith('+');
    if (!VARNAME.test(reserved ? expression.slice(1) : expression)) return undefined;
    steps.push({ kind: 'one', slashes: reserved }, { kind: 'more', slashes: reserved });
    rest = rest.slice(close + 1);
  }
  return (uri) => matches(steps, uri);
}

/** The literal text of a uri-specification up to its first expression, all of it for a uri. */
export function literalPrefix(specification: string): string {
  const open = specification.indexOf('{');
  return open === -1 ? specification : specification.slice(0, open);
}

function matches(steps: Step[], uri: string): boolean {
  let states = closure(steps, [0]);
  for (const char of uri) {
    const next: number[] = [];
    for (const state of states) {
      const step = steps[state];
      if (step === undefined || !(step.kind === 'char' ? step.char === char : step.slashes || char !== '/')) continue;
      next.push(step.kind === 'more' ? state : state + 1);
    }
    if (next.length === 0) return false;
    states = closure(steps, next);
  }
  return states.has(steps.length);
}

// The states reachable without a character, since a `more` may match none.
function closure(steps: Step[], from: number[]): Set<number> {
  const states = new Set(from);
  for (const state of states) if (steps[state]?.kind === 'more') states.add(state + 1);
  return states;
}
