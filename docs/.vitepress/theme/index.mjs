import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import Diagram from './Diagram.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'home-hero-info-before': () => h('p', { class: 'home-eyebrow' }, 'COMPOSE · OBSERVE · RECOVER'),
    });
  },
  enhanceApp({ app }) {
    app.component('CapixDiagram', Diagram);
  },
};
