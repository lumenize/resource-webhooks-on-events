<script setup lang="ts">
import type { SleepPhase } from '../sleep.ts';

// A's or B's phase, as `useSleep` gives it, shown where the clients' boxes say they are live.
defineProps<{ phase: SleepPhase; seconds: number }>();
</script>

<template>
  <span v-if="phase !== 'unknown'" class="sleep" :class="phase">
    <template v-if="phase === 'woke'"><span class="dot" />woke from hibernation</template>
    <template v-else-if="phase === 'awake'"><span class="dot" />awake</template>
    <template v-else-if="phase === 'holding'"><span class="dot" />awake<span class="billed">· waiting to retry</span></template>
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
  border: 1px solid color-mix(in srgb, var(--c) 40%, transparent);
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
  background: var(--c);
  animation: beat 0.7s ease-in-out infinite;
}

.awake,
.holding {
  color: var(--text);
  background: color-mix(in srgb, var(--c) 18%, transparent);
}

.woke {
  color: #0a0e16;
  font-weight: 600;
  background: var(--c);
  border-color: var(--c);
  animation: woke 1.8s ease-out;
}

.woke .dot {
  background: #0a0e16;
}

.count {
  display: inline-block;
  min-width: 2.6ch;
  color: var(--c);
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
  border-color: color-mix(in srgb, var(--c) 28%, transparent);
}

.moon {
  width: 13px;
  height: 13px;
  fill: var(--c);
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
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--c) 80%, transparent);
  }
  100% {
    box-shadow: 0 0 0 14px transparent;
  }
}
</style>
