# otmc.broker
OTMC MQTT Broker
### 项目介绍
#### 整体构建
```mermaid
graph TD
    %% Client layer
    subgraph Clients [External Clients]
        A1[IoT Devices / Smartphones]
        A2[Browsers / Apps]
    end

    %% Infrastructure boundary (outer)
    A1 -->|MQTT over QUIC <br> UDP:14567 / TLS 1.3| B[Envoy Proxy Container]
    A2 -->|WebSocket over HTTP/3 <br> UDP:443 / TLS 1.3| B

    %% Internal processing in Envoy
    subgraph Envoy [Envoy Proxy]
        B --> B1[1. SSL/TLS decryption]
        B1 --> B2[2. QUIC stream demultiplexing]
        B2 --> B3[3. Attach PROXY Protocol v2 header]
    end

    %% Host / IPC boundary
    subgraph Shared_Volume [Host Shared Area]
        B3 -->|Fastest IPC path| C((/var/run/my_mqtt/broker.socket <br> UNIX domain socket file))
    end

    %% Internal processing in the C++26 broker
    subgraph CXX_Broker [C++26 MQTT Broker Container]
        C --> D1[1. Accept <br> Boost.Asio / std::execution]
        D1 --> D2[2. Parse PROXY header <br> Identify the client's real IP]
        D2 --> D3[3. Interpret MQTT protocol <br> async_mqtt layer]
        D3 --> D4[4. Business logic <br> Pure C++26 routing / session management]
    end

    %% Styling
    classDef external fill:#f9f9f9,stroke:#333,stroke-width:1px;
    classDef proxy fill:#e1f5fe,stroke:#0288d1,stroke-width:2px;
    classDef socket fill:#fff3e0,stroke:#f57c00,stroke-width:2px,stroke-dasharray: 5 5;
    classDef broker fill:#e8f5e9,stroke:#388e3c,stroke-width:2px;
    
    class Clients external;
    class Envoy proxy;
    class Shared_Volume socket;
    class CXX_Broker broker;
```
### 集群架构

```mermaid
graph TD
    %% Node 1
    subgraph Node_A [Cluster Node A]
        A_Broker[C++26 Broker A] <-->|UDS: broker.socket| A_Envoy[Envoy Proxy A]
    end

    %% Node 2
    subgraph Node_B [Cluster Node B]
        B_Broker[C++26 Broker B] <-->|UDS: broker.socket| B_Envoy[Envoy Proxy B]
    end

    %% Cluster Interconnect via Envoy with mTLS
    A_Envoy <==>|Internal Mesh <br> TCP:18833 / mTLS X.509| B_Envoy

    %% Styling
    classDef node fill:#f5f5f5,stroke:#9e9e9e,stroke-width:1px;
    classDef broker fill:#e8f5e9,stroke:#388e3c,stroke-width:2px;
    classDef proxy fill:#e1f5fe,stroke:#0288d1,stroke-width:2px;
    
    class Node_A,Node_B node;
    class A_Broker,B_Broker broker;
    class A_Envoy,B_Envoy proxy;
```
### 架构双轨制：控制面 vs 数据面
```mermaid
graph TD
    %% Node A
    subgraph Node_A [Cluster Node A]
        A_Raft[Raft 状态机 <br> 控制面 Actor]
        A_Data[C++26 转发引擎 <br> 数据面 Pipeline]
        
        A_Raft <-->|UDS: raft.socket| A_Envoy[Envoy Proxy A]
        A_Data <-->|UDS: data.socket| A_Envoy
    end

    %% Node B
    subgraph Node_B [Cluster Node B]
        B_Raft[Raft 状态机]
        B_Data[C++26 转发引擎]
        
        B_Envoy[Envoy Proxy B] <-->|UDS: raft.socket| B_Raft
        B_Envoy <-->|UDS: data.socket| B_Data
    end

    %% Edge Mesh Connections
    A_Envoy <==>|mTLS / TCP:18833 <br> 强一致性 / 严格验证| B_Envoy
    A_Envoy <==>|mTLS / TCP:18834 <br> 高吞吐 / 快速无状态| B_Envoy

    %% Styling
    classDef control fill:#fff3e0,stroke:#f57c00,stroke-width:2px;
    classDef data fill:#e8f5e9,stroke:#388e3c,stroke-width:2px;
    classDef proxy fill:#e1f5fe,stroke:#0288d1,stroke-width:2px;

    class A_Raft,B_Raft control;
    class A_Data,B_Data data;
    class A_Envoy,B_Envoy proxy;
```



#### 连接时序图
```mermaid
sequenceDiagram
    autonumber
    actor Client as Client (IoT/Browser)
    participant Envoy as Envoy Proxy
    participant UDS as UNIX Socket File
    participant Broker as C++26 MQTT Broker

    %% 1. External connection
    Client->>Envoy: UDP connection (MQTT over QUIC / TLS 1.3)
    Note over Client,Envoy: Fast encrypted handshake with 0-RTT / 1-RTT

    %% 2. Processing inside Envoy
    Note over Envoy: Decrypt TLS and extract raw MQTT data<br>Encode the source IP into a PROXY v2 header

    %% 3. Write to the UNIX socket
    Envoy->>UDS: Open connection
    Envoy->>UDS: Send [PROXY v2 header] + [raw MQTT CONNECT]

    %% 4. Receive and parse on the broker side
    UDS->>Broker: Detected via async_accept
    Broker->>Broker: Parse the leading PROXY v2 header<br>(Store the client's public IP/port)
    Broker->>Broker: Pass the remaining packet to async_mqtt
    Note over Broker: async_mqtt validates the CONNECT packet in a type-safe manner

    %% 5. Return connection approval
    Broker->>UDS: Return CONNACK (connection accepted) as raw data
    UDS->>Envoy: Receive response
    Envoy->>Client: Re-encrypt and return via the QUIC stream (CONNACK)
    Note over Client,Broker: Connection established. Then transition to bidirectional PUBLISH/SUBSCRIBE
```

#### 集群同期时序图 跨节点 Raft 同步整体时序图（网络与安全视角）
```mermaid
sequenceDiagram
    autonumber
    participant L_Broker as [Leader] C++26 Broker
    participant L_Envoy as [Leader] Envoy Proxy
    participant F_Envoy as [Follower] Envoy Proxy
    participant F_Broker as [Follower] C++26 Broker

    note over L_Broker: 触发 Raft 日志同步<br/>(例如：新客户端订阅了Topic)

    %% 1. Leader 发出请求
    L_Broker->>L_Envoy: 1. 写入 Raft RPC 请求 (AppendEntries)<br/>[路径: /var/run/my_mqtt/raft.socket (UDS)]
    
    %% 2. Envoy 间 mTLS 握手与传输
    note over L_Envoy, F_Envoy: Envoy 之间建立 mTLS 隧道<br/>(严格校验 X.509 证书与 SAN)
    L_Envoy->>F_Envoy: 2. 加密 TCP 传输 (TLS 1.3 / 端口:18833)
    
    %% 3. Follower 接收并处理
    F_Envoy->>F_Broker: 3. 解密后解包投递<br/>[路径: /var/run/my_mqtt/raft.socket (UDS)]
    note over F_Broker: Raft 状态机接收<br/>追加日志到本地并 Commit
    
    %% 4. Follower 返回响应
    F_Broker->>F_Envoy: 4. 返回 RPC 响应 (AppendEntriesReply)<br/>[UDS]
    F_Envoy->>L_Envoy: 5. 加密 TCP 传输
    L_Envoy->>L_Broker: 6. 解密后送达 Leader 状态机<br/>[UDS]
    
    note over L_Broker: 多数派确认，更新本地 CommitIndex<br/>触发 C++26 业务回调
```
#### 集群同期时序图 Leader 内部 C++26 std::execution 异步流水线时序图
```mermaid
sequenceDiagram
    autonumber
    participant StateMachine as Raft 状态机 (单线程 Actor)
    participant Pipe as std::execution 异步管道 (Sender)
    participant ThreadPool as 线程池 / Asio io_context
    participant EnvoyUDS as Envoy Raft UDS (Socket IO)

    StateMachine->>Pipe: 1. 组装 AppendEntriesArgs 并启动管道<br/>std::execution::start()
    activate Pipe
    
    %% 序列化阶段
    Pipe->>ThreadPool: 2. 调度到后台线程进行序列化 (Protobuf/MsgPack)<br/>std::execution::on(thread_pool)
    activate ThreadPool
    note over ThreadPool: CPU 密集型：打包数据
    ThreadPool-->>Pipe: 3. 返回二进制 Buffer
    deactivate ThreadPool

    %% 异步发送阶段
    Pipe->>EnvoyUDS: 4. 投递异步非阻塞写任务<br/>boost::asio::async_write
    activate EnvoyUDS
    StateMachine-->>StateMachine: [同时] 状态机继续处理其他事件/心跳<br/>(完全不被网络 I/O 阻塞)
    
    EnvoyUDS-->>Pipe: 5. UDS 发送完成并收到 Follower 响应
    deactivate EnvoyUDS

    %% 反序列化与回调
    Pipe->>StateMachine: 6. 将 Reply 结果 Push 回状态机线程队列<br/>(在主线程安全修改 Raft 状态，无需加锁)
    deactivate Pipe
    note over StateMachine: 推进 matchIndex[peer]
```

### 新节点加入控制面的标准时序（结合 Envoy mTLS）
```mermaid
sequenceDiagram
    autonumber
    actor Admin as 运维/编排系统 (K8s/etcd)
    participant NodeD_B as [新节点D] C++ Broker
    participant NodeD_E as [新节点D] Envoy
    participant Leader_E as [Leader] Envoy
    participant Leader_B as [Leader] C++ Broker

    %% 阶段 1：证书与网络就绪
    note over NodeD_E, Leader_E: 1. 证书与网络就绪阶段
    Admin->>NodeD_E: 下发含有新节点 SAN 的 X.509 证书 (通过 SDS)
    Admin->>Leader_E: 动态更新 Envoy 允许的证书白名单 (SAN)
    
    %% 阶段 2：以 Observer 身份加入并追赶日志
    note over NodeD_B, Leader_B: 2. 数据预热阶段 (Learner / Observer)
    Admin->>Leader_B: 发起指令：AddObserver(Node D)
    Leader_B->>Leader_E: 通过 UDS 发送 Raft 日志
    Leader_E->>NodeD_E: 通过 mTLS (18833) 建立单向数据流
    NodeD_E->>NodeD_B: 填充本地 Raft 日志与 MQTT 元数据
    note over NodeD_B: 只读节点：不参与 Quorum 计算，只管追赶日志
    
    %% 阶段 3：升级为正式节点
    note over NodeD_B, Leader_B: 3. 正式成员变更阶段
    NodeD_B-->>Leader_B: 日志追赶完成 (Catch up)
    Leader_B->>Leader_B: 提交一条特殊的 Raft 日志: ConfigurationChange(Add Node D)
    note over Leader_B: 集群进入 4 节点状态，多数派阈值自动变为 3
    Leader_B-->>Admin: 返回加入成功，Node D 获得投票权与数据转发权
```

## 配置文件
### Envoy 核心配置文件 (envoy.yaml)
```yaml
static_resources:
  listeners:
    # =========================================================================
    # 外部客户端接入 1：物联网设备通过 MQTT over QUIC 接入 (UDP: 14567)
    # =========================================================================
    - name: external_mqtt_quic_listener
      address:
        socket_address:
          protocol: UDP
          address: 0.0.0.0
          port_value: 14567
      udp_listener_config:
        quic_options: {}  # 开启 QUIC 监听器
      filter_chains:
        - filters:
            - name: envoy.filters.network.tcp_proxy
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy
                stat_prefix: external_quic_proxy
                cluster: local_mqtt_broker_uds_main  # 转发到本地 Broker 主接入 UDS
          transport_socket:
            name: envoy.transport_sockets.quic
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.transport_sockets.quic.v3.DownstreamQuicContext
              common_tls_context:
                tls_certificates:
                  - certificate_chain: { filename: "/etc/envoy/certs/mqtt_domain.crt" } # 外部域名证书
                    private_key: { filename: "/etc/envoy/certs/mqtt_domain.key" }
                alpn_protocols: ["mqt-quic"] # 声明 MQTT over QUIC 协议标识

    # =========================================================================
    # 外部客户端接入 2：现代 App/浏览器通过 WebSocket over HTTP/3 接入 (UDP: 443)
    # =========================================================================
    - name: external_websocket_h3_listener
      address:
        socket_address:
          protocol: UDP
          address: 0.0.0.0
          port_value: 443
      udp_listener_config:
        quic_options: {}
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: external_ws_h3_ingress
                codec_type: HTTP3
                http3_protocol_options: {}
                route_config:
                  name: websocket_route
                  virtual_hosts:
                    - name: mqtt_ws_host
                      domains: ["*"]
                      routes:
                        - match: { prefix: "/mqtt" } # 匹配 WebSocket 握手路径
                          route:
                            cluster: local_mqtt_broker_uds_main
                            upgrade_configs:
                              - upgrade_type: websocket # 开启并允许 WebSocket 升级
                http_filters:
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
          transport_socket:
            name: envoy.transport_sockets.quic
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.transport_sockets.quic.v3.DownstreamQuicContext
              common_tls_context:
                tls_certificates:
                  - certificate_chain: { filename: "/etc/envoy/certs/mqtt_domain.crt" }
                    private_key: { filename: "/etc/envoy/certs/mqtt_domain.key" }

    # =========================================================================
    # 内部控制面：拦截本地 C++ Broker 的 Raft RPC 流量 (IPC)
    # =========================================================================
    - name: raft_local_uds_listener
      address:
        pipe: { path: "/var/run/my_mqtt/raft.socket", mode: 0666 }
      filter_chains:
        - filters:
            - name: envoy.filters.network.tcp_proxy
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy
                stat_prefix: raft_upstream_proxy
                cluster: raft_cluster

    # =========================================================================
    # 内部数据面：拦截本地 C++ Broker 的跨节点转发流量 (IPC)
    # =========================================================================
    - name: data_local_uds_listener
      address:
        pipe: { path: "/var/run/my_mqtt/cluster_data.socket", mode: 0666 }
      filter_chains:
        - filters:
            - name: envoy.filters.network.tcp_proxy
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy
                stat_prefix: data_upstream_proxy
                cluster: data_cluster

    # =========================================================================
    # 集群互连入站：接收远端 Raft 节点请求 (mTLS 18833)
    # =========================================================================
    - name: raft_mesh_ingress_listener
      address: { socket_address: { address: 0.0.0.0, port_value: 18833 } }
      filter_chains:
        - filters:
            - name: envoy.filters.network.tcp_proxy
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy
                stat_prefix: raft_ingress_proxy
                cluster: local_raft_broker_uds
          transport_socket: &internal_mtls_downstream
            name: envoy.transport_sockets.tls
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
              common_tls_context:
                tls_certificates:
                  - certificate_chain: { filename: "/etc/envoy/certs/node.crt" } # 集群节点内部证书
                    private_key: { filename: "/etc/envoy/certs/node.key" }
                validation_context:
                  trusted_ca: { filename: "/etc/envoy/certs/ca.crt" }
                  match_typed_subject_alt_names:
                    - san_type: DNS
                      matcher: { exact: "broker-cluster.internal" }

    # =========================================================================
    # 集群互连入站：接收远端数据面同步请求 (mTLS 18834)
    # =========================================================================
    - name: data_mesh_ingress_listener
      address: { socket_address: { address: 0.0.0.0, port_value: 18834 } }
      filter_chains:
        - filters:
            - name: envoy.filters.network.tcp_proxy
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy
                stat_prefix: data_ingress_proxy
                cluster: local_data_broker_uds
          transport_socket: *internal_mtls_downstream

  # =========================================================================
  # Upstream Clusters 转发目标定义
  # =========================================================================
  clusters:
    # 🎯 核心变更：外部客户端流量的物理去向，添加 PROXY Protocol v2 头部
    - name: local_mqtt_broker_uds_main
      connect_timeout: 0.25s
      type: STATIC
      load_assignment:
        cluster_name: local_mqtt_broker_uds_main
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    pipe: { path: "/var/run/my_mqtt/broker.socket" } # 对应首图的主入口 UDS
      transport_socket:
        name: envoy.transport_sockets.upstream_proxy_protocol
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.proxy_protocol.v3.UpstreamProxyProtocol
          # 核心包裹：把客户端真实 IP 封装进 PROXY v2 格式传给 C++ Broker
          allow_missing_proxy_protocol: false
          transport_socket:
            name: envoy.transport_sockets.raw_buffer
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.transport_sockets.raw_buffer.v3.RawBuffer

    # 远端集群节点控制面 (Raft Mesh - Upstream)
    - name: raft_cluster
      connect_timeout: 1s
      type: STRICT_DNS
      dns_lookup_family: V4_ONLY
      lb_policy: ROUND_ROBIN
      load_assignment:
        cluster_name: raft_cluster
        endpoints:
          - lb_endpoints:
              - endpoint: { address: { socket_address: { address: "node-b.internal", port_value: 18833 } } }
              - endpoint: { address: { socket_address: { address: "node-c.internal", port_value: 18833 } } }
      transport_socket: &internal_mtls_upstream
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext
          common_tls_context:
            tls_certificates:
              - certificate_chain: { filename: "/etc/envoy/certs/node.crt" }
                private_key: { filename: "/etc/envoy/certs/node.key" }
            validation_context:
              trusted_ca: { filename: "/etc/envoy/certs/ca.crt" }

    # 远端集群节点数据面 (Data Mesh - Upstream)
    - name: data_cluster
      connect_timeout: 0.5s
      type: STRICT_DNS
      dns_lookup_family: V4_ONLY
      lb_policy: ROUND_ROBIN
      load_assignment:
        cluster_name: data_cluster
        endpoints:
          - lb_endpoints:
              - endpoint: { address: { socket_address: { address: "node-b.internal", port_value: 18834 } } }
              - endpoint: { address: { socket_address: { address: "node-c.internal", port_value: 18834 } } }
      transport_socket: *internal_mtls_upstream

    # 转发给本地 C++ Broker 的本地接收端定义（无 PROXY 头部，供集群内部互连使用）
    - name: local_raft_broker_uds
      connect_timeout: 0.25s
      type: STATIC
      load_assignment:
        cluster_name: local_raft_broker_uds
        endpoints:
          - lb_endpoints:
              - endpoint: { address: { pipe: { path: "/var/run/my_mqtt/raft.socket" } } }

    - name: local_data_broker_uds
      connect_timeout: 0.25s
      type: STATIC
      load_assignment:
        cluster_name: local_data_broker_uds
        endpoints:
          - lb_endpoints:
              - endpoint: { address: { pipe: { path: "/var/run/my_mqtt/cluster_data.socket" } } }
```


## 客户组分组和ACL规则
### 证书链拓扑与 Hash ID 生成规则
```
[客户独享的 ECC 种子 Key]
         │
         ▼
 ┌───────────────┐
 │   Root CA     │  ───► 公钥 SHA-256 ───► 【 租户全局唯一 GroupID 】
 └───────────────┘
         │ (签名)
         ▼
 ┌───────────────┐
 │ 一级证书/或设备│  ───► 包含上级公钥 Hash 验证字段 (Authority Key Identifier)
 └───────────────┘
```
### 邀请其他用户到自己的组的情况比如说创建聊天的group
#### 新创建一级证书为这个聊天室的空间。
#### 邀请其他用户到这个聊天室。
#### Topics 规则
```
[group_hash:xxx]/room_hash:yyyy/#
```

### 证书链验证流程
```mermaid
 sequenceDiagram
    autonumber
    participant Client as 外部客户端 (持自签证书)
    participant Envoy as Envoy Proxy (公网入口)
    participant Broker as C++26 Broker (内网业务)

    Client->>Envoy: 1. TCP/QUIC 握手与标准 TLS 1.3 协商<br/>(Envoy 下发平台公共证书，建立加密通道)
    
    Client->>Envoy: 2. 发送 MQTT CONNECT<br/>(包含 ClientID="group_hash:xxx" 和 证书链)
    Envoy->>Broker: 3. 卸载 TLS 后，将原始 MQTT 报文通过 UDS 泵送给 Broker
    
    note over Broker: C++26 密码学管道启动：<br/>1. 检查 ClientID 格式<br/>2. 提取并使用 OpenSSL 验证证书链合法性<br/>3. 计算 Root CA 公钥 Hash 是否等于 "group_hash"
    
    Broker-->>Envoy: 4. 返回 CONNACK (成功) [UDS]
    Envoy-->>Client: 5. 转发 CONNACK 至客户端
```
