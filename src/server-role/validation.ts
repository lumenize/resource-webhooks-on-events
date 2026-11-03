// Runtime validation, derived from TypeScript types only: the spec's schema.json, generated from
// its schema.ts, and this repo's own schema, generated from events-types.ts.
import { Validator, type OutputUnit } from '@cfworker/json-schema';
import eventsSchema from '../events-types.schema.json';
import specSchema from '../vendor/mcp-spec/2026-07-28/schema.json';

type SchemaFile = { $defs: Record<string, object> };

// Compiled once per definition, on first use, since compiling dereferences the whole file.
const validators = new Map<string, Validator>();

function errorsFor(file: SchemaFile, fileName: string, definition: string, value: unknown): OutputUnit[] {
  const key = `${fileName}#${definition}`;
  let validator = validators.get(key);
  if (!validator) {
    if (!(definition in file.$defs)) throw new RangeError(`${fileName} defines no ${definition}`);
    validator = new Validator({ ...file, $ref: `#/$defs/${definition}` } as object, '2020-12', false);
    validators.set(key, validator);
  }
  const { valid, errors } = validator.validate(value);
  return valid ? [] : errors;
}

/** Errors in `value` against one of the spec's definitions, as `ReadResourceRequest`, or none. */
export function specErrors(definition: string, value: unknown): OutputUnit[] {
  return errorsFor(specSchema as SchemaFile, 'schema.json', definition, value);
}

function requestDefinitions(file: SchemaFile, fileName: string): [string, { file: SchemaFile; fileName: string; definition: string }][] {
  return Object.entries(file.$defs).flatMap(([name, definition]) => {
    const { properties, required } = definition as { properties?: { method?: { const?: string } }; required?: string[] };
    const method = properties?.method?.const;
    return method && required?.includes('id') ? [[method, { file, fileName, definition: name }]] : [];
  });
}

/**
 * The request definition for each method a schema defines a request for, as `resources/read` to
 * the spec's `ReadResourceRequest` and `events/subscribe` to SEP-3415's `EventsSubscribeRequest`,
 * read from each schema's `method` constants.
 */
const REQUEST_DEFINITIONS = new Map([
  ...requestDefinitions(specSchema as SchemaFile, 'schema.json'),
  ...requestDefinitions(eventsSchema as SchemaFile, 'events-types.schema.json'),
]);

/** Errors in a request against its method's definition, or undefined when no schema defines it. */
export function requestErrors(request: { method: string }): OutputUnit[] | undefined {
  const found = REQUEST_DEFINITIONS.get(request.method);
  return found && errorsFor(found.file, found.fileName, found.definition, request);
}
