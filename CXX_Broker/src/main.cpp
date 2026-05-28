#include <iostream>
#include <string>
#include <string_view>
#include <filesystem>
#include <print>
#include <vector>
#include <thread>
#include <memory>
#include <boost/asio.hpp>
#include <async_mqtt/all.hpp>
//import std;

namespace MQTT = ::async_mqtt;
namespace asio = boost::asio;
namespace fs = std::filesystem;

// RAII 守卫：管理 UDS 文件生命周期
class UdsStorageGuard {
public:
    explicit UdsStorageGuard(std::string_view path) : path_(path) {
        if (fs::exists(path_)) fs::remove(path_);
    }
    ~UdsStorageGuard() {
        if (fs::exists(path_)) fs::remove(path_);
    }
    UdsStorageGuard(const UdsStorageGuard&) = delete;
    UdsStorageGuard& operator=(const UdsStorageGuard&) = delete;
private:
    fs::path path_;
};

// 异步处理单个 MQTT 客户端会话 (基于 C++ 协程)
asio::awaitable<void> handle_client_session(asio::local::stream_protocol::socket socket) {
    auto ep = std::make_unique<MQTT::endpoint<MQTT::role::server, asio::local::stream_protocol::socket>>(
        MQTT::protocol_version::v5,
        std::move(socket)
    );

    try {
        // 1. 异步接收第一个 CONNECT 报文 (返回的是 std::optional)
        auto packet_opt = co_await ep->async_recv(asio::use_awaitable);
        
        // 确保连接未提前关闭且拿到了报文
        if (packet_opt) {
            auto& packet = *packet_opt; // 解包 std::optional，拿到真正的 packet_variant

            if (auto connect_opt = packet.get_if<MQTT::v5::connect_packet>()) {
                std::println("[Broker] Received CONNECT from client_id: {}", connect_opt->client_id());

                // 2. 回应 CONNACK
                co_await ep->async_send(
                    MQTT::v5::connack_packet{true, MQTT::connect_reason_code::success},
                    asio::use_awaitable
                );

                // 3. 核心消息主循环
                while (true) {
                    auto p_opt = co_await ep->async_recv(asio::use_awaitable);
                    if (!p_opt) {
                        std::println("[Broker] Connection stream closed by peer (EOF).");
                        break;
                    }

                    auto& p = *p_opt; // 解包 std::optional

                    if (auto pub_opt = p.get_if<MQTT::v5::publish_packet>()) {
                        std::println("[Broker] Received Topic: {}, Payload: {}", pub_opt->topic(), pub_opt->payload());
                        
                        if (pub_opt->opts().get_qos() == MQTT::qos::at_least_once) {
                            auto pid = static_cast<unsigned short>(pub_opt->packet_id());
                            co_await ep->async_send(
                                MQTT::v5::puback_packet{pid}, 
                                asio::use_awaitable
                            );
                        }
                    } 
                    // 修正点：将 p.is_holding 统一替换为统一的 get_if 风格检查
                    else if (auto disc_opt = p.get_if<MQTT::v5::disconnect_packet>()) {
                        std::println("[Broker] Client disconnected gracefully.");
                        break;
                    }
                }
            }
        }
    }
    catch (const boost::system::system_error& se) {
        std::println(stderr, "[Session Net Error] {} (Code: {})", se.what(), se.code().value());
    }
    catch (const std::exception& e) {
        std::println(stderr, "[Session Exception] {}", e.what());
    }

    // 优雅关闭 endpoint 链路
    co_await ep->async_close(asio::use_awaitable);
    co_return;
}

// 异步监听 UDS 端口
asio::awaitable<void> listener(std::string socket_path) {
    auto executor = co_await asio::this_coro::executor;

    asio::local::stream_protocol::endpoint ep(socket_path);
    asio::local::stream_protocol::acceptor acceptor(executor, ep);

    // 顺便设置好 UDS 文件的权限，方便本地微服务无障碍 IPC 互通
    fs::permissions(socket_path, fs::perms::owner_all | fs::perms::group_all, fs::perm_options::replace);

    std::println("[Broker] Listening on Unix Socket via C++ 协程: {}", socket_path);

    while (true) {
        try {
            // 在独立的 Strand 内部接收 Socket，确保多线程下绝对的无锁并发安全
            auto socket = co_await acceptor.async_accept(asio::make_strand(executor), asio::use_awaitable);
            std::println("[Broker] New local client connected!");

            // 动态衍生（Spawn）独立协程去处理会话，不阻塞当前的 Accept 循环
            asio::co_spawn(executor, handle_client_session(std::move(socket)), asio::detached);
        }
        catch (const std::exception& e) {
            std::println(stderr, "[Acceptor Error] {}", e.what());
            break;
        }
    }
}

int main() {
    constexpr std::string_view socket_path = "/dev/shm/mqtt/async_mqtt_broker.sock";
    UdsStorageGuard socket_guard(socket_path);

    try {
        const auto concurrency_hint = static_cast<int>(std::thread::hardware_concurrency());
        asio::io_context ioc{concurrency_hint};

        // 信号监听
        asio::signal_set signals(ioc, SIGINT, SIGTERM);
        signals.async_wait([&](const boost::system::error_code&, int) {
            std::println("\n[Broker] Shutdown signal received. Stopping...");
            ioc.stop();
        });

        // 挂载主监听器协程
        asio::co_spawn(ioc, listener(std::string(socket_path)), asio::detached);

        // 构建现代线程池
        std::vector<std::jthread> thread_pool;
        thread_pool.reserve(concurrency_hint - 1);
        for (int i = 0; i < concurrency_hint - 1; ++i) {
            thread_pool.emplace_back([&ioc] { ioc.run(); });
        }
        ioc.run();
    }
    catch (const std::exception& e) {
        std::println(stderr, "Fatal Server Error: {}", e.what());
        return 1;
    }

    return 0;
}