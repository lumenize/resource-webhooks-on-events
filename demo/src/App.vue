<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import PartyBox from './components/PartyBox.vue';
import SleepStatus from './components/SleepStatus.vue';
import { useSleep } from './sleep.ts';
import TicketTable from './components/TicketTable.vue';
import WireLabel from './components/WireLabel.vue';
import { chooseScene, currentScene, hasSocket, prepare, saveToken, SCENE_MENU, short, state, step, type PartyName, type WireName } from './demo.ts';

// The stage is a 3 × 3 grid: the boxes take the corners, and the wires cross the middle column
// and row. Every position below is a percentage of the stage, so the wires meet the boxes'
// edges at any size: columns are 41% · 18% · 41% and rows 40% · 20% · 40%.
interface Wire {
  from: PartyName;
  to: PartyName;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
  label: string;
  kind: string;
  lx: number;
  ly: number;
  align?: 'left' | 'right' | 'center';
  /**
   * Which ends carry an arrowhead: the end that answers, or both where either side starts an
   * exchange, as on a socket, where X and Y send their secret up and B sends each event down.
   */
  arrows: 'to' | 'both';
}

const WIRES: Record<WireName, Wire> = {
  'A-B': { from: 'A', to: 'B', x0: 41, y0: 20, x1: 59, y1: 20, color: 'A', label: 'A → B', kind: 'webhook', lx: 50, ly: 20, arrows: 'to' },
  'X-A': { from: 'X', to: 'A', x0: 14, y0: 60, x1: 14, y1: 40, color: 'X', label: 'X → A', kind: 'MCP', lx: 14, ly: 50, align: 'left', arrows: 'to' },
  'Y-A': { from: 'Y', to: 'A', x0: 66, y0: 60, x1: 34, y1: 40, color: 'Y', label: 'Y → A', kind: 'MCP', lx: 58, ly: 55, arrows: 'to' },
  'B-X': { from: 'B', to: 'X', x0: 66, y0: 40, x1: 34, y1: 60, color: 'B', label: 'B ⇄ X', kind: 'WebSocket', lx: 42, ly: 55, arrows: 'both' },
  'B-Y': { from: 'B', to: 'Y', x0: 86, y0: 40, x1: 86, y1: 60, color: 'B', label: 'B ⇄ Y', kind: 'WebSocket', lx: 86, ly: 50, align: 'right', arrows: 'both' },
};
const COLORS = ['A', 'B', 'X', 'Y'] as const;

// The wires are drawn in the stage's own pixels, measured as it resizes, so the arrowheads keep
// their shape at any size.
const stage = ref<HTMLElement>();
const size = ref({ w: 1600, h: 800 });
let observer: ResizeObserver | undefined;
onMounted(() => {
  observer = new ResizeObserver(([entry]) => (size.value = { w: entry.contentRect.width, h: entry.contentRect.height }));
  if (stage.value) observer.observe(stage.value);
  document.addEventListener('click', unpin);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  document.removeEventListener('click', unpin);
});
const px = (w: Wire) => ({ x1: (w.x0 / 100) * size.value.w, y1: (w.y0 / 100) * size.value.h, x2: (w.x1 / 100) * size.value.w, y2: (w.y1 / 100) * size.value.h });

// One popover pinned at a time, and a click anywhere else unpins it.
function unpin(): void {
  state.pinned = undefined;
}
function toggle(name: WireName): void {
  state.pinned = state.pinned === name ? undefined : name;
}

const CLIENTS = ['X', 'Y'] as const;
// Whether A and B run, idle or hibernate, which each one's corner shows and its box dims for. A
// stays awake while it holds a delivery waiting to retry.
const { phase: phaseA, seconds: secondsA } = useSleep(() => state.A.activeAt, () => state.A.wokeAt, () => state.A.pending > 0);
const { phase: phaseB, seconds: secondsB } = useSleep(() => state.B.activeAt, () => state.B.wokeAt);

// A socket B holds open, which stays drawn while B hibernates. MCP and webhook wires carry a
// request only while one is under way.
function held(name: WireName): boolean {
  const w = WIRES[name];
  return w.kind === 'WebSocket' && (w.to === 'X' || w.to === 'Y') && hasSocket(w.to);
}
const token = ref(state.operatorToken);
function onToken(): void {
  saveToken(token.value);
}

const current = computed(() => Object.fromEntries(state.A.tickets.map(({ uri, revision }) => [uri, revision])));
const lit = computed(() => new Set(state.pulses.filter(({ beat }) => !beat).map(({ wire }) => wire)));
const scene = computed(() => currentScene());
const steps = computed(() => scene.value.steps.map((each, i) => ({ ...each, n: i + 1 })));
const caption = computed(() => {
  if (state.done < 1) return state.done === 0 ? 'Prepared: tickets 3, 7 and 9 are on A' : scene.value.title;
  const done = steps.value[state.done - 1];
  return `Step ${done.n} · ${done.title}`;
});
const line = computed(() => {
  if (state.done < 1) return state.done === 0 ? scene.value.ready : '';
  return steps.value[state.done - 1].line;
});
function onScene(event: Event): void {
  chooseScene((event.target as HTMLSelectElement).value);
}

function dot(wire: WireName, from: PartyName) {
  const w = WIRES[wire];
  const forward = from === w.from;
  return {
    '--x0': `${forward ? w.x0 : w.x1}%`,
    '--y0': `${forward ? w.y0 : w.y1}%`,
    '--x1': `${forward ? w.x1 : w.x0}%`,
    '--y1': `${forward ? w.y1 : w.y0}%`,
    '--c': `var(--${from})`,
  };
}
</script>

<template>
  <div class="app">
    <header class="top">
      <div class="brand">
        <h1>Resource Events</h1>
        <select class="scene" :value="state.scene" :disabled="state.busy" aria-label="Scene" @change="onScene">
          <option v-for="item in SCENE_MENU" :key="item.id" :value="item.id">{{ item.title }}</option>
        </select>
      </div>
      <div class="caption">
        <div class="now">{{ caption }}</div>
        <div v-if="line" class="line">{{ line }}</div>
        <div class="status" :class="{ error: state.error }">{{ state.error || state.status }}</div>
      </div>
      <div class="controls">
        <div class="row">
          <input v-model="token" type="password" placeholder="Operator token" autocomplete="off" spellcheck="false" @change="onToken" />
          <button class="prepare" :disabled="state.busy" @click="onToken(), prepare()">Auth/Reset</button>
        </div>
        <a class="pr" href="https://github.com/modelcontextprotocol/experimental-ext-triggers-events/pull/19" target="_blank" rel="noopener">experimental-ext-triggers-events #19</a>
      </div>
    </header>

    <main ref="stage" class="stage">
      <svg class="wires" :viewBox="`0 0 ${size.w} ${size.h}`" aria-hidden="true">
        <defs>
          <marker v-for="c in COLORS" :id="`arrow-${c}`" :key="c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="14" markerHeight="14" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" :style="{ fill: `var(--${c})` }" />
          </marker>
        </defs>
        <line
          v-for="(w, name) in WIRES"
          :key="name"
          v-bind="px(w)"
          :style="{ stroke: `var(--${w.color})`, color: `var(--${w.color})` }"
          :class="{ lit: lit.has(name), held: held(name) }"
          :marker-end="`url(#arrow-${w.color})`"
          :marker-start="w.arrows === 'both' ? `url(#arrow-${w.color})` : undefined"
        />
      </svg>
      <div v-for="p in state.pulses" :key="p.id" class="dot" :class="{ beat: p.beat }" :style="dot(p.wire, p.from)"></div>

      <PartyBox name="A" role="the server" color="A" area="1 / 1" :online="state.A.connected" :asleep="phaseA === 'hibernating'">
        <template #status><SleepStatus :phase="phaseA" :seconds="secondsA" /></template>
        <div class="kpi">
          <span class="label">latest moment</span>
          <span class="value mono">{{ short(state.A.latest) }}</span>
        </div>
        <h3><code>tickets/{id}</code></h3>
        <TicketTable :tickets="state.A.tickets" />
        <h3>subscriptions</h3>
        <ul class="plain">
          <li v-for="(s, i) in state.A.subscriptions" :key="i">
            <span class="who" :style="{ color: `var(--${s.client})` }">{{ s.client }}</span>
            <span class="mono">{{ s.template }}</span>
          </li>
          <li v-if="!state.A.subscriptions.length" class="none">none</li>
        </ul>
      </PartyBox>

      <PartyBox name="B" role="the gateway" color="B" area="1 / 3" :online="state.B.connected" :asleep="phaseB === 'hibernating'">
        <template #status><SleepStatus :phase="phaseB" :seconds="secondsB" /></template>
        <p class="note">Takes each client's webhooks, checks each signature, and passes the event down that client's socket.</p>
        <div class="pair">
          <div v-for="client in CLIENTS" :key="client" class="half">
            <div class="half-head"><span class="who" :style="{ color: `var(--${client})` }">{{ client }}</span></div>
            <h3>socket</h3>
            <div :class="hasSocket(client) ? 'ok' : 'none'">{{ hasSocket(client) ? 'connected' : 'not connected' }}</div>
            <h3>last delivery</h3>
            <div class="mono">{{ state.B.lastStatus[client] ?? '—' }}</div>
          </div>
        </div>
      </PartyBox>

      <PartyBox v-for="client in CLIENTS" :key="client" :name="client" :role="scene.roles[client]" :color="client" :area="client === 'X' ? '3 / 1' : '3 / 3'" :online="state[client].ready">
        <div class="kpi">
          <span class="label">caught up to</span>
          <span class="value mono">{{ short(state[client].caughtUpTo) }}</span>
          <span v-if="state[client].waiting" class="waiting">{{ state[client].waiting }} event waiting</span>
        </div>
        <h3>copies of <code>tickets/{id}</code></h3>
        <TicketTable :tickets="state[client].copies" :current="current" />
        <h3 v-if="state[client].log.length">events</h3>
        <ul class="plain log">
          <li v-for="(entry, i) in state[client].log" :key="i" :class="entry.tone">{{ entry.text }}</li>
        </ul>
      </PartyBox>

      <WireLabel
        v-for="(w, name) in WIRES"
        :key="`label-${name}`"
        :label="w.label"
        :kind="w.kind"
        :color="w.color"
        :x="w.lx"
        :y="w.ly"
        :align="w.align"
        :above="w.ly >= 50"
        :pinned="state.pinned === name"
        :view="state.wires[name]"
        :since="state.since"
        :quiet="!lit.has(name) && !held(name)"
        @toggle="toggle(name)"
      />
    </main>

    <footer class="steps" :style="{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }">
      <button
        v-for="s in steps"
        :key="s.n"
        class="step"
        :class="{ done: state.done >= s.n, next: state.done + 1 === s.n, auto: 'auto' in s }"
        :disabled="state.busy || state.done + 1 !== s.n || 'auto' in s"
        @click="step(s.n)"
      >
        <span class="n">{{ state.done >= s.n ? '✓' : s.n }}</span>
        <span class="t">{{ s.title }}<span v-if="'auto' in s" class="by-itself">happens by itself</span></span>
      </button>
    </footer>
  </div>
</template>

<style scoped>
.app {
  display: grid;
  grid-template-rows: auto 1fr auto;
  height: 100vh;
  padding: 18px 26px 18px;
  gap: 16px;
}

.top {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 28px;
}

.brand h1 {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.brand p {
  margin: 2px 0 0;
  color: var(--muted);
  font-size: 15px;
}

.pr {
  display: inline-block;
  margin-top: 4px;
  font-size: 13px;
  color: var(--faint);
  text-decoration: none;
}

.pr:hover {
  color: var(--muted);
}

.caption {
  text-align: center;
}

.now {
  font-size: 24px;
  font-weight: 600;
}

.line {
  margin-top: 4px;
  font-size: 16.5px;
  color: #c4ccda;
}

.status {
  margin-top: 4px;
  font-size: 14px;
  color: var(--muted);
}

.status.error {
  color: var(--bad);
}

.controls {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.controls .row {
  display: flex;
  gap: 10px;
}

.scene {
  margin-top: 4px;
  max-width: 460px;
  padding: 4px 30px 4px 10px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%238b95a8'/%3E%3C/svg%3E") no-repeat right 10px center;
  color: var(--muted);
  font: inherit;
  font-size: 15px;
  appearance: none;
  cursor: pointer;
}

.scene:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--muted);
}

.scene option:disabled {
  color: var(--faint);
}

.controls input {
  width: 190px;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text);
  font: inherit;
  font-size: 14px;
}

.prepare {
  padding: 9px 18px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--panel-2);
  font-weight: 600;
}

.prepare:hover:not(:disabled) {
  border-color: var(--muted);
}

.stage {
  position: relative;
  display: grid;
  grid-template-columns: 41% 18% 41%;
  grid-template-rows: 40% 20% 40%;
  min-height: 0;
}

.wires {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 1;
  overflow: visible;
}

.wires line {
  stroke-width: 2.5;
  opacity: 0.2;
  stroke-dasharray: 6 6;
  transition: opacity 300ms;
}

/* A socket B holds open stays drawn, solid, even while B hibernates and costs nothing. */
.wires line.held {
  opacity: 0.8;
  stroke-dasharray: none;
}

.wires line.lit {
  opacity: 0.95;
  stroke-dasharray: none;
  filter: drop-shadow(0 0 6px currentColor);
}

.dot {
  position: absolute;
  z-index: 4;
  width: 16px;
  height: 16px;
  margin: -8px 0 0 -8px;
  border-radius: 50%;
  background: var(--c);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--c) 30%, transparent), 0 0 22px var(--c);
  animation: travel 900ms cubic-bezier(0.45, 0, 0.25, 1) forwards;
}

/* A heartbeat: a small hollow dot, quicker than a message. */
.dot.beat {
  width: 9px;
  height: 9px;
  margin: -4.5px 0 0 -4.5px;
  background: var(--bg);
  border: 2px solid var(--c);
  box-shadow: 0 0 10px var(--c);
  animation-duration: 650ms;
}

@keyframes travel {
  from {
    left: var(--x0);
    top: var(--y0);
    opacity: 1;
  }
  90% {
    opacity: 1;
  }
  to {
    left: var(--x1);
    top: var(--y1);
    opacity: 0;
  }
}

.kpi {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 6px;
}

.kpi .label {
  color: var(--muted);
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.07em;
}

.kpi .value {
  font-size: 30px;
  font-weight: 500;
}

.waiting {
  margin-left: auto;
  padding: 3px 12px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--stale) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--stale) 55%, transparent);
  color: var(--stale);
  font-size: 13px;
  font-weight: 600;
  animation: breathe 1.4s ease-in-out infinite;
}

@keyframes breathe {
  50% {
    opacity: 0.55;
  }
}

h3 {
  margin: 12px 0 4px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--faint);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

h3 code {
  text-transform: none;
  letter-spacing: 0;
  color: var(--muted);
}

.note {
  margin: 0 0 4px;
  color: var(--muted);
  font-size: 14.5px;
  line-height: 1.45;
}

.plain {
  margin: 0;
  padding: 0;
  list-style: none;
}

.plain li {
  display: flex;
  gap: 12px;
  padding: 3px 0;
}

.who {
  font-weight: 700;
  min-width: 1.2em;
}

.ok {
  color: var(--ok);
}

.none {
  color: var(--faint);
}

.log li {
  font-family: var(--mono);
  font-size: 14px;
}

.log li.skip {
  color: var(--muted);
}

.log li.catch {
  color: var(--ok);
}

.steps {
  display: grid;
  gap: 12px;
}

.step {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: var(--panel);
  text-align: left;
  color: var(--faint);
  transition: border-color 160ms, background 160ms;
}

.step .n {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid currentColor;
  font-weight: 700;
  font-size: 14px;
}

.step .t {
  font-size: 15px;
  font-weight: 500;
  line-height: 1.25;
}

.step.done {
  color: var(--muted);
}

.step.done .n {
  background: var(--ok);
  border-color: var(--ok);
  color: #0a0e16;
}

.step.next {
  color: var(--text);
  border-color: var(--text);
  background: var(--panel-2);
  box-shadow: 0 0 0 3px #e6eaf21a;
}

.step.next:hover:not(:disabled) {
  background: #1d2536;
}

.by-itself {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  font-weight: 400;
  color: var(--faint);
}

.pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  margin-top: 8px;
}

.half {
  padding: 10px 14px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #0d121c;
}

.half-head {
  font-size: 18px;
  margin-bottom: 2px;
}

.half h3 {
  margin-top: 8px;
}
</style>
