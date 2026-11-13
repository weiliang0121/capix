<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useData } from 'vitepress';

const { isDark } = useData();
const surface = ref(null);
const status = ref('loading');
const motion = ref({ playing: false, canAnimate: false, settled: false, chapter: 0 });
const chapters = [
  { label: '已有能力', title: '从你已有的能力开始', description: '文件、数据、接口、脚本，以及模型。' },
  { label: '组织工作', title: '让能力一起工作', description: '程序组织步骤，模型参与判断。' },
  { label: '继续组合', title: '组合也成为新的能力', description: '每一层各司其职，继续参与更大的工作。' },
];
const chapter = computed(() => chapters[motion.value.chapter]);
let scene;
let observer;
let disposed = false;
let loading = false;

async function loadScene() {
  if (loading || disposed) return;
  loading = true;
  observer?.disconnect();
  try {
    const { createCompositionScene } = await import('./composition-scene.mjs');
    if (disposed) return;
    scene = createCompositionScene(surface.value, {
      dark: isDark.value,
      ready: () => {
        if (!disposed) status.value = 'ready';
      },
      unavailable: () => {
        if (!disposed) status.value = 'unavailable';
      },
      motion: (value) => {
        if (!disposed) motion.value = value;
      },
    });
  } catch {
    if (!disposed) status.value = 'unavailable';
  }
}

onMounted(() => {
  if (!('IntersectionObserver' in window)) return void loadScene();
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadScene();
    },
    { rootMargin: '240px' },
  );
  observer.observe(surface.value);
});

watch(isDark, (value) => scene?.setTheme(value));

onBeforeUnmount(() => {
  disposed = true;
  observer?.disconnect();
  scene?.dispose();
});
</script>

<template>
  <figure class="composition-visual" :data-renderer="status" :data-phase="motion.settled ? 'settled' : motion.playing ? 'playing' : 'paused'" :data-playing="motion.playing" aria-label="已有能力和模型共同组成工作，组合本身也可以成为下一层的成员">
    <div class="composition-stage">
      <div ref="surface" class="composition-scene" :class="{ 'scene-ready': status === 'ready' }">
        <div class="composition-description" :class="{ 'visually-hidden': status === 'ready' }">
          <p>镜头沿悬浮的星体侧面连续绕行、拉远，逐渐揭示下方波动的曲面。同一批星体落下、展开，逐渐组成太阳系。镜头绕行升高，显出银灰星体、细虚线轨道与下方的石墨黑引力曲面，最后停下来观看它们持续运行。可以暂停或重播这次组合。</p>
          <p>这段固定编排展示能力逐层组合的关系，不代表真实天体尺度或框架执行轨迹。</p>
        </div>
      </div>
      <div v-if="status === 'ready'" class="scene-story" aria-hidden="true">
        <div class="scene-story-heading">
          <span class="scene-story-brand">CAPiX</span>
          <span class="scene-story-divider"></span>
          <span class="scene-story-label">能力的组合</span>
        </div>
        <div class="scene-story-copy">
          <Transition name="story" appear>
            <div :key="motion.chapter" class="scene-story-chapter">
              <p class="scene-story-title">{{ chapter.title }}</p>
              <p class="scene-story-description">{{ chapter.description }}</p>
            </div>
          </Transition>
        </div>
        <div class="scene-story-steps">
          <span v-for="(item, index) in chapters" :key="item.label" :class="{ current: motion.chapter === index, passed: motion.chapter > index }"></span>
        </div>
      </div>
      <div v-if="status === 'ready' && motion.canAnimate" class="scene-controls">
        <button type="button" :aria-label="motion.playing ? '暂停组合动画' : '继续组合动画'" @click="motion.playing ? scene?.pause() : scene?.resume()">
          <svg v-if="motion.playing" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3 V13 M11 3 V13" /></svg>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 7 5-7 5V3Z" /></svg>
        </button>
        <button type="button" aria-label="重播组合动画" @click="scene?.replay()">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5 A5.5 5.5 0 1 1 2.7 10 M3 1 V5 H7" /></svg>
        </button>
      </div>
      <p v-if="status === 'unavailable'" class="scene-status" role="status">三维视图暂不可用，已保留结构说明。</p>
    </div>
    <figcaption class="visually-hidden">从已有的文件、数据、接口、脚本和模型开始，由程序组织步骤，让模型参与判断。组合也能成为新的能力，继续参与更大的工作。复杂从组合中展开，可靠由每一层的边界维持。</figcaption>
  </figure>
</template>

<style scoped>
.composition-visual {
  container-type: inline-size;
  margin: 32px 0 44px;
}
.composition-stage {
  position: relative;
  overflow: hidden;
  border: 1px solid rgb(255 255 255 / 10%);
  border-radius: 16px;
  color: #fafafa;
  background: #0a0a0a;
  color-scheme: dark;
}
.composition-scene {
  position: relative;
  width: 100%;
  height: 600px;
  isolation: isolate;
}
.composition-scene :deep(canvas) {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  opacity: 0;
  pointer-events: none;
}
.scene-ready :deep(canvas) {
  opacity: var(--scene-opacity, 1);
}
.scene-story {
  position: absolute;
  z-index: 1;
  inset: 0 0 auto;
  padding: 28px 32px 44px;
  background: linear-gradient(180deg, rgb(10 10 10 / 55%), rgb(10 10 10 / 0%));
  pointer-events: none;
}
.scene-story-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  font-size: 11px;
  line-height: 1.5;
  letter-spacing: 0.06em;
}
.scene-story-brand {
  color: #d4d4d4;
  font-weight: 600;
}
.scene-story-divider {
  width: 1px;
  height: 10px;
  background: rgb(255 255 255 / 18%);
}
.scene-story-label {
  color: #a1a1a1;
}
.scene-story-copy {
  display: grid;
}
.scene-story-chapter {
  grid-area: 1 / 1;
}
.scene-story-title {
  margin: 0;
  color: #e5e5e5;
  font-size: 23px;
  font-weight: 500;
  line-height: 1.5;
  letter-spacing: -0.025em;
}
.scene-story-description {
  max-width: 32em;
  margin: 8px 0 0;
  color: #a1a1a1;
  font-size: 13px;
  line-height: 1.7;
}
.scene-story-steps {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 19px;
}
.scene-story-steps span {
  width: 12px;
  height: 2px;
  border-radius: 1px;
  background: #404040;
  transition:
    width 500ms ease,
    background-color 500ms ease;
}
.scene-story-steps .passed {
  background: #737373;
}
.scene-story-steps .current {
  width: 28px;
  background: #d4d4d4;
}
.story-enter-active,
.story-leave-active {
  transition:
    opacity 420ms ease,
    transform 600ms cubic-bezier(0.22, 1, 0.36, 1);
}
.story-enter-from {
  opacity: 0;
  transform: translateY(7px);
}
.story-leave-to {
  opacity: 0;
  transform: translateY(-5px);
}
.scene-controls {
  position: absolute;
  z-index: 2;
  right: 16px;
  bottom: 16px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  transition:
    opacity 180ms ease,
    transform 180ms ease;
}
.scene-controls button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 44px;
  width: 44px;
  padding: 12px;
  border: 1px solid rgb(255 255 255 / 8%);
  border-radius: 50%;
  font-size: 11px;
  line-height: 1.5;
  color: #a1a1a1;
  background: rgb(23 23 23 / 80%);
  transition:
    color 160ms,
    background-color 160ms,
    border-color 160ms;
  cursor: pointer;
}
.scene-controls button:hover {
  border-color: rgb(255 255 255 / 15%);
  background: #262626;
  color: #fafafa;
}
.scene-controls button:focus-visible {
  outline: 2px solid #a1a1a1;
  outline-offset: 2px;
}
.scene-controls svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
@media (hover: hover) and (pointer: fine) {
  .scene-controls {
    opacity: 0;
    transform: translateY(4px);
    pointer-events: none;
  }
  .composition-stage:hover .scene-controls,
  .composition-stage:focus-within .scene-controls {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
  }
}
@media (prefers-reduced-motion: reduce) {
  .scene-controls,
  .scene-story-steps span,
  .story-enter-active,
  .story-leave-active {
    transition: none;
  }
  .story-enter-from,
  .story-leave-to {
    transform: none;
  }
}
.composition-description {
  display: flex;
  flex-direction: column;
  justify-content: center;
  height: 100%;
  max-width: 500px;
  margin: 0 auto;
  padding: 30px;
  color: #a1a1a1;
}
.composition-description p {
  margin: 10px 0;
  font-size: 15px;
  line-height: 1.9;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.scene-status {
  margin: 0;
  padding: 0 20px 20px;
  font-size: 12px;
  color: #a1a1a1;
  text-align: center;
}
@container (max-width: 600px) {
  .composition-scene {
    height: 380px;
  }
  .scene-story {
    padding: 20px 20px 32px;
  }
  .scene-story-heading {
    margin-bottom: 10px;
    font-size: 10px;
  }
  .scene-story-title {
    font-size: 19px;
  }
  .scene-story-description {
    max-width: 21em;
    margin-top: 5px;
    font-size: 12px;
  }
  .scene-story-steps {
    margin-top: 12px;
  }
}
</style>
