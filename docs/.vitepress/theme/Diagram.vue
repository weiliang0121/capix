<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { useData } from 'vitepress';

const props = defineProps({ source: { type: String, required: true } });
const { isDark } = useData();
const diagramId = useId();
const viewport = ref();
const svg = ref('');
const failure = ref('');
const width = ref(800);
const height = ref(400);
const scale = ref(1);
const automatic = ref(true);
const expandedDialog = ref();
const expanded = ref(false);
const expandedViewport = ref();
const imageUrl = computed(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.value)}`);
const kind = computed(() => (props.source.includes('sequenceDiagram') ? '时序图' : '关系图'));
const canvasStyle = computed(() => ({ width: `${width.value * scale.value}px`, height: `${height.value * scale.value}px` }));
let revision = 0;
let observer;

function fit() {
  automatic.value = true;
  const activeViewport = expanded.value ? expandedViewport.value : viewport.value;
  if (activeViewport) scale.value = Math.max(0.1, Math.min(1, (activeViewport.clientWidth - 40) / width.value));
}

function zoom(amount) {
  automatic.value = false;
  scale.value = Math.max(0.1, Math.min(3, scale.value + amount));
}

async function toggleExpanded() {
  if (expanded.value) {
    expandedDialog.value.close();
    return;
  }
  expandedDialog.value.showModal();
  expanded.value = true;
  await nextTick();
  fit();
}

function closeExpanded() {
  expanded.value = false;
  nextTick(fit);
}

function download() {
  const url = URL.createObjectURL(new Blob([svg.value], { type: 'image/svg+xml;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'capix-diagram.svg';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function render() {
  const current = ++revision;
  const dark = isDark.value;
  try {
    const { default: mermaid } = await import('mermaid');
    const theme = { theme: 'base', look: 'classic' };
    mermaid.initialize({
      ...theme,
      startOnLoad: false,
      securityLevel: 'strict',
      // SVG text keeps measured labels independent of the document's paragraph styles.
      htmlLabels: false,
      fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      themeVariables: {
        darkMode: dark,
        background: dark ? '#171717' : '#ffffff',
        primaryColor: dark ? '#171717' : '#ffffff',
        primaryTextColor: dark ? '#fafafa' : '#0a0a0a',
        primaryBorderColor: dark ? '#737373' : '#a1a1a1',
        secondaryColor: dark ? '#262626' : '#f5f5f5',
        tertiaryColor: dark ? '#262626' : '#f5f5f5',
        lineColor: '#737373',
        textColor: dark ? '#fafafa' : '#0a0a0a',
        clusterBkg: dark ? '#262626' : '#f5f5f5',
        clusterBorder: dark ? '#404040' : '#d4d4d4',
        edgeLabelBackground: dark ? '#171717' : '#ffffff',
        actorBkg: dark ? '#171717' : '#ffffff',
        actorBorder: dark ? '#737373' : '#a1a1a1',
        actorTextColor: dark ? '#fafafa' : '#0a0a0a',
        actorLineColor: dark ? '#525252' : '#a1a1a1',
        signalColor: dark ? '#d4d4d4' : '#525252',
        signalTextColor: dark ? '#fafafa' : '#0a0a0a',
        labelBoxBkgColor: dark ? '#262626' : '#f5f5f5',
        labelBoxBorderColor: dark ? '#525252' : '#d4d4d4',
        labelTextColor: dark ? '#fafafa' : '#0a0a0a',
        loopTextColor: dark ? '#fafafa' : '#0a0a0a',
        activationBkgColor: dark ? '#404040' : '#e5e5e5',
        activationBorderColor: '#737373',
        noteBkgColor: dark ? '#262626' : '#f5f5f5',
        noteBorderColor: dark ? '#525252' : '#a1a1a1',
        noteTextColor: dark ? '#fafafa' : '#0a0a0a',
        fontSize: '14px',
      },
      flowchart: { ...theme, useMaxWidth: false, curve: 'basis', nodeSpacing: 36, rankSpacing: 44, padding: 18 },
      sequence: { ...theme, useMaxWidth: false, mirrorActors: false, actorFontSize: 14, messageFontSize: 14, noteFontSize: 13, actorMargin: 48, messageMargin: 36, wrap: true },
    });
    // DOM identity only: keep diagrams distinct without requiring HTTPS on LAN previews.
    const diagram = await mermaid.render(`capix-diagram-${diagramId}-${current}`, props.source);
    if (current !== revision) return;
    const parsed = new DOMParser().parseFromString(diagram.svg, 'image/svg+xml');
    const box = parsed.documentElement
      .getAttribute('viewBox')
      ?.split(/[\s,]+/)
      .map(Number);
    if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) throw new Error('无效的图示尺寸');
    width.value = box[2];
    height.value = box[3];
    svg.value = diagram.svg;
    failure.value = '';
    await nextTick();
    fit();
  } catch (error) {
    if (current === revision) {
      svg.value = '';
      failure.value = `图示暂无法渲染：${error.message}`;
    }
  }
}

onMounted(() => {
  observer = new ResizeObserver(() => {
    if (automatic.value) fit();
  });
  observer.observe(viewport.value);
  observer.observe(expandedViewport.value);
  render();
});
onBeforeUnmount(() => {
  revision++;
  observer?.disconnect();
});
watch([() => props.source, isDark], render);
</script>

<template>
  <div class="capix-diagram-host">
    <dialog ref="expandedDialog" class="capix-diagram-dialog" :aria-label="`展开${kind}`" @close="closeExpanded">
      <div class="capix-diagram-expanded">
        <div class="capix-diagram-toolbar">
          <span class="capix-diagram-label">{{ kind }} · 展开查看</span>
          <div class="capix-diagram-controls" aria-label="大图操作">
            <button type="button" aria-label="缩小图示" :disabled="scale <= 0.1" @click="zoom(-0.2)">−</button>
            <span class="capix-diagram-scale">{{ Math.round(scale * 100) }}%</span>
            <button type="button" aria-label="放大图示" :disabled="scale >= 3" @click="zoom(0.2)">+</button>
            <button type="button" @click="fit">适合宽度</button>
            <button type="button" autofocus @click="toggleExpanded">收起大图</button>
          </div>
        </div>
        <div ref="expandedViewport" class="capix-diagram-viewport" tabindex="0" :aria-label="`${kind}大图，可滚动查看`">
          <img v-if="expanded && svg" class="capix-diagram-expanded-image" :src="imageUrl" :style="canvasStyle" :alt="`${kind}；文字描述见正文图示源码`" />
        </div>
      </div>
    </dialog>
    <figure class="capix-diagram">
      <div class="capix-diagram-toolbar">
        <span class="capix-diagram-label"><span class="capix-diagram-mark" aria-hidden="true">◇</span>{{ kind }}</span>
        <div v-if="svg" class="capix-diagram-controls" aria-label="图示操作">
          <button type="button" aria-label="缩小图示" :disabled="scale <= 0.1" @click="zoom(-0.2)">−</button>
          <span class="capix-diagram-scale">{{ Math.round(scale * 100) }}%</span>
          <button type="button" aria-label="放大图示" :disabled="scale >= 3" @click="zoom(0.2)">+</button>
          <button type="button" @click="fit">适合宽度</button>
          <button type="button" :aria-expanded="expanded" @click="toggleExpanded">{{ expanded ? '收起大图' : '展开' }}</button>
          <button type="button" @click="download">SVG ↓</button>
        </div>
      </div>
      <div ref="viewport" class="capix-diagram-viewport" :tabindex="svg ? 0 : undefined" :aria-label="`${kind}，可滚动查看`">
        <div v-if="svg" class="capix-diagram-canvas" role="img" :aria-label="`${kind}；文字描述见下方图示源码`" :style="canvasStyle" v-html="svg" />
        <p v-else role="status">{{ failure || '正在绘图…' }}</p>
      </div>
      <details :open="!!failure" class="capix-diagram-source">
        <summary>图示源码<span class="capix-diagram-hint"> · 图内可滚动查看</span></summary>
        <pre>{{ source }}</pre>
      </details>
    </figure>
  </div>
</template>

<style>
.capix-diagram {
  margin: 28px 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--capix-card);
  overflow: hidden;
}
.capix-diagram-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 48px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
}
.capix-diagram-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--vp-c-text-2);
}
.capix-diagram-mark {
  color: var(--vp-c-brand-1);
  font-size: 20px;
}
.capix-diagram-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.capix-diagram-controls button {
  padding: 3px 7px;
  border: 1px solid transparent;
  border-radius: 6px;
  font-size: 12px;
  line-height: 24px;
  color: var(--vp-c-text-2);
}
.capix-diagram-controls button:hover:not(:disabled) {
  border-color: var(--capix-input);
  background: var(--capix-soft);
  color: var(--vp-c-brand-1);
}
.capix-diagram-controls button:disabled {
  opacity: 0.35;
  cursor: default;
}
.capix-diagram-controls button:focus-visible,
.capix-diagram-viewport:focus-visible,
.capix-diagram-source summary:focus-visible {
  outline: 2px solid var(--capix-ring);
  outline-offset: -2px;
}
.capix-diagram-scale {
  min-width: 34px;
  text-align: center;
  color: var(--vp-c-text-3);
  font: 11px var(--vp-font-family-mono);
}
.capix-diagram-viewport {
  max-height: 75vh;
  min-height: 100px;
  padding: 20px;
  overflow: auto;
  background-image: radial-gradient(var(--vp-c-divider) 0.7px, transparent 0.7px);
  background-size: 18px 18px;
}
.capix-diagram-canvas {
  margin: 0 auto;
}
.capix-diagram-canvas svg {
  display: block;
  width: 100%;
  height: 100%;
  max-width: none;
}
.capix-diagram-source {
  border-top: 1px solid var(--vp-c-divider);
  padding: 8px 16px;
  color: var(--vp-c-text-2);
  font-size: 12px;
}
.capix-diagram-source summary {
  cursor: pointer;
}
.capix-diagram-hint {
  color: var(--vp-c-text-3);
  font-weight: 400;
}
.capix-diagram-source pre {
  overflow-x: auto;
  font-size: 12px;
}
.capix-diagram-dialog {
  width: 96vw;
  height: 94vh;
  max-width: 1600px;
  max-height: 94vh;
  margin: auto;
  padding: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--capix-card);
  color: var(--vp-c-text-1);
}
.capix-diagram-dialog::backdrop {
  background: rgb(0 0 0 / 70%);
  backdrop-filter: blur(3px);
}
.capix-diagram-expanded {
  width: 100%;
  height: 100%;
  margin: 0;
  display: flex;
  flex-direction: column;
  border: 0;
  border-radius: 0;
}
.capix-diagram-expanded-image {
  display: block;
  max-width: none;
  margin: 0 auto;
}
.capix-diagram-dialog .capix-diagram-viewport {
  flex: 1;
  max-height: none;
}
</style>
