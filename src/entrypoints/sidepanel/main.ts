import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
// 暗色主题变量：html 挂 dark 类后 Element Plus 组件自动切换暗色
import 'element-plus/theme-chalk/dark/css-vars.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'

import App from './App.vue'
import { initTheme } from '../../utils/theme'

// 先把主题定下来再挂载：主题存在 storage 里，异步读完再渲染才不会先闪一下亮色
async function bootstrap() {
  await initTheme()

  const app = createApp(App)

  // 注册 Element Plus 所有图标
  for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
    app.component(key, component)
  }

  app.use(ElementPlus)
  app.mount('#app')
}

void bootstrap()
