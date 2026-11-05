// Whether B is running, idle in memory, or hibernated. B runs only for an event, and every event
// B handles reports to the page, so `activeAt` is when B last ran. Cloudflare hibernates an idle
// Durable Object after 10 seconds, and bills it no duration while idle or hibernated. `wokeAt`
// is when B's constructor last ran again, which proves it had been out of memory.
import { computed, onBeforeUnmount, ref } from 'vue';

/** How long Cloudflare keeps an idle Durable Object in memory before it hibernates it. */
const HIBERNATES_AFTER_MS = 10_000;
/** How long the page shows B as awake after an event, which B handles in milliseconds. */
const AWAKE_MS = 700;
/** How long the page shows that B woke. */
const WOKE_MS = 1800;

export type SleepPhase = 'unknown' | 'woke' | 'awake' | 'idle' | 'hibernating';

/** B's phase, and the whole seconds left before it hibernates, kept current every 100 ms. */
export function useSleep(activeAt: () => number | undefined, wokeAt: () => number | undefined) {
  const now = ref(Date.now());
  const ticker = setInterval(() => (now.value = Date.now()), 100);
  onBeforeUnmount(() => clearInterval(ticker));
  const phase = computed<SleepPhase>(() => {
    const active = activeAt();
    if (active === undefined) return 'unknown';
    const woke = wokeAt();
    if (woke !== undefined && now.value - woke < WOKE_MS) return 'woke';
    const idle = now.value - active;
    if (idle < AWAKE_MS) return 'awake';
    return idle < HIBERNATES_AFTER_MS ? 'idle' : 'hibernating';
  });
  const seconds = computed(() => Math.max(1, Math.ceil((HIBERNATES_AFTER_MS - (now.value - (activeAt() ?? 0))) / 1000)));
  return { phase, seconds };
}
