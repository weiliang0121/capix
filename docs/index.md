---
layout: home
markdownStyles: false
hero:
  name: CAPiX
  text: 把 Agent 的每一步，<br>组织清楚。
  tagline: 可组合、可观测的 Agent 框架。从一个便签助手开始，用结构组织工作，用资源开放能力，逐层建立可靠边界。
  actions:
    - theme: brand
      text: 从便签助手开始 →
      link: /guide/getting-started
    - theme: alt
      text: 为什么用 CAPiX
      link: /why
---

<div class="home-content">
  <div class="home-intro">
    <p class="home-eyebrow">STRUCTURE → CAPABILITY → FACTS</p>
    <h2>让程序和模型，各尽其责。</h2>
    <p>程序表达固定步骤与业务规则，模型在登记工具中提出选择。CAPiX 将它们组织进同一棵结构，让能力的开放、内容的变化和调用的结果都有明确归属。</p>
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
      <p class="home-eyebrow">LEARN BY BUILDING</p>
      <h2>从可运行的代码，理解协作。</h2>
      <p>快速开始提供完整源码与调用时序。从离线运行看清工具循环，再按需接入真实模型。</p>
    </div>
    <a class="home-next-link" href="./guide/getting-started">打开快速开始 <span aria-hidden="true">→</span></a>
  </div>
</div>
