<template>
  <figure class="home-visual" aria-labelledby="notes-visual-title">
    <div class="home-visual-heading"><span class="visual-index">01 / EXAMPLE</span><span>便签助手</span><span class="visual-mode">离线示意</span></div>
    <svg class="home-visual-canvas" viewBox="0 0 520 360" role="img" aria-labelledby="notes-visual-title notes-visual-description">
      <title id="notes-visual-title">从两张便签到一张待办</title>
      <desc id="notes-visual-description">固定脚本通过 Tool 依次调用两次 readNote，再调用一次 writeNote。工具通过受控资源访问内存便签，收到成功反馈后回答。</desc>
      <defs>
        <pattern id="notes-grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.8" class="visual-grid-dot" /></pattern>
        <marker id="notes-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7" class="visual-arrow" /></marker>
      </defs>
      <rect width="520" height="360" fill="url(#notes-grid)" />
      <path d="M124 143 V216" class="visual-line" marker-end="url(#notes-arrow)" />
      <path d="M214 246 H253 V115 H214" class="visual-line visual-feedback" marker-end="url(#notes-arrow)" />
      <path d="M214 267 H314" class="visual-line" marker-end="url(#notes-arrow)" />
      <path d="M399 230 V198" class="visual-line" marker-end="url(#notes-arrow)" />
      <text x="137" y="183" class="visual-label">工具选择</text>
      <text x="265" y="183" class="visual-label" transform="rotate(-90 265 183)">成功反馈</text>
      <text x="274" y="290" class="visual-label" text-anchor="middle">受控操作</text>
      <rect x="34" y="65" width="180" height="78" rx="5" class="visual-box" />
      <text x="50" y="91" class="visual-eyebrow">PROVIDER</text>
      <text x="50" y="119" class="visual-title">固定脚本选择下一步</text>
      <rect x="34" y="216" width="180" height="72" rx="5" class="visual-box visual-tool-box" />
      <text x="50" y="243" class="visual-title">Tool</text>
      <text x="50" y="269" class="visual-code">readNote · writeNote</text>
      <rect x="314" y="230" width="172" height="58" rx="5" class="visual-box" />
      <text x="330" y="255" class="visual-title">Notes</text>
      <text x="330" y="274" class="visual-label">内存中的独立实体</text>
      <rect x="321" y="49" width="165" height="143" rx="4" class="visual-paper-back" />
      <rect x="313" y="55" width="165" height="143" rx="4" class="visual-paper" />
      <path d="M329 94 H462" class="visual-paper-rule" />
      <text x="329" y="82" class="visual-title">待办</text>
      <text x="329" y="117" class="visual-note">— 整理用户反馈</text>
      <text x="329" y="143" class="visual-note">— 发送演示链接</text>
      <text x="329" y="169" class="visual-note">— 检查安装步骤</text>
      <text x="34" y="333" class="visual-step">READ × 2</text>
      <path d="M122 328 H177 M286 328 H341" class="visual-step-line" marker-end="url(#notes-arrow)" />
      <text x="195" y="333" class="visual-step">WRITE × 1</text>
      <text x="360" y="333" class="visual-step">ANSWER</text>
    </svg>
    <figcaption>读取两张便签 → 创建待办 → 确认后回答<span>固定决策脚本 · 仅内存 · 无需 API Key</span></figcaption>
  </figure>
</template>
