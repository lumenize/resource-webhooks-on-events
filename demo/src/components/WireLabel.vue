<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { WireView } from '../demo.ts';

// `focused` opens the label's popover until the page moves on, as step 5 does for the event.
const props = defineProps<{ label: string; kind: string; color: string; x: number; y: number; view: WireView; above?: boolean; align?: 'left' | 'right' | 'center'; focused?: boolean }>();
const open = ref(false);
const pinned = ref(false);
const flash = ref(false);
let flashTimer: ReturnType<typeof setTimeout> | undefined;
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
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// JSON, escaped, with its keys, strings and numbers coloured.
const html = computed(() => {
  if (props.view.last === undefined) return '';
  const text = escape(typeof props.view.last === 'string' ? props.view.last : JSON.stringify(props.view.last, null, 2));
  return text.replace(/("(?:[^"\\]|\\.)*")(\s*:)?|\b(-?\d+(?:\.\d+)?)\b|\b(true|false|null)\b/g, (match, string, colon, number, literal) => {
    if (string) return colon ? `<span class="k">${string}</span>${colon}` : `<span class="s">${string}</span>`;
    if (number) return `<span class="n">${number}</span>`;
    if (literal) return `<span class="l">${literal}</span>`;
    return match;
  });
});
</script>

<template>
  <div
    class="wire-label"
    :class="{ open: open || pinned || focused, flash, above, [align ?? 'center']: true, empty: view.last === undefined }"
    :style="{ left: `${x}%`, top: `${y}%`, '--c': `var(--${color})` }"
    @mouseenter="open = true"
    @mouseleave="open = false"
    @click="pinned = !pinned"
  >
    <div class="tag">
      <span class="name">{{ label }}</span>
      <span class="kind">{{ kind }}</span>
    </div>
    <div v-if="view.what" class="what mono">{{ view.what }}</div>
    <div v-if="(open || pinned || focused) && view.last !== undefined" class="pop">
      <div class="pop-head">
        <span>Last message · {{ label }}</span>
        <span class="mono">{{ view.what }}</span>
      </div>
      <pre class="mono" v-html="html"></pre>
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
  cursor: help;
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

.wire-label.flash .tag {
  background: color-mix(in srgb, var(--c) 38%, var(--panel-2));
  box-shadow: 0 0 0 4px var(--bg), 0 0 24px color-mix(in srgb, var(--c) 70%, transparent);
}

.wire-label.open .tag,
.wire-label:hover .tag {
  background: color-mix(in srgb, var(--c) 22%, var(--panel-2));
}

.name {
  font-weight: 700;
  color: var(--c);
  font-size: 15px;
}

.kind {
  font-size: 12.5px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.07em;
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
  width: 560px;
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

pre {
  margin: 0;
  padding: 12px 14px;
  overflow: auto;
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
</style>
