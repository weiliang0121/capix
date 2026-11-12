import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import Diagram from './Diagram.vue';
import HomeVisual from './HomeVisual.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'home-hero-info-before': () => h('p', { class: 'home-eyebrow' }, 'COMPOSABLE AGENT FRAMEWORK'),
      'home-hero-image': () => h(HomeVisual),
    });
  },
  enhanceApp({ app }) {
    app.component('CapixDiagram', Diagram);
  },
};
