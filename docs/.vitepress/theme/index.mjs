import DefaultTheme from 'vitepress/theme';
import Diagram from './Diagram.vue';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('CapixDiagram', Diagram);
  },
};
