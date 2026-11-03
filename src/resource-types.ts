// The two types A holds. `npm run generate:schema` writes their JSON Schema to
// resource-types.schema.json with the spec's own generator and flags, and every write is
// checked against it, so these interfaces are the only definition of each type.

/**
 * A note, such as `{ "title": "Buy milk", "due": "2026-10-24" }`. A ticket's note shares its id,
 * as `notes/ticket-3` for `tickets/ticket-3`, and closing the ticket sets its `done`.
 * @additionalProperties false
 */
export interface Note {
  title: string;
  done?: boolean;
  due?: string;
}

/**
 * A ticket, such as `{ "title": "Printer jams", "status": "open" }`. Setting `duplicateOf` to
 * another ticket's id adds this ticket's id to that one's `duplicatedBy`, in the same write.
 * @additionalProperties false
 */
export interface Ticket {
  title: string;
  status: 'open' | 'closed';
  /** The id of the ticket this one duplicates, as `ticket-9`. */
  duplicateOf?: string;
  /** The ids of the tickets that duplicate this one, as `["ticket-7"]`. */
  duplicatedBy?: string[];
}
