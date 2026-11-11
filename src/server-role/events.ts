// SEP-3415's methods for the extension's one event, `mcp.resource.collection.updated`, whose
// arguments are a uri-specification (R18, R20, D19). A offers no replay, so every cursor is null.
// One change sends one event to each subscription covering a resource it touched, listing the
// change-set entries it covers, and a newer event for a subscription takes in one not yet
// delivered (R10).
import { Validator } from '@cfworker/json-schema';
import { JsonRpcError } from '../json-rpc';
import {
  FORBIDDEN,
  NOT_FOUND,
  UNSUPPORTED,
  type EventOccurrence,
  type EventsListResult,
  type EventsSubscribeRequestParams,
  type EventsSubscribeResult,
  type EventsUnsubscribeRequestParams,
  type EventType,
  type WebhookDelivery,
} from '../events-types';
import { COLLECTION_UPDATED, type ChangeSetEntry, type CollectionUpdatedData, type SyncCollectionSubscription, type UriSpecification } from '../extension-types';
import { INVALID_PARAMS, type Result } from '../vendor/mcp-spec/2026-07-28/schema';
import { randomId, type Deliveries, type Message } from './deliveries';
import { MAX_NAMED_TEMPLATE_BYTES, MAX_NAMED_URI_BYTES, type Collections } from './collections';
import type { SubscriptionKey, Subscriptions } from './subscriptions';
import { extensionSchemaFor } from './validation';

// A subscription names exactly one of `uri` and `uriTemplate`, as a catch-up does.
const EXACTLY_ONE = { oneOf: [{ required: ['uri'] }, { required: ['uriTemplate'] }] };

// Its arguments, each held to the bound a catch-up holds it to. JSON Schema counts characters,
// and A counts UTF-8 bytes, so A may refuse a name the schema admits, never the other way round.
function inputSchema(): EventType['inputSchema'] {
  const schema = extensionSchemaFor('UriSpecification');
  const { uri, uriTemplate } = schema.properties as Record<string, object>;
  const properties = { uri: { ...uri, maxLength: MAX_NAMED_URI_BYTES }, uriTemplate: { ...uriTemplate, maxLength: MAX_NAMED_TEMPLATE_BYTES } };
  return { ...schema, properties, ...EXACTLY_ONE, additionalProperties: false };
}

const COLLECTION_UPDATED_TYPE: EventType = {
  name: COLLECTION_UPDATED,
  description: 'One change to resources in a collection, naming each one it touched and its new revision',
  delivery: ['webhook'],
  inputSchema: inputSchema(),
  payloadSchema: { ...extensionSchemaFor('CollectionUpdatedData'), ...EXACTLY_ONE },
};

// The arguments a subscribe or an unsubscribe names, checked against the `inputSchema` A lists,
// as SEP-3415 asks.
const ARGUMENTS = new Validator(COLLECTION_UPDATED_TYPE.inputSchema as object, '2020-12', false);

/** One resource a write changed: its change-set entry, and when its change committed. */
export interface Change {
  path: string;
  entry: ChangeSetEntry;
  /** When the change committed, to the millisecond. */
  writtenAt: string;
}

// What an event's body is built from, which a merge reads.
interface EventSource {
  named: UriSpecification;
  eventId: string;
  timestamp: string;
  /** The moment of the subscription's event before this one, or where the subscription began (R10). */
  previousMoment: string;
  /** The covered entries, or undefined when the event leaves them out. */
  changes: ChangeSetEntry[] | undefined;
}

/** A subscription whose endpoint has answered its handshake, which `commit` then writes. */
export interface VerifiedSubscription {
  key: SubscriptionKey;
  id: string;
  secret: string;
  /** How many Wipes A had seen before the handshake went out. */
  generation: number;
}

export interface EventsOptions {
  deliveries: Deliveries;
  subscriptions: Subscriptions;
  /** What tells A which resources a uri-specification covers, as a catch-up reads it. */
  collections: Collections;
  /** The largest body an event may have, in UTF-8 bytes, past which it leaves `changes` out. */
  eventBodyLimit: number;
}

export class Events {
  readonly #options: EventsOptions;

  constructor(options: EventsOptions) {
    this.#options = options;
  }

  list(): EventsListResult {
    return { resultType: 'complete', events: [COLLECTION_UPDATED_TYPE] };
  }

  async subscribe(params: EventsSubscribeRequestParams, principal: string | undefined): Promise<EventsSubscribeResult> {
    const verified = await this.#verify(params, principal);
    return { resultType: 'complete', ...this.commit(verified, params.ttlMs), cursor: null, truncated: false };
  }

  /**
   * The awaited half of subscribing, for a sync that carries a `delivery`: every check
   * `events/subscribe` makes of the principal, the uri-specification and the delivery, then the
   * handshake (R18). Nothing is written until `commit`.
   */
  verify(named: UriSpecification, delivery: WebhookDelivery, principal: string | undefined): Promise<VerifiedSubscription> {
    return this.#verify({ name: COLLECTION_UPDATED, arguments: { ...named }, delivery }, principal);
  }

  /**
   * Writes a verified subscription, or refreshes it, in one synchronous step, which a sync shares
   * with the read of its result, so no change falls between the two (R18).
   */
  commit({ key, id, secret, generation }: VerifiedSubscription, ttlMs: number | null | undefined): SyncCollectionSubscription {
    const refreshBefore = this.#options.subscriptions.grant(ttlMs);
    this.#options.subscriptions.write({ ...key, id, secret, expiresAt: refreshBefore }, generation);
    return { id, refreshBefore };
  }

  // The delivery's own checks, the cap and the count of Wipes all come before the first await,
  // so a refusal sends no challenge, and a Wipe that lands while one is out is seen at the write.
  async #verify(params: { name: string; arguments?: { [key: string]: unknown }; delivery: WebhookDelivery }, principal: string | undefined): Promise<VerifiedSubscription> {
    const { subscriptions, deliveries } = this.#options;
    const { key, named } = this.#key(params, principal);
    const { secret } = params.delivery;
    subscriptions.requireDelivery(key.url, secret);
    subscriptions.requireUnderCap(key);
    const generation = subscriptions.generation;
    const id = await subscriptions.idFor([key.principal, key.url, key.name, named]);
    await deliveries.requireVerified(key.principal, key.url, secret, id);
    return { key, id, secret, generation };
  }

  unsubscribe(params: EventsUnsubscribeRequestParams, principal: string | undefined): Result {
    const { key } = this.#key(params, principal);
    this.#options.subscriptions.requireDelivery(key.url);
    const id = this.#options.subscriptions.remove(key);
    if (id === undefined) throw new JsonRpcError(NOT_FOUND, 'No such subscription', { kind: 'subscription' });
    // SEP-3415: unsubscribing stops webhook deliveries immediately, retries included.
    this.#options.deliveries.cancel(id);
    return { resultType: 'complete' };
  }

  /** Delivery modes A does not offer. */
  refuseMode(): never {
    throw new JsonRpcError(UNSUPPORTED, `${COLLECTION_UPDATED} is delivered by webhook only`, { feature: 'deliveryMode' });
  }

  /**
   * Sends one event for a committed write to each live subscription that covers a resource it
   * changed, listing the entries it covers. Every entry a subscription covers is on its timeline,
   * so they share one moment, the event's `eventId`. `stage` builds each event and stores that
   * moment as its subscription's last, and the caller runs it in the write's own transaction, so a
   * change never commits without it. A restart between the two would otherwise lose the event and
   * leave the next one naming the moment before the lost change, which a client would read as
   * nothing missed (R10). `send` queues what `stage` built, once the write has committed.
   */
  stage(changes: readonly Change[]): Message[] {
    const staged: Message[] = [];
    // A lapsed subscription's row stays until A next starts, and the queue makes no attempt past
    // its grant, so it gets nothing.
    for (const subscription of this.#options.subscriptions.named(COLLECTION_UPDATED)) {
      const named = JSON.parse(subscription.arguments) as UriSpecification;
      const covers = this.#options.collections.covers(named);
      const covered = changes.filter(({ path }) => covers(path));
      if (covered.length === 0) continue;
      const eventId = covered[0].entry.revision;
      const previousMoment = this.#options.subscriptions.advance(subscription, eventId);
      const source: EventSource = { named, eventId, timestamp: covered[0].writtenAt, previousMoment, changes: covered.map(({ entry }) => entry) };
      const webhookId = `msg_${randomId(24)}`;
      staged.push({
        url: subscription.url,
        secret: subscription.secret,
        subscriptionId: subscription.id,
        webhookId,
        body: this.#body(source),
        until: subscription.expiresAt,
        source,
      });
    }
    return staged;
  }

  /** Queues each staged event for delivery, in its subscription's slot. */
  send(staged: readonly Message[]): void {
    for (const message of staged) this.#options.deliveries.enqueue(message.subscriptionId, message);
  }

  /**
   * The event to send for a subscription in place of an older one not yet delivered and a newer
   * one: the newer's `eventId`, `timestamp` and webhook-id, the older's `previousMoment`, and
   * each uri once, running from the older's start to the newer's end. It leaves `changes` out
   * when either did, or when together they would pass the limit.
   */
  merge(older: Message, newer: Message): Message {
    const [before, after] = [older.source as EventSource, newer.source as EventSource];
    const changes = before.changes && after.changes ? mergeEntries(before.changes, after.changes) : undefined;
    const source: EventSource = { ...after, previousMoment: before.previousMoment, changes };
    return { ...newer, body: this.#body(source), source };
  }

  // The event's body, with its entries when they fit the limit, and without them otherwise (R10),
  // which it records on the source, so a merge with it leaves them out too.
  #body(source: EventSource): string {
    const occurrence = (changes: ChangeSetEntry[] | undefined): EventOccurrence => {
      const data: CollectionUpdatedData = { ...source.named, previousMoment: source.previousMoment, ...(changes ? { changes } : {}) };
      return { eventId: source.eventId, name: COLLECTION_UPDATED, timestamp: source.timestamp, data: { ...data }, cursor: null };
    };
    const whole = JSON.stringify(occurrence(source.changes));
    if (new TextEncoder().encode(whole).byteLength <= this.#options.eventBodyLimit) return whole;
    source.changes = undefined;
    return JSON.stringify(occurrence(undefined));
  }

  #key(params: { name: string; arguments?: { [key: string]: unknown }; delivery: { url: string } }, principal: string | undefined): { key: SubscriptionKey; named: UriSpecification } {
    if (!principal) throw new JsonRpcError(FORBIDDEN, 'Subscribing needs an authenticated principal');
    if (params.name !== COLLECTION_UPDATED) throw new JsonRpcError(NOT_FOUND, `No event type ${params.name}`, { kind: 'event' });
    const checked = ARGUMENTS.validate(params.arguments ?? {});
    if (!checked.valid) throw new JsonRpcError(INVALID_PARAMS, "The arguments do not match the event's inputSchema", checked.errors.slice(0, 10));
    const named = (params.arguments ?? {}) as UriSpecification;
    // Then the refusals a catch-up gives the same uri-specification, notFound among them (R18).
    this.#options.collections.covers(named);
    const canonical = named.uri !== undefined ? { uri: named.uri } : { uriTemplate: named.uriTemplate };
    return { key: { principal, url: params.delivery.url, name: params.name, arguments: JSON.stringify(canonical) }, named: canonical };
  }
}

// Each uri once, the older's entry giving the merged one its start and the newer's its end, since
// the receiver may never have got the older event.
function mergeEntries(older: ChangeSetEntry[], newer: ChangeSetEntry[]): ChangeSetEntry[] {
  const byUri = new Map(older.map((entry) => [entry.uri, entry]));
  for (const entry of newer) {
    const before = byUri.get(entry.uri);
    if (!before) {
      byUri.set(entry.uri, entry);
      continue;
    }
    const existed = before.previousRevision !== undefined;
    const effect = entry.effect === 'deleted' ? 'deleted' : existed ? 'updated' : 'created';
    byUri.set(entry.uri, { uri: entry.uri, effect, ...(existed ? { previousRevision: before.previousRevision } : {}), revision: entry.revision });
  }
  return [...byUri.values()];
}
