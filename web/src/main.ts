import { createApp } from 'vue';
import Antd from 'ant-design-vue';
import 'ant-design-vue/dist/reset.css';
import App from './App.vue';
import { router } from './router';

// AntD 全量注册：构建产物 tree-shake 收益有限，但换来了 SFC 内零样板按需引用的简单性
createApp(App).use(Antd).use(router).mount('#app');
