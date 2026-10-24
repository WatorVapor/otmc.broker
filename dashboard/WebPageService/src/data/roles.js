export const roles = [
  {
    key: 'leader',
    icon: '👑',
    title: '领头者角色',
    tag: 'Leader',
    tagColor: 'gold',
    href: '/setup/leader/',
    buttonText: '进入领头者初始化',
    summary:
      '领头者是 OTMC Space 中信任根的建立者与维护者。它负责生成 Space 级 CA 密钥对，' +
      '逐级签发下级 CA 证书，并为加入网络的跟随者出具终端身份证书。',
    points: [
      '生成 Space 1st-Level CA / 2nd-Level CA 的密钥对与 CSR',
      '用上级 CA 签发下级 CA 证书，维护完整的信任链',
      '为跟随者提交的 CSR 签发终端证书（clientAuth 用途）',
      '保管根 CA 私钥，制定证书有效期与吊销策略'
    ],
    scenario: '首次部署 OTMC Space、需要自行掌控整条证书签发链的网络拥有者或运维方。',
    warn:
      'CA 私钥属于高价值密钥，建议在离线环境或 HSM 中生成与保管；一旦泄露，整条信任链将失效。',
    warnType: 'warning'
  },
  {
    key: 'follower',
    icon: '🔗',
    title: '跟随者角色',
    tag: 'Follower',
    tagColor: 'blue',
    href: '/setup/follower/',
    buttonText: '进入跟随者初始化',
    summary:
      '跟随者是加入一个已经建立好的 OTMC Space 的客户端。它不持有任何 CA 私钥，' +
      '只需生成本机终端密钥对并把 CSR 提交给领头者签发，随后凭签发的证书链以 mTLS 接入 Broker。',
    points: [
      '生成本机终端密钥对（不可导出）与 CSR',
      '把 CSR 提交给所在 Space 的领头者 / 签发 CA',
      '导入签发得到的终端证书与中间证书链',
      '使用 mTLS 连接 MQTT Broker，仅需保管自身终端私钥'
    ],
    scenario: '普通 MQTT 客户端节点，或证书由上级 Space / 其他团队统一签发的场景。',
    warn: '终端私钥只保存在本机浏览器存储中，清除浏览器数据后将无法恢复，需要重新申请签发。',
    warnType: 'info'
  }
]

export default roles
