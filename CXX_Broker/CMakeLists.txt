cmake_minimum_required(VERSION 4.2.0)

set(CMAKE_C_COMPILER   clang   CACHE STRING "C compiler")
set(CMAKE_CXX_COMPILER clang++ CACHE STRING "C++ compiler")

set(CMAKE_CXX_STANDARD 26)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

project(AsyncMqttUnixBroker 
    VERSION 1.0.0 
    LANGUAGES CXX
)

include(FetchContent)

find_package(Boost REQUIRED)
# 为async_mqtt添加依赖配置，确保boost和websocketpp依赖正确传递
# async_mqtt需要正确找到boost依赖，同时配置该库的编译选项
set(ASYNC_MQTT_BUILD_EXAMPLES OFF CACHE BOOL "Disable async_mqtt examples")
set(ASYNC_MQTT_BUILD_TESTS OFF CACHE BOOL "Disable async_mqtt tests")
set(ASYNC_MQTT_USE_STANDALONE_BOOST OFF CACHE BOOL "Use Boost.Beast instead of standalone")

FetchContent_Declare(
    async_mqtt
    GIT_REPOSITORY https://github.com/redboltz/async_mqtt.git
    GIT_TAG 10.3.0
)
FetchContent_MakeAvailable(async_mqtt)

add_executable(mqtt_uds_broker src/main.cpp)


target_compile_options(mqtt_uds_broker PRIVATE
    -fmodules
    -fbuiltin-module-map
    -fimplicit-module-maps
)

# 确保async_mqtt的头文件目录能够被正确包含
target_include_directories(mqtt_uds_broker
    PRIVATE
        ${async_mqtt_SOURCE_DIR}/include
)

# 修复async_mqtt目标引用问题，确保使用该库导出的正确目标名称
# async_mqtt库实际导出的目标为async_mqtt，无需额外命名空间修饰
#target_link_libraries(mqtt_uds_broker 
#    PRIVATE 
#        async_mqtt
#)
