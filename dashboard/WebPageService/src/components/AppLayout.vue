<template>
  <a-layout style="min-height: 100vh;">
    <a-layout-sider v-model:collapsed="collapsed" collapsible :trigger="null" :width="208">
      <div class="logo">OTMC</div>
      <a-menu
        theme="dark"
        mode="inline"
        :selected-keys="selectedKeys"
        :open-keys="openKeys"
        @open-change="(keys) => (openKeys = keys)"
      >
        <template v-for="item in menuConfig" :key="item.key">
          <a-sub-menu v-if="item.children" :key="item.key">
            <template #title>
              <span>{{ item.title }}</span>
            </template>
            <a-menu-item v-for="child in item.children" :key="child.key">
              <a :href="child.path" class="menu-link">{{ child.title }}</a>
            </a-menu-item>
          </a-sub-menu>
          <a-menu-item v-else :key="item.key">
            <a v-if="item.path" :href="item.path" class="menu-link">{{ item.title }}</a>
            <span v-else>{{ item.title }}</span>
          </a-menu-item>
        </template>
      </a-menu>
    </a-layout-sider>

    <a-layout>
      <a-layout-header class="site-header">
        <div style="display:flex;align-items:center;gap:12px;">
          <a-button type="text" @click="collapsed = !collapsed">
            <span v-if="collapsed">☰</span><span v-else>✕</span>
          </a-button>
          <slot name="header-left">
            <span v-if="pageTitle" style="font-size:16px;font-weight:600;">{{ pageTitle }}</span>
          </slot>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          <slot name="header-actions"></slot>
          <a-avatar style="background-color:#1677ff;">运</a-avatar>
        </div>
      </a-layout-header>

      <a-layout-content class="app-content">
        <slot></slot>
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>

<script setup>
import { ref, computed } from 'vue'

defineProps({
  pageTitle: { type: String, default: '' },
})

const collapsed = ref(false)

/* ---------- 菜单配置：所有页面共用这一份 ---------- */
const menuConfig = [
  { key: 'main', title: '🏠 老家', path: '/' },
  {
    key: 'settings',
    title: '🏢 空间管理',
    children: [
      { key: 'settings-1', title: '设定一览', path: '/setup' },
      { key: 'settings-2', title: '边缘设备', path: '/setup/edge' },
      { key: 'settings-3', title: '浏览器-空间老登', path: '/setup/leader' },
      { key: 'settings-4', title: '浏览器-空间小伙', path: '/setup/fellower' },
    ],
  },
  { key: 'connection', title: '🔗 连接管理', path: '/connection' },
  { key: 'devices',    title: '🔌 设备列表', path: '/devices' },
  { key: 'alerts',     title: '🔔 告警中心', path: '/alerts' },
]

/* ---------- 当前路径：MPA 下每次都是整页加载，读一次即可 ---------- */
function normalize(p) {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p
}
const currentPath = normalize(window.location.pathname)

/* ---------- 高亮 key：精确匹配优先，其次最长前缀 ---------- */
const selectedKeys = computed(() => {
  const flat = menuConfig.flatMap((m) => (m.children ? m.children : [m]))
  const exact = flat.find((m) => m.path === currentPath)
  if (exact) return [exact.key]
  const prefix = flat
    .filter((m) => m.path && currentPath.startsWith(m.path + '/'))
    .sort((a, b) => b.path.length - a.path.length)[0]
  return prefix ? [prefix.key] : []
})

/* ---------- 自动展开包含当前项的父级菜单 ---------- */
const openKeys = ref(
  menuConfig
    .filter((m) => m.children && m.children.some((c) => selectedKeys.value.includes(c.key)))
    .map((m) => m.key)
)
</script>

<style>
.logo {
  height: 32px;
  margin: 16px;
  color: #fff;
  font-weight: 600;
  font-size: 15px;
  text-align: center;
  line-height: 32px;
  letter-spacing: 0.5px;
  background: rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  white-space: nowrap;
  overflow: hidden;
}

.site-header {
  background: #fff;
  padding: 0 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: 0 1px 4px rgba(0, 21, 41, 0.08);
}

.app-content {
  padding: 24px;
}

/* 菜单链接：继承文字颜色、去掉下划线、铺满整行便于点击 */
.menu-link {
  color: inherit;
  text-decoration: none;
  display: block;
}
</style>
