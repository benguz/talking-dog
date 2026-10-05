# SPDX-License-Identifier: Apache-2.0
cmake_minimum_required(VERSION 3.13.1)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(talking_dog_collar)

target_sources(app PRIVATE
    ../src/main.c
    ../src/ble.c
    ../src/audio_out.c
    ../src/imu.c
    ../src/mic.c
)
target_include_directories(app PRIVATE ../src)
