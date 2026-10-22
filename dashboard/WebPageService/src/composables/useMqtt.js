import { ref, reactive } from 'vue'
import mqtt from 'mqtt'
import dayjs from 'dayjs'

const STORAGE_KEY = 'iot-mqtt-config'

// —— 模块级单例（每个 HTML 页面内共享一份）——
const connected = ref(false)
const connecting = ref(false)
const logs = ref([])
const devices = ref([])
const alerts = ref([])
const summary = reactive({ online: 0, offline: 0, alerts: 0, throughput: 0 })

let client = null
let throughputTimer = null
let msgCount = 0

function pushLog(text, type = 'info') {
  logs.value.push({
    key: Date.now() + Math.random(),
    time: dayjs().format('HH:mm:ss'),
    text, type,
  })
  if (logs.value.length > 300) logs.value.shift()
}

function startThroughput() {
  if (throughputTimer) clearInterval(throughputTimer)
  msgCount = 0
  throughputTimer = setInterval(() => {
    summary.throughput = msgCount
    msgCount = 0
  }, 1000)
}
function stopThroughput() {
  if (throughputTimer) clearInterval(throughputTimer)
  throughputTimer = null
  summary.throughput = 0
}

export function connect(form) {
  if (client) { try { client.end(true) } catch (e) {} client = null }
  connected.value = false
  connecting.value = true
  pushLog(`🔗 正在连接 ${form.url} ...`)

  // 记住配置，供其它 MPA 页面自动重连
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(form)) } catch (e) {}

  const options = {
    clientId: form.clientId,
    clean: true,
    connectTimeout: 8000,
    reconnectPeriod: 3000,
  }
  if (form.username) options.username = form.username
  if (form.password) options.password = form.password

  try {
    client = mqtt.connect(form.url, options)
  } catch (e) {
    pushLog(`❌ 连接失败: ${e.message}`, 'err')
    connecting.value = false
    return
  }

  client.on('connect', () => {
    connected.value = true
    connecting.value = false
    pushLog(`✅ 已连接 ${form.url}`)
    client.subscribe(form.subTopic, { qos: 0 }, (err) => {
      if (err) pushLog(`❌ 订阅失败: ${err.message}`, 'err')
      else pushLog(`📡 已订阅 ${form.subTopic}`)
    })
    startThroughput()
  })
  client.on('reconnect', () => pushLog('🔄 正在重连...'))
  client.on('error', (err) => pushLog(`❌ MQTT 错误: ${err.message}`, 'err'))
  client.on('close', () => {
    if (connected.value) pushLog('🔌 连接已关闭')
    connected.value = false
    connecting.value = false
    stopThroughput()
  })
  client.on('message', handleMessage)
}

export function disconnect() {
  if (client) { try { client.end(true) } catch (e) {} client = null }
  connected.value = false
  connecting.value = false
  stopThroughput()
  try { localStorage.removeItem(STORAGE_KEY) } catch (e) {}
  pushLog('🔌 已主动断开')
}

/** MPA 跨页自动重连：新页面挂载时若存在上次配置，就自动连一次 */
export function autoReconnect() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const form = JSON.parse(raw)
    if (form?.url) connect(form)
  } catch (e) {}
}

export function publish(topic, payload) {
  if (!client || !connected.value) return
  client.publish(topic, payload, { qos: 0 }, (err) => {
    if (err) pushLog(`❌ 发布失败: ${err.message}`, 'err')
    else pushLog(`📤 已发布 [${topic}]: ${payload}`)
  })
}

function handleMessage(topic, payload) {
  msgCount++
  const text = payload.toString()
  pushLog(`📩 ${topic}: ${text.length > 120 ? text.slice(0,120)+'…' : text}`)

  let data
  try { data = JSON.parse(text) } catch { return }

  const deviceId = data.deviceId || data.device || topic.split('/').pop()
  if (deviceId) upsertDevice(deviceId, data)
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
    deviceId, status,
    temperature: data.temperature ?? existing?.temperature ?? '-',
    humidity: data.humidity ?? existing?.humidity ?? '-',
    lastSeen: now,
  }
  if (existing) Object.assign(existing, patch)
  else devices.value.push(patch)
}

function addAlert({ level, message, device }) {
  alerts.value.unshift({
    key: Date.now() + Math.random(),
    level, message, device,
    time: dayjs().format('HH:mm:ss'),
  })
  if (alerts.value.length > 50) alerts.value.pop()
  summary.alerts = alerts.value.length
}

function recomputeSummary() {
  summary.online = devices.value.filter(d => d.status === 'online').length
  summary.offline = devices.value.filter(d => d.status === 'offline').length
}

export function useMqtt() {
  return {
    connected, connecting, logs, devices, alerts, summary,
    connect, disconnect, publish, pushLog, autoReconnect,
  }
}