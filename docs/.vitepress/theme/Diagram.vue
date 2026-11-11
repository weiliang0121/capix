<script setup>
import { onMounted, ref, watch } from 'vue';
import { useData } from 'vitepress';

const props = defineProps({ source: { type: String, required: true } });
const { isDark } = useData();
const svg = ref('');
const failure = ref('');
let revision = 0;

async function render() {
  const current = ++revision;
  try {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDark.value ? 'dark' : 'default', flowchart: { useMaxWidth: false }, sequence: { useMaxWidth: false } });
    const diagram = await mermaid.render(`capix-diagram-${crypto.randomUUID()}`, props.source);
    if (current === revision) {
      svg.value = diagram.svg;
      failure.value = '';
    }
  } catch (error) {
    if (current === revision) {
      svg.value = '';
      failure.value = `图示暂无法渲染：${error.message}`;
    }
  }
}
onMounted(render);
watch([() => props.source, isDark], render);
</script>

<template>
  <figure class="capix-diagram">
    <div v-if="svg" class="capix-diagram-image" role="img" aria-label="契约关系图，可在图内滚动查看" tabindex="0" v-html="svg" />
    <figcaption v-if="svg">较大图表可在图内滚动查看。</figcaption>
    <p v-if="failure" role="status">{{ failure }}</p>
    <details :open="!!failure">
      <summary>查看图示源码</summary>
      <pre>{{ source }}</pre>
    </details>
  </figure>
</template>

<style>
.capix-diagram {
  margin: 24px 0;
}
.capix-diagram-image {
  max-height: 70vh;
  overflow: auto;
}
.capix-diagram-image svg {
  display: block;
  height: auto;
  max-width: none;
  margin: 0 auto;
}
.capix-diagram pre {
  overflow-x: auto;
  padding: 16px;
  background: var(--vp-code-block-bg);
}
.capix-diagram figcaption {
  margin-top: 8px;
  color: var(--vp-c-text-2);
  font-size: 14px;
}
.capix-diagram summary {
  cursor: pointer;
  font-size: 14px;
}
</style>
