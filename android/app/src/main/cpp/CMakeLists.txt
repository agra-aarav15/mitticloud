cmake_minimum_required(VERSION 3.22)
project(mitticloud)

# Prebuilt nodejs-mobile libnode.so per ABI (no NDK-compiled Node needed).
add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES
    IMPORTED_LOCATION "${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so")

add_library(mitticloud SHARED mitticloud.cpp)
target_link_libraries(mitticloud node log)
