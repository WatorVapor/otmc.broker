<template>
  <a-layout style="min-height: 100vh;">
    <a-layout-sider v-model:collapsed="collapsed" collapsible :trigger="null" :width="208">
      <div class="logo">MQTT IoT</div>
      <a-menu
        theme="dark"
        mode="inline"
        :selected-keys="[activeKey]"
        @click="go"
      >
        <a-menu-item key="overview">📊 实时概览</a-menu-item>
        <a-menu-item key="connection">🔗 连接管理</a-menu-item>
        <a-menu-item key="devices">🔌 设备列表</a-menu-item>
        <a-menu-item key="alerts">🔔 告警中心</a-menu-item>
      </a-menu>
    </a-layout-sider>

    <a-layout>
      <a-layout-header class="site-header">
        <div style="display:flex;align-items:center;gap:12px;">
          <a-button type="text" @click="collapsed = !collapsed">
            <span v-if="collapsed">☰</span><span v-else>✕</span>
          </a-button>
          <span style="font-size:16px;font-weight:600;">MQTT 实时监控</span>
          <span :style="{ fontSize: '12px', color: connected ? '#52c41a' : '#bfbfbf' }">
            <span class="live-dot" :class="connected ? 'on' : 'off'"></span>
            {{ connected ? '已连接' : (connecting ? '连接中…' : '未连接') }}
          </span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          <a-button
            size="small"
            :type="connected ? 'default' : 'primary'"
            :loading="connecting"
            @click="onQuickConnect"
          >
            {{ connected ? '重新连接' : '连接' }}
          </a-button>
          <a-button size="small" danger :disabled="!connected" @click="disconnect">
            断开
          </a-button>
          <a-avatar style="background-color:#1677ff;">运</a-avatar>
        </div>
      </a-layout-header>

      <a-layout-content>
        <slot />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useMqtt } from '../composables/useMqtt'

const props = defineProps({
  activeKey: { type: String, default: 'overview' }, // overview / connection / devices / alerts
})

const collapsed = ref(false)
const { connected, connecting, connect, disconnect, autoReconnect } = useMqtt()

// 顶栏快捷连接使用默认公共 broker
const defaultForm = {
  url: 'ws://broker.emqx.io:8083/mqtt',
  clientId: 'iot-dash-' + Math.random().toString(16).slice(2, 8),
  subTopic: 'iot/devices/#',
  username: '',
  password: '',
}

function onQuickConnect() {
  connect(defaultForm)
}

// MPA 跨页：如果上页连过，进新页自动重连
onMounted(() => {
  autoReconnect()
})

// 菜单跳转：整页导航
const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
const routes = {
  overview: '/',
  connection: '/connection/',
  devices: '/devices/',
  alerts: '/alerts/',
}
function go({ key }) {
  if (key === props.activeKey) return
  window.location.href = base + routes[key]
}
</script>

<style>
html, body, #app { height: 100%; margin: 0; background: #f0f2f5; }
.logo {
  height: 32px; margin: 16px; color: #fff; font-weight: 600; font-size: 15px;
  text-align: center; line-height: 32px; letter-spacing: .5px;
  background: rgba(255,255,255,.18); border-radius: 6px;
  white-space: nowrap; overflow: hidden;
}
.site-header {
  background: #fff; padding: 0 24px; display: flex; align-items: center;
  justify-content: space-between; box-shadow: 0 1px 4px rgba(0,21,41,.08);
}
.ant-layout-content { padding: 24px; }
.live-dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  margin-right: 6px; animation: pulse 1.4s infinite;
}
.live-dot.on  { background: #52c41a; }
.live-dot.off { background: #bfbfbf; animation: none; }
@keyframes pulse {
  0%,100% { opacity: 1; transform: scale(1); }
  50%     { opacity: .35; transform: scale(1.3); }
}
</style>