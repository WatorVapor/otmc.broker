import { BackendInRedis } from './backend_redis.mjs';
import { BackendOfHaproxy } from './backend_in_haproxy.mjs';

// ============ 执行 ============
async function main() {
    try {
        const backendsInRedis = await BackendInRedis.getAllBackends();
        console.log('backendsInRedis:=<', backendsInRedis, '>');
        const currentBackends = await BackendOfHaproxy.listCurrentBackends();
        console.log('currentBackends:=<', currentBackends, '>');
        for (const [nodeId, backend] of Object.entries(backendsInRedis)) {
            if (!currentBackends.includes(nodeId)) {
                console.log(`\n[+] 发现新的 Backend: ${nodeId}，正在添加...`);
                await BackendOfHaproxy.addBackend(nodeId,backend);
            } else {
                console.log(`\n[=] Backend [${nodeId}] 已存在，跳过。`);
            }
        }
        console.log('\n✅ Backend 同步完成。');
    } catch (err) {
        console.error('同步过程中发生错误:', err.message);
        process.exit(1);
    }
}

main();

