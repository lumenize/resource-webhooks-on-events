// Matching a uri against a template, which tells A which listed uri-specification covers a
// resource, and so its timeline (R1), and a template against a template, which tells A whether a
// listed one covers every uri a client's could match (R24). RFC 6570 defines expanding a template,
// not matching one, so A matches a simple `{name}` as exactly one path segment and a reserved
// expansion `{+name}` as one or more characters, slashes included, and refuses a template with
// any other expression.
//
// A match walks every position in the template at once, so it costs the uri's length times the
// template's, whatever the template. A regular expression would backtrack, and a template such as
// `{+a}{+b}…{+j}!` would stall every match against it.

// RFC 6570's varname, without percent-encoding.
const VARNAME = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

// One step of a template: a literal character, one character of an expression's class, or more
// of that class. An expression is a `one` and then a `more`.
type Step = { kind: 'char'; char: string } | { kind: 'one' | 'more'; slashes: boolean };

// What a match walks over: a uri's characters, or a template's sample, whose stand-ins are each
// one token, `seg` for a `{name}` and `any` for a `{+name}`, so a literal never matches one.
type Token = { kind: 'char'; char: string } | { kind: 'seg' | 'any' };

/** A test of whether a template matches a uri, or undefined for a template A does not match. */
export function templateMatcher(template: string): ((uri: string) => boolean) | undefined {
  const steps = stepsOf(template);
  return steps && ((uri) => matches(steps, [...uri].map((char) => ({ kind: 'char', char }))));
}

/**
 * Whether the listed template matches every uri the client's could, by matching the client's
 * sample against it, as R24's pseudo-code does: a literal in `listed` never matches a stand-in, a
 * `{name}` matches `SEG` but not `ANY`, since `ANY` may hold a slash, and a `{+name}` matches both.
 * It costs what matching a uri as long as the sample costs. False for a template A does not match.
 */
export function templateCovers(listed: string, client: string): boolean {
  const steps = stepsOf(listed);
  const sample = stepsOf(client)?.flatMap((step): Token[] => (step.kind === 'char' ? [step] : step.kind === 'one' ? [{ kind: step.slashes ? 'any' : 'seg' }] : []));
  return steps !== undefined && sample !== undefined && matches(steps, sample);
}

function stepsOf(template: string): Step[] | undefined {
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
  return steps;
}

/** The literal text of a uri-specification up to its first expression, all of it for a uri. */
export function literalPrefix(specification: string): string {
  const open = specification.indexOf('{');
  return open === -1 ? specification : specification.slice(0, open);
}

function matches(steps: Step[], tokens: Token[]): boolean {
  let states = closure(steps, [0]);
  for (const token of tokens) {
    const next: number[] = [];
    for (const state of states) {
      const step = steps[state];
      if (step === undefined || !accepts(step, token)) continue;
      next.push(step.kind === 'more' ? state : state + 1);
    }
    if (next.length === 0) return false;
    states = closure(steps, next);
  }
  return states.has(steps.length);
}

function accepts(step: Step, token: Token): boolean {
  if (step.kind === 'char') return token.kind === 'char' && token.char === step.char;
  if (step.slashes) return true;
  return token.kind === 'seg' || (token.kind === 'char' && token.char !== '/');
}

// The states reachable without a character, since a `more` may match none.
function closure(steps: Step[], from: number[]): Set<number> {
  const states = new Set(from);
  for (const state of states) if (steps[state]?.kind === 'more') states.add(state + 1);
  return states;
}
