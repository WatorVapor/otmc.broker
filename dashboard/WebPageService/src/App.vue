<template>
  <AppLayout page-title="MQTT 实时监控">
    <template #header-actions>
      <span :style="{ fontSize: '12px', color: connected ? '#52c41a' : '#bfbfbf' }">
        <span class="live-dot" :class="connected ? 'on' : 'off'"></span>
        {{ connected ? '已连接' : (connecting ? '连接中…' : '未连接') }}
      </span>
      <a-button size="small" :type="connected ? 'default' : 'primary'"
                @click="connectMQTT" :loading="connecting">
        {{ connected ? '重新连接' : '连接' }}
      </a-button>
      <a-button size="small" danger :disabled="!connected" @click="disconnectMQTT">
        断开
      </a-button>
    </template>

    <a-layout-content>
      <!-- 配置 + 日志 -->
      <a-row :gutter="[16, 16]">
        <a-col :xs="24" :lg="10">
          <a-card variant="borderless" title="MQTT 连接配置">
            <a-form layout="vertical" class="conn-form">
              <a-form-item label="Broker WebSocket URL">
                <a-input v-model:value="connectForm.url" placeholder="ws://broker.emqx.io:8083/mqtt"></a-input>
              </a-form-item>
              <a-row :gutter="12">
                <a-col :span="12">
                  <a-form-item label="Client ID">
                    <a-input v-model:value="connectForm.clientId"></a-input>
                  </a-form-item>
                </a-col>
                <a-col :span="12">
                  <a-form-item label="订阅 Topic">
                    <a-input v-model:value="connectForm.subTopic"></a-input>
                  </a-form-item>
                </a-col>
              </a-row>
              <a-row :gutter="12">
                <a-col :span="12">
                  <a-form-item label="Username（可选）">
                    <a-input v-model:value="connectForm.username"></a-input>
                  </a-form-item>
                </a-col>
                <a-col :span="12">
                  <a-form-item label="Password（可选）">
                    <a-input-password v-model:value="connectForm.password"></a-input-password>
                  </a-form-item>
                </a-col>
              </a-row>
            </a-form>
            <a-alert
              type="warning"
              show-icon
              title="broker.emqx.io 是公共测试 Broker，所有消息公开可见，请勿发送敏感数据。"
              style="font-size:12px;"
            ></a-alert>
          </a-card>
        </a-col>

        <a-col :xs="24" :lg="14">
          <a-card variant="borderless" title="消息日志">
            <div ref="logRef" class="msg-log">
              <div v-for="log in logs" :key="log.key">
                <span class="t">[{{ log.time }}]</span>
                <span :class="log.type === 'err' ? 'err' : ''">{{ log.text }}</span>
              </div>
              <div v-if="logs.length === 0" style="color:#808080;">等待 MQTT 消息…</div>
            </div>
          </a-card>
        </a-col>
      </a-row>

      <!-- 统计卡片 -->
      <a-row :gutter="[16, 16]" style="margin-top:16px;">
        <a-col :xs="24" :sm="12" :xl="6">
          <a-card class="stat-card" variant="borderless">
            <div class="stat-label">在线设备</div>
            <div class="stat-value" style="color:#52c41a;">{{ summary.online }}</div>
          </a-card>
        </a-col>
        <a-col :xs="24" :sm="12" :xl="6">
          <a-card class="stat-card" variant="borderless">
            <div class="stat-label">离线设备</div>
            <div class="stat-value" style="color:#ff4d4f;">{{ summary.offline }}</div>
          </a-card>
        </a-col>
        <a-col :xs="24" :sm="12" :xl="6">
          <a-card class="stat-card" variant="borderless">
            <div class="stat-label">告警数</div>
            <div class="stat-value" style="color:#faad14;">{{ summary.alerts }}</div>
          </a-card>
        </a-col>
        <a-col :xs="24" :sm="12" :xl="6">
          <a-card class="stat-card" variant="borderless">
            <div class="stat-label">消息吞吐 (条/秒)</div>
            <div class="stat-value" style="color:#1677ff;">{{ summary.throughput }}</div>
          </a-card>
        </a-col>
      </a-row>

      <!-- 图表 -->
      <a-row :gutter="[16, 16]" style="margin-top:16px;">
        <a-col :xs="24" :lg="16">
          <a-card variant="borderless" title="实时环境数据（来自 MQTT）">
            <div ref="lineRef" class="chart-box"></div>
          </a-card>
        </a-col>
        <a-col :xs="24" :lg="8">
          <a-card variant="borderless" title="设备在线率">
            <div ref="donutRef" class="chart-box"></div>
          </a-card>
        </a-col>
      </a-row>

      <!-- 发布 + 设备表 -->
      <a-row :gutter="[16, 16]" style="margin-top:16px;">
        <a-col :xs="24" :xl="8">
          <a-card variant="borderless" title="发布控制指令">
            <a-form layout="vertical">
              <a-form-item label="发布 Topic">
                <a-input v-model:value="connectForm.pubTopic"></a-input>
              </a-form-item>
              <a-form-item label="Payload">
                <a-textarea v-model:value="pubMessage" :rows="3"></a-textarea>
              </a-form-item>
            </a-form>
            <a-button type="primary" block @click="publishMessage" :disabled="!connected">
              发布消息
            </a-button>
          </a-card>
        </a-col>

        <a-col :xs="24" :xl="16">
          <a-card variant="borderless" title="设备状态（来自 MQTT 消息）">
            <a-table
              :columns="columns"
              :data-source="devices"
              :pagination="false"
              size="middle"
              :scroll="{ x: 760 }"
              :locale="{ emptyText: '暂无设备数据，等待 MQTT 消息…' }"
            ></a-table>
          </a-card>
        </a-col>
      </a-row>

      <!-- 告警 -->
      <a-row :gutter="[16, 16]" style="margin-top:16px;">
        <a-col :span="24">
          <a-card variant="borderless" title="实时告警（来自 MQTT 消息）">
            <div>
              <div v-for="item in alerts" :key="item.key" class="alert-list-item">
                <div>
                  <a-tag :color="levelColor(item.level)" style="margin-right:6px;">
                    {{ levelText(item.level) }}
                  </a-tag>
                  <span style="font-size:13px;">{{ item.message }}</span>
                </div>
                <div style="font-size:12px;color:#8c8c8c;">{{ item.device }} · {{ item.time }}</div>
              </div>
              <div v-if="alerts.length === 0" class="alert-list-empty">暂无告警</div>
            </div>
          </a-card>
        </a-col>
      </a-row>
    </a-layout-content>

  </AppLayout>
</template>

<script setup>
import { ref, reactive, onMounted, onBeforeUnmount, nextTick, h } from 'vue'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat'
import weekday from 'dayjs/plugin/weekday'
import localeData from 'dayjs/plugin/localeData'
import weekOfYear from 'dayjs/plugin/weekOfYear'
import weekYear from 'dayjs/plugin/weekYear'
import advancedFormat from 'dayjs/plugin/advancedFormat'
import quarterOfYear from 'dayjs/plugin/quarterOfYear'
import * as echarts from 'echarts'
import mqtt from 'mqtt'
import { Tag } from 'antdv-next'

dayjs.extend(customParseFormat)
dayjs.extend(weekday)
dayjs.extend(localeData)
dayjs.extend(weekOfYear)
dayjs.extend(weekYear)
dayjs.extend(advancedFormat)
dayjs.extend(quarterOfYear)

/* ---------- 响应式状态 ---------- */
const collapsed = ref(false)
const connected = ref(false)
const connecting = ref(false)
const pubMessage = ref('{"cmd":"reboot"}')
const logs = ref([])
const devices = ref([])
const alerts = ref([])
const logRef = ref(null)
const lineRef = ref(null)
const donutRef = ref(null)

const connectForm = reactive({
  url: 'ws://broker.emqx.io:8083/mqtt',
  clientId: 'iot-dash-' + Math.random().toString(16).slice(2, 8),
  subTopic: 'iot/devices/#',
  pubTopic: 'iot/commands',
  username: '',
  password: '',
})

const summary = reactive({
  online: 0,
  offline: 0,
  alerts: 0,
  throughput: 0,
})

/* ---------- 实例与运行时变量 ---------- */
let lineChart = null
let donutChart = null
let mqttClient = null
let throughputTimer = null
let msgCount = 0

const lineData = { time: [], temperature: [], humidity: [] }

/* ---------- 表格列定义 ---------- */
const columns = [
  { title: '设备 ID', dataIndex: 'deviceId', key: 'deviceId', width: 180 },
  {
    title: '状态',
    dataIndex: 'status',
    key: 'status',
    width: 100,
    render: ({ text }) =>
      h(
        Tag,
        { color: text === 'online' ? '#52c41a' : '#ff4d4f' },
        () => (text === 'online' ? '在线' : '离线')
      ),
  },
  { title: '温度 (°C)', dataIndex: 'temperature', key: 'temperature', width: 120 },
  { title: '湿度 (%)', dataIndex: 'humidity', key: 'humidity', width: 120 },
  { title: '最后上报', dataIndex: 'lastSeen', key: 'lastSeen', width: 140 },
]

/* ---------- 日志工具 ---------- */
function pushLog(text, type = 'info') {
  logs.value.push({
    key: Date.now() + Math.random(),
    time: dayjs().format('HH:mm:ss'),
    text,
    type,
  })
  if (logs.value.length > 300) logs.value.shift()
  nextTick(() => {
    if (logRef.value) logRef.value.scrollTop = logRef.value.scrollHeight
  })
}

/* ---------- MQTT 连接与发布 ---------- */
function connectMQTT() {
  if (mqttClient) {
    try { mqttClient.end(true) } catch (e) {}
    mqttClient = null
  }
  connected.value = false
  connecting.value = true
  pushLog(`🔗 正在连接 ${connectForm.url} ...`)

  const options = {
    clientId: connectForm.clientId,
    clean: true,
    connectTimeout: 8000,
    reconnectPeriod: 3000,
  }
  if (connectForm.username) options.username = connectForm.username
  if (connectForm.password) options.password = connectForm.password

  try {
    mqttClient = mqtt.connect(connectForm.url, options)
  } catch (e) {
    pushLog(`❌ 连接失败: ${e.message}`, 'err')
    connecting.value = false
    return
  }

  mqttClient.on('connect', () => {
    connected.value = true
    connecting.value = false
    pushLog(`✅ 已连接 Broker: ${connectForm.url}`)
    mqttClient.subscribe(connectForm.subTopic, { qos: 0 }, (err) => {
      if (err) pushLog(`❌ 订阅失败: ${err.message}`, 'err')
      else pushLog(`📡 已订阅: ${connectForm.subTopic}`)
    })
  })

  mqttClient.on('reconnect', () => pushLog('🔄 正在重连...'))
  mqttClient.on('error', (err) => pushLog(`❌ MQTT 错误: ${err.message}`, 'err'))
  mqttClient.on('close', () => {
    if (connected.value) pushLog('🔌 连接已关闭')
    connected.value = false
    connecting.value = false
  })
  mqttClient.on('message', handleMessage)
}

function disconnectMQTT() {
  if (mqttClient) {
    try { mqttClient.end(true) } catch (e) {}
    mqttClient = null
  }
  connected.value = false
  connecting.value = false
  pushLog('🔌 已主动断开连接')
}

function publishMessage() {
  if (!mqttClient || !connected.value) return
  const topic = connectForm.pubTopic
  const payload = pubMessage.value
  mqttClient.publish(topic, payload, { qos: 0 }, (err) => {
    if (err) pushLog(`❌ 发布失败: ${err.message}`, 'err')
    else pushLog(`📤 已发布 [${topic}]: ${payload}`)
  })
}

/* ---------- 消息处理 ---------- */
function handleMessage(topic, payload) {
  msgCount++
  const text = payload.toString()
  const shortText = text.length > 120 ? text.slice(0, 120) + '…' : text
  pushLog(`📩 ${topic}: ${shortText}`)

  let data
  try {
    data = JSON.parse(text)
  } catch (e) {
    return
  }

  const deviceId = data.deviceId || data.device || topic.split('/').pop()
  if (deviceId) upsertDevice(deviceId, data)

  if (data.temperature !== undefined || data.humidity !== undefined) {
    appendLineData(data)
  }

  if (data.level || data.alert) {
    addAlert({
      level: data.level || 'warning',
      message: data.message || data.alert || '设备告警',
      device: deviceId || 'unknown',
    })
  }

  recomputeSummary()
}

function upsertDevice(deviceId, data) {
  const now = dayjs().format('HH:mm:ss')
  const status = data.status === 'offline' ? 'offline' : 'online'
  const existing = devices.value.find((d) => d.deviceId === deviceId)
  const patch = {
    deviceId,
    status,
    temperature: data.temperature ?? existing?.temperature ?? '-',
    humidity: data.humidity ?? existing?.humidity ?? '-',
    lastSeen: now,
  }
  if (existing) Object.assign(existing, patch)
  else devices.value.push(patch)
}

function appendLineData(data) {
  const t = dayjs().format('HH:mm:ss')
  lineData.time.push(t)
  lineData.temperature.push(data.temperature ?? null)
  lineData.humidity.push(data.humidity ?? null)
  if (lineData.time.length > 20) {
    lineData.time.shift()
    lineData.temperature.shift()
    lineData.humidity.shift()
  }
  updateLineChart()
}

function addAlert({ level, message, device }) {
  alerts.value.unshift({
    key: Date.now() + Math.random(),
    level,
    message,
    device,
    time: dayjs().format('HH:mm:ss'),
  })
  if (alerts.value.length > 50) alerts.value.pop()
  summary.alerts = alerts.value.length
}

function recomputeSummary() {
  summary.online = devices.value.filter((d) => d.status === 'online').length
  summary.offline = devices.value.filter((d) => d.status === 'offline').length
  updateDonutChart()
}

/* ---------- ECharts ---------- */
function initLineChart() {
  if (!lineRef.value) return
  lineChart = echarts.init(lineRef.value)
  updateLineChart()
}

function updateLineChart() {
  if (!lineChart) return
  lineChart.setOption(
    {
      tooltip: { trigger: 'axis' },
      legend: { data: ['温度 (°C)', '湿度 (%)'], top: 0 },
      grid: { left: 46, right: 46, top: 40, bottom: 30 },
      xAxis: { type: 'category', boundaryGap: false, data: lineData.time },
      yAxis: [
        { type: 'value', name: '温度', position: 'left' },
        { type: 'value', name: '湿度', position: 'right' },
      ],
      series: [
        {
          name: '温度 (°C)',
          type: 'line',
          smooth: true,
          data: lineData.temperature,
          yAxisIndex: 0,
          itemStyle: { color: '#faad14' },
          areaStyle: { opacity: 0.15 },
        },
        {
          name: '湿度 (%)',
          type: 'line',
          smooth: true,
          data: lineData.humidity,
          yAxisIndex: 1,
          itemStyle: { color: '#1677ff' },
        },
      ],
    },
    true
  )
}

function initDonutChart() {
  if (!donutRef.value) return
  donutChart = echarts.init(donutRef.value)
  updateDonutChart()
}

function updateDonutChart() {
  if (!donutChart) return
  donutChart.setOption(
    {
      tooltip: { trigger: 'item' },
      legend: { bottom: 0 },
      series: [
        {
          type: 'pie',
          radius: ['50%', '70%'],
          avoidLabelOverlap: false,
          label: { show: true, formatter: '{b}\n{d}%' },
          data: [
            { value: summary.online, name: '在线', itemStyle: { color: '#52c41a' } },
            { value: summary.offline, name: '离线', itemStyle: { color: '#ff4d4f' } },
          ],
        },
      ],
    },
    true
  )
}

function handleResize() {
  lineChart && lineChart.resize()
  donutChart && donutChart.resize()
}

/* ---------- 告警级别辅助 ---------- */
function levelColor(level) {
  return (
    { info: '#1677ff', warning: '#faad14', error: '#ff4d4f', critical: '#cf1322' }[level] ||
    '#d9d9d9'
  )
}
function levelText(level) {
  return (
    { info: '信息', warning: '警告', error: '错误', critical: '严重' }[level] || level
  )
}

/* ---------- 生命周期 ---------- */
onMounted(() => {
  nextTick(() => {
    initLineChart()
    initDonutChart()
  })
  throughputTimer = setInterval(() => {
    summary.throughput = msgCount
    msgCount = 0
  }, 1000)
  window.addEventListener('resize', handleResize)
  pushLog('👋 欢迎使用 MQTT IoT Dashboard')
})

onBeforeUnmount(() => {
  if (throughputTimer) clearInterval(throughputTimer)
  window.removeEventListener('resize', handleResize)
  if (mqttClient) {
    try { mqttClient.end(true) } catch (e) {}
  }
  if (lineChart) lineChart.dispose()
  if (donutChart) donutChart.dispose()
})
</script>

<style>
html, body, #app {
  height: 100%;
  margin: 0;
  background: #f0f2f5;
}

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

.stat-card .ant-card-body {
  padding: 18px 22px;
}

.stat-label {
  color: #8c8c8c;
  font-size: 13px;
  margin-bottom: 6px;
}

.stat-value {
  font-size: 26px;
  font-weight: 600;
  color: #1f1f1f;
  line-height: 1.2;
}

.chart-box {
  height: 320px;
  width: 100%;
}

.live-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  animation: pulse 1.4s infinite;
}
.live-dot.on  { background: #52c41a; }
.live-dot.off { background: #bfbfbf; animation: none; }

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.35; transform: scale(1.3); }
}

.ant-layout-content {
  padding: 24px;
}

.conn-form .ant-form-item {
  margin-bottom: 12px;
}

.msg-log {
  background: #1e1e1e;
  color: #d4d4d4;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
  line-height: 1.6;
  padding: 12px;
  border-radius: 6px;
  height: 220px;
  overflow-y: auto;
}
.msg-log .t   { color: #569cd6; }
.msg-log .tp  { color: #4ec9b0; }
.msg-log .err { color: #f48771; }

/* antdv-next 中 List 组件不可用，使用 div 模拟 */
.alert-list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
}
.alert-list-item:last-child {
  border-bottom: none;
}
.alert-list-empty {
  color: #8c8c8c;
  font-size: 12px;
  padding: 8px 0;
}
</style>