<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

// Whether B is running, idle in memory, or hibernated. B runs only for an event, and every event
// B handles reports to the page, so `activeAt` is when B last ran. Cloudflare hibernates an idle
// Durable Object after 10 seconds, and bills it no duration while idle or hibernated. `wokeAt`
// is when B's constructor last ran again, which proves it had been out of memory.
const props = defineProps<{ activeAt?: number; wokeAt?: number }>();

/** How long Cloudflare keeps an idle Durable Object in memory before it hibernates it. */
const HIBERNATES_AFTER_MS = 10_000;
/** How long the page shows B as awake after an event, which B handles in milliseconds. */
const AWAKE_MS = 700;
/** How long the page shows that B woke. */
const WOKE_MS = 1800;

const now = ref(Date.now());
const ticker = setInterval(() => (now.value = Date.now()), 100);
onBeforeUnmount(() => clearInterval(ticker));

const phase = computed(() => {
  if (props.activeAt === undefined) return 'unknown';
  if (props.wokeAt !== undefined && now.value - props.wokeAt < WOKE_MS) return 'woke';
  const idle = now.value - props.activeAt;
  if (idle < AWAKE_MS) return 'awake';
  return idle < HIBERNATES_AFTER_MS ? 'idle' : 'hibernating';
});
const seconds = computed(() => Math.max(1, Math.ceil((HIBERNATES_AFTER_MS - (now.value - (props.activeAt ?? 0))) / 1000)));
</script>

<template>
  <span v-if="phase !== 'unknown'" class="sleep" :class="phase">
    <template v-if="phase === 'woke'"><span class="dot" />woke from hibernation</template>
    <template v-else-if="phase === 'awake'"><span class="dot" />awake</template>
    <template v-else-if="phase === 'idle'">
      time to hibernation:
      <span class="count mono">
        <Transition name="tick" mode="out-in">
          <span :key="seconds">{{ seconds }}s</span>
        </Transition>
      </span>
      <span class="billed">· not billed</span>
    </template>
    <template v-else>
      <svg class="moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1z" /></svg>
      hibernating
      <span class="billed">· not billed</span>
    </template>
  </span>
</template>

<style scoped>
.sleep {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 11px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--B) 40%, transparent);
  font-size: 13px;
  color: var(--muted);
  white-space: nowrap;
  transition:
    background 300ms,
    color 300ms,
    border-color 300ms;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--B);
  animation: beat 0.7s ease-in-out infinite;
}

.awake {
  color: var(--text);
  background: color-mix(in srgb, var(--B) 18%, transparent);
}

.woke {
  color: #0a0e16;
  font-weight: 600;
  background: var(--B);
  border-color: var(--B);
  animation: woke 1.8s ease-out;
}

.woke .dot {
  background: #0a0e16;
}

.count {
  display: inline-block;
  min-width: 2.6ch;
  color: var(--B);
  font-weight: 700;
  overflow: hidden;
}

.count span {
  display: inline-block;
}

.billed {
  color: var(--faint);
}

.hibernating {
  color: var(--muted);
  border-color: color-mix(in srgb, var(--B) 28%, transparent);
}

.moon {
  width: 13px;
  height: 13px;
  fill: var(--B);
  animation: breathe 3s ease-in-out infinite;
}

/* Each second slides up out of the count as the next slides in. */
.tick-enter-active,
.tick-leave-active {
  transition:
    transform 180ms ease,
    opacity 180ms ease;
}

.tick-enter-from {
  transform: translateY(70%);
  opacity: 0;
}

.tick-leave-to {
  transform: translateY(-70%);
  opacity: 0;
}

@keyframes beat {
  50% {
    transform: scale(1.5);
    opacity: 0.6;
  }
}

@keyframes breathe {
  50% {
    opacity: 0.35;
  }
}

@keyframes woke {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--B) 80%, transparent);
  }
  100% {
    box-shadow: 0 0 0 14px transparent;
  }
}
</style>
