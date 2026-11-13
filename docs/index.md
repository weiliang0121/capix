---
layout: home
markdownStyles: false
hero:
  name: CAPiX
  text: 组合已有能力，<br>构筑自己的智能体。
  tagline: 可组合、可观测、可恢复的 Agent 框架。通过资源接入能力，通过实体承载内容，让程序与模型共同推进工作。
  actions:
    - theme: brand
      text: 构建第一个智能体 →
      link: /guide/getting-started
    - theme: alt
      text: 为什么用 CAPiX
      link: /why
---

<script setup>
import CompositionVisual from './.vitepress/theme/CompositionVisual.vue';
</script>

<div class="home-composition">
  <CompositionVisual />
</div>

<div class="home-content">
  <nav class="home-learning" aria-label="文档学习路径">
    <a href="./guide/getting-started">
      <span class="principle-index">01 / 教程</span>
      <h2>先运行，再动手</h2>
      <p>构建便签助手，走通一次工具循环。</p>
      <span class="home-learning-link">构建第一个智能体 →</span>
    </a>
    <a href="./concepts/">
      <span class="principle-index">02 / 概念</span>
      <h2>理解各层的职责</h2>
      <p>沿着结构、资源与调用，认识组合方式。</p>
      <span class="home-learning-link">阅读核心概念 →</span>
    </a>
    <a href="./README">
      <span class="principle-index">03 / 参考</span>
      <h2>按需查阅契约</h2>
      <p>遇到具体问题，查清行为、依据与边界。</p>
      <span class="home-learning-link">打开契约索引 →</span>
    </a>
  </nav>
  <div class="home-intro">
    <p class="home-eyebrow">BUILT THROUGH COMPOSITION</p>
    <h2>复杂从组合中展开，可靠由每一层的边界维持。</h2>
    <p>从已有的系统、接口、文件与代码开始，让模型参与理解、判断和生成。一个节点完成一部分工作，一个组合也能成为下一层的能力；每一层都说清可用的操作与结果的交接。</p>
  </div>
  <div class="home-principles">
    <section>
      <span class="principle-index">01 / COMPOSE</span>
      <h3>用结构组织工作</h3>
      <p>Node 表达一步工作，Group 组合成员，Scene 组织入口。Tool 是普通 Group 预设，可以继续与程序步骤组合。</p>
      <a href="./examples/structure">看结构与资源 <span aria-hidden="true">↗</span></a>
    </section>
    <section>
      <span class="principle-index">02 / OBSERVE</span>
      <h3>让事实各有归属</h3>
      <p>业务内容、模型交换与调用拥有各自的事实和生命周期。按需要接入记录与诊断，追踪发生了什么。</p>
      <a href="./examples/runtime">看工具与记录 <span aria-hidden="true">↗</span></a>
    </section>
    <section>
      <span class="principle-index">03 / RECOVER</span>
      <h3>把恢复边界写清楚</h3>
      <p>Checkpoint 依靠显式恢复点和完整依据。恢复范围由契约约束，不承诺恢复 JavaScript 栈或任意外部效果。</p>
      <a href="./checkpoints">阅读恢复契约 <span aria-hidden="true">↗</span></a>
    </section>
  </div>

  <div class="home-next">
    <div>
      <p class="home-eyebrow">WHY CAPiX</p>
      <h2>这些边界，从具体的问题中来。</h2>
      <p>了解这套分解方式的选择、适用场景与使用代价。</p>
    </div>
    <a class="home-next-link" href="./why">为什么用 CAPiX <span aria-hidden="true">→</span></a>
  </div>

  <section class="home-credits" aria-labelledby="creation-and-thanks">
    <p class="home-eyebrow">ACKNOWLEDGEMENTS</p>
    <h2 id="creation-and-thanks">创作与致谢</h2>
    <p>CAPiX 由 <a href="https://github.com/weiliang0121">wei.liang</a> 与 Codex 共同设计和实现。</p>
    <p>从最初的想法到架构、代码与验证，项目在持续的讨论与协作中逐步成形。</p>
    <p>也感谢 GPT-6 Astra 及其他 Agent 在讨论、分析和交叉审查中提供的意见。</p>
  </section>
</div>
