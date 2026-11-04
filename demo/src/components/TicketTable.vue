<script setup lang="ts">
import { leaf, short, type Ticket } from '../demo.ts';

// `current` is A's revision of each ticket, so a copy behind it can show as stale.
defineProps<{ tickets: Ticket[]; current?: Record<string, string> }>();
</script>

<template>
  <table v-if="tickets.length">
    <tbody>
      <tr
        v-for="ticket in tickets"
        :key="ticket.uri"
        :class="{ gone: ticket.deleted, stale: current && current[ticket.uri] && current[ticket.uri] !== ticket.revision, lost: current && !ticket.deleted && !current[ticket.uri] }"
      >
        <td class="id mono">{{ leaf(ticket.uri) }}</td>
        <td class="rev mono" :title="ticket.revision">{{ short(ticket.revision) }}</td>
        <td class="status">
          <span v-if="ticket.deleted" class="chip">deleted</span>
          <span v-else class="chip" :class="ticket.status">{{ ticket.status }}</span>
        </td>
        <td class="title">
          {{ ticket.title }}
          <span v-if="ticket.duplicateOf" class="dup mono">dup of {{ ticket.duplicateOf }}</span>
        </td>
      </tr>
    </tbody>
  </table>
  <p v-else class="none">none</p>
</template>

<style scoped>
table {
  width: 100%;
  border-collapse: collapse;
}

td {
  padding: 5px 8px 5px 0;
  vertical-align: baseline;
  white-space: nowrap;
}

.id {
  color: var(--text);
}

.rev {
  color: var(--muted);
  text-align: right;
  padding-right: 14px;
  min-width: 2.5em;
}

.title {
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 0;
  color: var(--muted);
}

.dup {
  margin-left: 6px;
  font-size: 12px;
  color: var(--faint);
}

.chip {
  display: inline-block;
  padding: 1px 9px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  border: 1px solid var(--line);
  color: var(--muted);
}

.chip.open {
  color: var(--ok);
  border-color: color-mix(in srgb, var(--ok) 40%, transparent);
}

.chip.closed {
  color: var(--B);
  border-color: color-mix(in srgb, var(--B) 45%, transparent);
}

tr.gone td {
  color: var(--faint);
  text-decoration: line-through;
}

tr.stale .rev {
  color: var(--stale);
  font-weight: 600;
}

/* The page's notes, from comparing each copy with A's: the client itself can't know. */
tr.lost .id::after {
  content: ' (not on A)';
  font-family: var(--sans);
  font-size: 11px;
  color: var(--muted);
}

tr.lost .id {
  color: var(--stale);
}

tr.stale .rev::after {
  content: ' (behind A)';
  font-family: var(--sans);
  font-size: 11px;
  font-weight: 400;
  color: var(--muted);
}

.none {
  margin: 4px 0;
  color: var(--faint);
}
</style>
