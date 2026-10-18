const { createApp, ref, reactive, onMounted, onBeforeUnmount, h } = Vue;

const app = createApp({
    setup() {
        /* ---------------- MQTT 连接配置 ---------------- */
        const connectForm = reactive({
            url: 'ws://broker.emqx.io:8083/mqtt', // 公共 EMQX Broker（仅测试用）
            clientId: 'iot_dash_' + Math.random().toString(16).slice(2, 10),
            username: '',
            password: '',
            subTopic: 'iot/demo/sensor/data',
            pubTopic: 'iot/demo/sensor/control',
        });

        const connected = ref(false);
        const connecting = ref(false);
        const autoRefresh = ref(true);
        let mqttClient = null;

        // 消息日志
        const logs = reactive([]);

        /* ---------------- 业务状态 ---------------- */
        const summary = reactive({
            online: 0,
            offline: 0,
            alerts: 0,
            throughput: 0,
        });

        const timeLabels = ref([]);
        const tempData = ref([]);
        const humData = ref([]);

        const devices = reactive([]);
        const alerts = reactive([]);

        // 手动发布消息
        const pubMessage = ref('{"cmd":"led","value":1}');

        /* ---------------- 工具函数 ---------------- */
        const statusColor = (s) => ({ online: 'green', warning: 'orange', offline: 'red' }[s] || 'default');
        const statusText  = (s) => ({ online: '在线', warning: '告警', offline: '离线' }[s] || s);
        const levelColor  = (l) => ({ critical: 'red', warning: 'orange', info: 'blue' }[l] || 'default');
        const levelText   = (l) => ({ critical: '严重', warning: '警告', info: '提示' }[l] || l);

        const addLog = (type, text) => {
            logs.push({ key: Date.now() + Math.random(), time: dayjs().format('HH:mm:ss'), type, text });
            if (logs.length > 200) logs.shift();
        };

        /* ---------------- 图表配置 ---------------- */
        const lineRef = ref(null);
        const donutRef = ref(null);
        let lineChart = null;
        let donutChart = null;

        const lineOption = () => ({
            tooltip: { trigger: 'axis' },
            legend: { data: ['温度 (°C)', '湿度 (%)'], top: 0 },
            grid: { left: 46, right: 52, top: 44, bottom: 30 },
            xAxis: {
                type: 'category',
                boundaryGap: false,
                data: timeLabels.value,
                axisLabel: { fontSize: 11, color: '#8c8c8c' },
            },
            yAxis: [
                { type: 'value', name: '°C', min: 15, max: 40, nameTextStyle: { color: '#8c8c8c' }, splitLine: { lineStyle: { type: 'dashed' } } },
                { type: 'value', name: '%',  min: 30, max: 80, nameTextStyle: { color: '#8c8c8c' }, splitLine: { show: false } },
            ],
            series: [
                {
                    name: '温度 (°C)', type: 'line', smooth: true, symbol: 'none',
                    data: tempData.value,
                    lineStyle: { width: 2, color: '#fa541c' },
                    itemStyle: { color: '#fa541c' },
                    areaStyle: { color: 'rgba(250,84,28,0.10)' },
                },
                {
                    name: '湿度 (%)', type: 'line', smooth: true, symbol: 'none', yAxisIndex: 1,
                    data: humData.value,
                    lineStyle: { width: 2, color: '#1677ff' },
                    itemStyle: { color: '#1677ff' },
                    areaStyle: { color: 'rgba(22,119,255,0.10)' },
                },
            ],
        });

        const donutOption = () => {
            const total = summary.online + summary.offline;
            const rate = total ? ((summary.online / total) * 100).toFixed(1) : '0.0';
            return {
                tooltip: { trigger: 'item', formatter: '{b}: {c} 台 ({d}%)' },
                legend: { bottom: 0, icon: 'circle', itemWidth: 8, itemHeight: 8 },
                title: {
                    text: rate + '%',
                    subtext: '在线率',
                    left: 'center',
                    top: '34%',
                    textStyle: { fontSize: 26, fontWeight: 600, color: '#1f1f1f' },
                    subtextStyle: { fontSize: 12, color: '#8c8c8c' },
                },
                series: [{
                    type: 'pie',
                    radius: ['58%', '78%'],
                    center: ['50%', '44%'],
                    avoidLabelOverlap: false,
                    label: { show: false },
                    labelLine: { show: false },
                    data: [
                        { value: summary.online || 1,  name: '在线', itemStyle: { color: '#52c41a' } },
                        { value: summary.offline, name: '离线', itemStyle: { color: '#ff4d4f' } },
                    ],
                }],
            };
        };

        /* ---------------- MQTT 连接与消息处理 ---------------- */
        const connectMQTT = () => {
            if (mqttClient) {
                try { mqttClient.end(true); } catch (e) {}
                mqttClient = null;
            }

            connecting.value = true;
            addLog('info', `正在连接 ${connectForm.url} …`);

            const options = {
                clean: true,
                connectTimeout: 8000,
                reconnectPeriod: 4000,
                clientId: connectForm.clientId,
            };
            if (connectForm.username) options.username = connectForm.username;
            if (connectForm.password) options.password = connectForm.password;

            mqttClient = mqtt.connect(connectForm.url, options);

            mqttClient.on('connect', () => {
                connected.value = true;
                connecting.value = false;
                addLog('info', 'MQTT 连接成功');

                mqttClient.subscribe(connectForm.subTopic, { qos: 0 }, (err) => {
                    if (err) {
                        addLog('err', `订阅失败: ${err.message}`);
                    } else {
                        addLog('info', `已订阅 Topic: ${connectForm.subTopic}`);
                    }
                });
            });

            mqttClient.on('reconnect', () => {
                connecting.value = true;
                addLog('info', '正在重连 …');
            });

            mqttClient.on('close', () => {
                if (connected.value) addLog('err', 'MQTT 连接已断开');
                connected.value = false;
                connecting.value = false;
            });

            mqttClient.on('error', (err) => {
                addLog('err', `MQTT 错误: ${err.message}`);
                connecting.value = false;
            });

            mqttClient.on('message', (topic, payload) => {
                let text;
                try {
                    text = payload.toString();
                } catch (e) {
                    text = '[无法解析的 payload]';
                }

                addLog('recv', `[${topic}] ${text}`);

                // 尝试按 JSON 解析，提取温湿度数据
                try {
                    const data = JSON.parse(text);
                    handleSensorData(topic, data);
                } catch (e) {
                    // 非 JSON 消息只记录，不更新图表
                }
            });
        };

        const disconnectMQTT = () => {
            if (mqttClient) {
                mqttClient.end(true);
                mqttClient = null;
            }
            connected.value = false;
            connecting.value = false;
            addLog('info', '已主动断开连接');
        };

        // 处理传感器数据：兼容多种常见字段命名
        const handleSensorData = (topic, data) => {
            const now = dayjs().format('HH:mm:ss');

            const temp = data.temperature ?? data.temp ?? data.t;
            const hum  = data.humidity ?? data.hum ?? data.h;

            if (temp !== undefined || hum !== undefined) {
                timeLabels.value.push(now);
                tempData.value.push(temp !== undefined ? Number(temp) : null);
                humData.value.push(hum !== undefined ? Number(hum) : null);

                if (timeLabels.value.length > 20) {
                    timeLabels.value.shift();
                    tempData.value.shift();
                    humData.value.shift();
                }

                if (lineChart) {
                    lineChart.setOption({
                        xAxis: { data: timeLabels.value },
                        series: [{ data: tempData.value }, { data: humData.value }],
                    });
                }

                // 更新顶部概览
                summary.throughput = Math.floor(Math.random() * 50) + 50; // 示意值
            }

            // 如果消息里带了设备状态，更新设备列表
            if (data.deviceId || data.device_id) {
                const id = data.deviceId || data.device_id;
                const existing = devices.find((d) => d.id === id);
                if (existing) {
                    if (temp !== undefined) existing.temp = Number(temp);
                    if (hum !== undefined) existing.hum = Number(hum);
                    existing.lastSeen = '刚刚';
                    existing.status = data.status || existing.status;
                } else {
                    devices.push({
                        key: id,
                        id,
                        type: data.type || '传感器',
                        location: data.location || '—',
                        status: data.status || 'online',
                        temp: temp !== undefined ? Number(temp) : null,
                        hum: hum !== undefined ? Number(hum) : null,
                        lastSeen: '刚刚',
                    });
                }
                refreshSummary();
            }

            // 如果消息里带了告警信息，追加到告警列表
            if (data.alert) {
                alerts.unshift({
                    key: Date.now(),
                    level: data.alertLevel || data.alert_level || 'info',
                    device: data.deviceId || data.device_id || '—',
                    message: data.alert,
                    time: now,
                });
                if (alerts.length > 20) alerts.pop();
                summary.alerts = alerts.length;
            }
        };

        const refreshSummary = () => {
            const total = devices.length;
            const online = devices.filter((d) => d.status === 'online').length;
            summary.online = online;
            summary.offline = total - online;
            if (donutChart) donutChart.setOption(donutOption());
        };

        /* ---------------- 发布消息 ---------------- */
        const publishMessage = () => {
            if (!mqttClient || !connected.value) {
                addLog('err', '未连接，无法发布');
                return;
            }
            const topic = connectForm.pubTopic;
            mqttClient.publish(topic, pubMessage.value, { qos: 0 }, (err) => {
                if (err) {
                    addLog('err', `发布失败: ${err.message}`);
                } else {
                    addLog('send', `[${topic}] ${pubMessage.value}`);
                }
            });
        };

        /* ---------------- 生命周期 ---------------- */
        onMounted(() => {
            lineChart = echarts.init(lineRef.value);
            lineChart.setOption(lineOption());

            donutChart = echarts.init(donutRef.value);
            donutChart.setOption(donutOption());

            window.addEventListener('resize', handleResize);
            connectMQTT();
        });

        onBeforeUnmount(() => {
            window.removeEventListener('resize', handleResize);
            if (lineChart) lineChart.dispose();
            if (donutChart) donutChart.dispose();
            if (mqttClient) mqttClient.end(true);
        });

        const handleResize = () => {
            if (lineChart) lineChart.resize();
            if (donutChart) donutChart.resize();
        };

        /* ---------------- 表格列定义（用 customRender 代替 bodyCell 插槽） ---------------- */
        const columns = [
            { title: '设备 ID', dataIndex: 'id', key: 'id', width: 110 },
            { title: '类型', dataIndex: 'type', key: 'type' },
            { title: '位置', dataIndex: 'location', key: 'location' },
            {
                title: '状态', key: 'status', width: 100,
                customRender: ({ record }) =>
                    h(antd.Tag, { color: statusColor(record.status) }, () => statusText(record.status)),
            },
            {
                title: '温度', key: 'temp', width: 90,
                customRender: ({ record }) =>
                    record.temp !== null
                        ? `${record.temp} °C`
                        : h('span', { style: 'color:#bfbfbf;' }, '—'),
            },
            {
                title: '湿度', key: 'hum', width: 90,
                customRender: ({ record }) =>
                    record.hum !== null
                        ? `${record.hum} %`
                        : h('span', { style: 'color:#bfbfbf;' }, '—'),
            },
            { title: '最后心跳', dataIndex: 'lastSeen', key: 'lastSeen', width: 110 },
        ];

        return {
            connectForm, connected, connecting, autoRefresh,
            logs, summary, devices, alerts, columns,
            pubMessage, lineRef, donutRef,
            statusColor, statusText, levelColor, levelText,
            connectMQTT, disconnectMQTT, publishMessage,
        };
    },

    // 侧边栏折叠状态
    data() {
        return { collapsed: false };
    },
});

app.use(antd);
app.mount('#app');
