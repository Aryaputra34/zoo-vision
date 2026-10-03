## Copyright 2026 Magnet. All rights reserved.
## Magnet AI Vision Analytics - Cashier Plugin CMake

add_library(magnet_cashier_plugin SHARED
    plugin.cpp
    cashier_integration.h
    cashier_integration.cpp
    cashier_engine.h
    cashier_engine.cpp
    cashier_device_agent.h
    cashier_device_agent.cpp
    cashier_manifest.h
)

target_include_directories(magnet_cashier_plugin PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/../..
    ${CMAKE_CURRENT_SOURCE_DIR}/../../core
    ${onnxRuntimeDir}/include
)

target_link_libraries(magnet_cashier_plugin PRIVATE
    magnet_core
    nx_sdk
)

if(ONNXRUNTIME_LIB)
    target_link_libraries(magnet_cashier_plugin PRIVATE ${ONNXRUNTIME_LIB})
endif()

if(MINGW)
    target_link_options(magnet_cashier_plugin PRIVATE "-static-libgcc" "-static-libstdc++" "-Wl,-Bstatic" "-lwinpthread" "-Wl,-Bdynamic")
endif()

if(WIN32)
    set_target_properties(magnet_cashier_plugin PROPERTIES
        PREFIX ""
        OUTPUT_NAME "magnet_cashier_plugin"
    )
    message(STATUS "Configured Magnet Cashier Analytics Plugin target: magnet_cashier_plugin.dll")
else()
    set_target_properties(magnet_cashier_plugin PROPERTIES
        PREFIX "lib"
        OUTPUT_NAME "magnet_cashier_plugin"
    )
    message(STATUS "Configured Magnet Cashier Analytics Plugin target: libmagnet_cashier_plugin.so")
endif()
