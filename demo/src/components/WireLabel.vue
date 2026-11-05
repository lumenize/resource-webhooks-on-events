<script setup lang="ts">
import { ref, watch } from 'vue';
import type { WireView } from '../demo.ts';

// Hovering a label opens its popover, and clicking pins it open. The page holds which one is
// pinned, so pinning one unpins the others, and a click anywhere else unpins it. The popover lists
// every exchange over the wire since the step began, oldest first.
// `quiet` is a wire with nothing crossing it, as an MCP or webhook wire between requests is.
const props = defineProps<{ label: string; kind: string; color: string; x: number; y: number; view: WireView; since: string; above?: boolean; align?: 'left' | 'right' | 'center'; pinned?: boolean; quiet?: boolean }>();
const emit = defineEmits<{ toggle: [] }>();
const open = ref(false);
const flash = ref(false);
let flashTimer: ReturnType<typeof setTimeout> | undefined;
// A note that the runtime answered a ping, shown briefly each time, as on a socket's label.
const pong = ref(false);
let pongTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => props.view.pongAt,
  (at) => {
    if (at === undefined) return;
    pong.value = true;
    clearTimeout(pongTimer);
    pongTimer = setTimeout(() => (pong.value = false), 1800);
  },
);
// The label flashes as each message crosses its wire.
watch(
  () => props.view.count,
  () => {
    flash.value = true;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flash.value = false), 900);
  },
);

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A string holding a JSON object or array, parsed, as a resource's `text` or a webhook's body.
function parsedJson(text: string): object | undefined {
  if (!/^\s*[[{]/.test(text)) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

const PARSED = '<span class="parsed" title="One string on the wire, parsed by this page to show it">/* parsed */</span> ';

// JSON as HTML, its keys, strings and numbers coloured, and a string holding JSON shown parsed,
// marked as parsed, since on the wire it is one escaped string.
function render(value: unknown, indent = ''): string {
  if (typeof value === 'string') {
    const parsed = parsedJson(value);
    return parsed ? PARSED + render(parsed, indent) : `<span class="s">${escape(JSON.stringify(value))}</span>`;
  }
  if (typeof value === 'number') return `<span class="n">${value}</span>`;
  if (typeof value === 'boolean' || value === null) return `<span class="l">${String(value)}</span>`;
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    return value.length ? `[\n${value.map((each) => inner + render(each, inner)).join(',\n')}\n${indent}]` : '[]';
  }
  const entries = Object.entries((value ?? {}) as Record<string, unknown>).filter(([, each]) => each !== undefined);
  if (!entries.length) return '{}';
  return `{\n${entries.map(([key, each]) => `${inner}<span class="k">${escape(JSON.stringify(key))}</span>: ${render(each, inner)}`).join(',\n')}\n${indent}}`;
}
</script>

<template>
  <div
    class="wire-label"
    :class="{ open: open || pinned, pinned, flash, quiet, above, [align ?? 'center']: true, empty: !view.log.length }"
    :style="{ left: `${x}%`, top: `${y}%`, '--c': `var(--${color})` }"
    @mouseenter="open = true"
    @mouseleave="open = false"
    @click.stop="emit('toggle')"
  >
    <div class="tag">
      <svg v-if="pinned" class="pin" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 2.5l7 7-2.2.9-3.6 3.6.4 4.6-1.6 1.6-4.2-4.2L4 22l-2-2 6-6.3-4.2-4.2 1.6-1.6 4.6.4 3.6-3.6z" /></svg>
      <span class="kind">{{ kind }}</span>
    </div>
    <div v-if="view.what" class="what mono">{{ view.what }}</div>
    <Transition name="pong">
      <div v-if="pong" class="pong">pong · answered without waking B</div>
    </Transition>
    <div v-if="(open || pinned) && view.log.length" class="pop" @click.stop>
      <div class="pop-head">
        <span>{{ label }} · since {{ since }}</span>
        <span class="hint">{{ pinned ? 'pinned: click anywhere to close' : 'click the label to pin' }}</span>
      </div>
      <div class="entries">
        <section v-for="entry in view.log" :key="entry.id" class="entry">
          <div class="entry-what mono">{{ entry.what }}</div>
          <pre class="mono" v-html="render(entry.body)"></pre>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wire-label {
  position: absolute;
  z-index: 5;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  /* A pushpin: click to pin the popover open. */
  cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 24 24'%3E%3Cpath fill='%23ffffff' stroke='%230a0e16' stroke-width='1.4' stroke-linejoin='round' d='M14.5 2.5l7 7-2.2.9-3.6 3.6.4 4.6-1.6 1.6-4.2-4.2L4 22l-2-2 6-6.3-4.2-4.2 1.6-1.6 4.6.4 3.6-3.6z'/%3E%3C/svg%3E") 3 25, pointer;
}

.tag {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--panel-2);
  border: 1px solid color-mix(in srgb, var(--c) 55%, transparent);
  box-shadow: 0 0 0 4px var(--bg);
  white-space: nowrap;
  transition: background 160ms;
}

.wire-label.open {
  z-index: 30;
}

/* The note under a socket's label that the runtime answered a ping, so B did not wake. */
.pong {
  position: absolute;
  top: calc(100% + 4px);
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--c) 50%, transparent);
  background: var(--bg);
  color: var(--c);
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
}

.pong-enter-active,
.pong-leave-active {
  transition:
    opacity 250ms,
    transform 250ms;
}

.pong-enter-from,
.pong-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* A quiet wire's label dims, as its line does, until a message crosses it or it opens. */
.tag,
.what {
  transition: opacity 300ms;
}

.wire-label.quiet:not(.open):not(.flash) .tag,
.wire-label.quiet:not(.open):not(.flash) .what {
  opacity: 0.4;
}

.wire-label.flash .tag {
  background: color-mix(in srgb, var(--c) 38%, var(--panel-2));
  box-shadow: 0 0 0 4px var(--bg), 0 0 24px color-mix(in srgb, var(--c) 70%, transparent);
}

.wire-label.open .tag,
.wire-label:hover .tag {
  background: color-mix(in srgb, var(--c) 22%, var(--panel-2));
}

.kind {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--c);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.pin {
  width: 14px;
  height: 14px;
  fill: var(--c);
}

.what {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--muted);
  background: var(--bg);
  padding: 0 6px;
  border-radius: 4px;
}

.pop {
  position: absolute;
  top: calc(100% + 10px);
  width: min(1080px, 96vw);
  max-height: 46vh;
  display: flex;
  flex-direction: column;
  background: #0d121c;
  border: 1px solid color-mix(in srgb, var(--c) 55%, var(--line));
  border-radius: 12px;
  box-shadow: 0 24px 60px -12px #000c;
  cursor: auto;
}

.above .pop {
  top: auto;
  bottom: calc(100% + 10px);
}

.center .pop {
  left: 50%;
  transform: translateX(-50%);
}

.left .pop {
  left: -24px;
}

.right .pop {
  right: -24px;
}

.pop-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
  font-weight: 600;
  color: var(--c);
}

.pop-head .mono {
  color: var(--muted);
  font-weight: 400;
}

.pop-head .hint {
  color: var(--faint);
  font-weight: 400;
}

.pop {
  cursor: auto;
}

.entries {
  overflow-y: auto;
  padding: 4px 0;
}

/* Each exchange, its request and response together, set apart from the next. */
.entry + .entry {
  margin-top: 10px;
  border-top: 1px solid var(--line);
  padding-top: 10px;
}

.entry-what {
  padding: 6px 14px 0;
  font-size: 12.5px;
  color: var(--c);
}

pre {
  margin: 0;
  padding: 4px 14px 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.5;
  color: #c9d1e0;
}

pre :deep(.k) {
  color: #93c5fd;
}

pre :deep(.s) {
  color: #fcd34d;
}

pre :deep(.n) {
  color: #fda4af;
}

pre :deep(.l) {
  color: #c4b5fd;
}

/* The page's own note that it parsed a string, as faint as a comment. */
pre :deep(.parsed) {
  color: var(--faint);
  font-style: italic;
}
</style>
