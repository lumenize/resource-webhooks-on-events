<script setup lang="ts">
// `online` is whether the page can see the party, and `asleep` whether it hibernates. A box can
// put a status of its own in the corner while it is online, where the others say they are live.
defineProps<{ name: string; role: string; color: string; area: string; online?: boolean; asleep?: boolean }>();
</script>

<template>
  <section class="box" :class="{ offline: online === false, asleep: online !== false && asleep }" :style="{ '--c': `var(--${color})`, gridArea: area }">
    <header>
      <span class="badge">{{ name }}</span>
      <span class="role">{{ role }}</span>
      <span class="corner">
        <slot v-if="online !== false" name="status">
          <span v-if="online !== undefined" class="online on">live</span>
        </slot>
        <span v-else class="online">offline</span>
      </span>
    </header>
    <div class="body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.box {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: linear-gradient(180deg, color-mix(in srgb, var(--c) 7%, var(--panel)), var(--panel) 120px);
  border: 1px solid color-mix(in srgb, var(--c) 38%, var(--line));
  border-radius: 14px;
  box-shadow: 0 0 0 1px #0004, 0 18px 40px -24px color-mix(in srgb, var(--c) 45%, transparent);
  overflow: hidden;
  transition: filter 0.4s, opacity 0.4s;
}

/* A party that is offline greys out whole. */
.box.offline {
  filter: grayscale(1);
  opacity: 0.45;
}

/* A party that hibernates dims partway, fading as it leaves memory, since its sockets stay open
   and the next event still reaches it. It wakes at once. */
.box.asleep {
  filter: saturate(0.3) brightness(0.8);
  transition-duration: 1.2s;
}

.corner {
  margin-left: auto;
}

header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px 10px;
  border-bottom: 1px solid var(--line);
}

.badge {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: var(--c);
  color: #0a0e16;
  font-weight: 700;
  font-size: 19px;
}

.role {
  font-weight: 600;
  font-size: 18px;
  letter-spacing: 0.01em;
}

.online {
  font-size: 13px;
  color: var(--faint);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.online.on {
  color: var(--ok);
}

.online.on::before {
  content: '';
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--ok);
  vertical-align: 1px;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 18px 14px;
}
</style>
