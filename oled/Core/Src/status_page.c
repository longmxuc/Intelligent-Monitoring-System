/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file    status_page.c
  * @brief   状态栏页面功能模块实现
  ******************************************************************************
  * @attention
  *
  * Copyright (c) 2025 STMicroelectronics.
  * All rights reserved.
  *
  ******************************************************************************
  */
/* USER CODE END Header */

/* Includes ------------------------------------------------------------------*/
#include "status_page.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>

/* Private typedef -----------------------------------------------------------*/

/* Private define ------------------------------------------------------------*/
#define STATUS_PAGE_PAGE_NUM 3  // 状态栏页面编号（与监测页区分）

// 如果main.c中没有定义这些宏,则默认启用
#ifndef ENABLE_USART2_TX
#define ENABLE_USART2_TX  1
#endif
#ifndef ENABLE_USART3_TX
#define ENABLE_USART3_TX  1
#endif

/* Private macro -------------------------------------------------------------*/

/* Private variables ---------------------------------------------------------*/
static StatusPageData_t statusData = {
    .state = STATUS_PAGE_IDLE,
    .hour = 0,
    .minute = 0,
    .second = 0,
    .onlineCount = 0,
    .dataValid = 0,
    .timeoutWarning = 0
};

/* Private function prototypes -----------------------------------------------*/
static void StatusPage_SendCommand(const char* cmd);
static void StatusPage_DisplayLoading(void);
static void StatusPage_DisplayContent(void);
static uint8_t StatusPage_MatchPrefixIgnoreCase(const char* src, const char* keyword);

static uint8_t StatusPage_MatchPrefixIgnoreCase(const char* src, const char* keyword)
{
    while (*keyword && *src)
    {
        if (tolower((unsigned char)*src) != tolower((unsigned char)*keyword))
        {
            return 0;
        }
        src++;
        keyword++;
    }
    return (*keyword == '\0') ? 1 : 0;
}

/* Private user code ---------------------------------------------------------*/

/**
 * @brief 发送命令到串口（根据蓝牙连接状态选择串口）
 * @param cmd 要发送的命令字符串
 */
static void StatusPage_SendCommand(const char* cmd)
{
    if (cmd == NULL) return;

    uint16_t len = strlen(cmd);
    if (len == 0) return;

    // 检查蓝牙电源引脚状态（如果蓝牙断电，引脚为低电平）
    GPIO_PinState blePowerState = HAL_GPIO_ReadPin(BLE_POWER_GPIO_Port, BLE_POWER_Pin);

    // 如果蓝牙已关闭（电源引脚为低电平），直接发送到USART2
    if (blePowerState == GPIO_PIN_RESET)
    {
        // 蓝牙已关闭，发送到USART2（Air780e）
#if ENABLE_USART2_TX
        HAL_UART_Transmit(&huart2, (uint8_t*)cmd, len, 100);
#endif
    }
    else
    {
        // 蓝牙未关闭，检测蓝牙连接状态（BLE_STATE为高电平表示蓝牙已连接）
        GPIO_PinState bleState = HAL_GPIO_ReadPin(BLE_STATE_GPIO_Port, BLE_STATE_Pin);
        if (bleState == GPIO_PIN_SET)
        {
            // 蓝牙已连接，只发送到USART3（蓝牙）
#if ENABLE_USART3_TX
            HAL_UART_Transmit(&huart3, (uint8_t*)cmd, len, 100);
#endif
        }
        else
        {
            // 蓝牙未连接，发送到USART2（Air780e）
#if ENABLE_USART2_TX
            HAL_UART_Transmit(&huart2, (uint8_t*)cmd, len, 100);
#endif
        }
    }
}

/**
 * @brief 显示"正在加载..."界面
 */
static void StatusPage_DisplayLoading(void)
{
    OLED_NewFrame();
    OLED_PrintString(20, 30, "正在加载...", &font16x16, OLED_COLOR_NORMAL);
    OLED_ShowFrame();
}

/**
 * @brief 显示状态栏页面内容（时间和在线人数）
 */
static void StatusPage_DisplayContent(void)
{
    OLED_NewFrame();

    if (statusData.timeoutWarning)
    {
        OLED_DrawImage(0, 15, &sadImg, OLED_COLOR_NORMAL);
        OLED_PrintString(45, 15, "接收超时", &font16x16, OLED_COLOR_NORMAL);
        OLED_PrintString(30, 35, "请重启状态栏", &font16x16, OLED_COLOR_NORMAL);
        OLED_ShowFrame();
        return;
    }

    // 上方显示时间和笑脸（24小时制）
    char timeStr[16];
    snprintf(timeStr, sizeof(timeStr), "%02d:%02d:%02d",
             statusData.hour, statusData.minute, statusData.second);
    OLED_DrawImage(0,15,&smileImg, OLED_COLOR_NORMAL);
    OLED_PrintString(45, 15, timeStr, &font16x16, OLED_COLOR_NORMAL);

    // 下方显示当前连接人数
    char countStr[32];
    if (statusData.dataValid)
    {
        snprintf(countStr, sizeof(countStr), "在线人数: %d", statusData.onlineCount);
    }
    else
    {
        snprintf(countStr, sizeof(countStr), "在线人数: --");
    }
    OLED_PrintString(35, 35, countStr, &font16x16, OLED_COLOR_NORMAL);

    OLED_ShowFrame();
}

/* Exported functions --------------------------------------------------------*/

/**
 * @brief 初始化状态栏页面模块
 */
void StatusPage_Init(void)
{
    statusData.state = STATUS_PAGE_IDLE;
    statusData.hour = 0;
    statusData.minute = 0;
    statusData.second = 0;
    statusData.onlineCount = 0;
    statusData.dataValid = 0;
    statusData.timeoutWarning = 0;
}

/**
 * @brief 进入状态栏页面（发送onmessage命令）
 */
void StatusPage_Enter(void)
{
    // 切换到加载状态
    statusData.state = STATUS_PAGE_LOADING;
    statusData.dataValid = 0;
    statusData.timeoutWarning = 0;

    // 显示"正在加载..."
    StatusPage_DisplayLoading();

    // 发送"onmessage"命令
    StatusPage_SendCommand("onmessage\r\n");
}

/**
 * @brief 退出状态栏页面（发送offmessage命令）
 */
void StatusPage_Exit(void)
{
    // 发送"offmessage"命令
    StatusPage_SendCommand("offmessage\r\n");

    // 切换到空闲状态
    statusData.state = STATUS_PAGE_IDLE;
    statusData.dataValid = 0;
    statusData.timeoutWarning = 0;
}

/**
 * @brief 更新状态栏页面显示
 * @note 需要在主循环中定期调用
 */
void StatusPage_UpdateDisplay(void)
{
    if (statusData.state == STATUS_PAGE_IDLE)
    {
        return; // 不在状态栏页面，不更新
    }

    // 根据当前状态显示相应内容
    if (statusData.state == STATUS_PAGE_LOADING)
    {
        // 加载中，显示"正在加载..."
        StatusPage_DisplayLoading();
    }
    else if (statusData.state == STATUS_PAGE_ACTIVE)
    {
        // 激活状态，显示时间和在线人数
        StatusPage_DisplayContent();
    }
}

/**
 * @brief 解析状态消息数据
 * @param data 接收到的数据字符串（格式: "ms:t_17:15:15,p_1"）
 * @return 1=解析成功, 0=解析失败
 */
uint8_t StatusPage_ParseMessage(const char* data, uint16_t len, uint16_t* consumedLen)
{
    if (data == NULL || len == 0) return 0;

    uint16_t index = 0;
    // 跳过前导空白字符
    while (index < len && (data[index] == '\r' || data[index] == '\n' || data[index] == ' '))
    {
        index++;
    }

    // 检查特殊指令：ms:timeout
    const char* timeoutPtr = strstr(data + index, "ms:timeout");
    if (timeoutPtr != NULL && timeoutPtr < data + len)
    {
        // 确保前面没有其它可解析的状态消息（否则先解析状态消息）
        uint16_t offset = (uint16_t)(timeoutPtr - data);
        if (offset <= index)
        {
            statusData.timeoutWarning = 1;
            statusData.dataValid = 0;
            if (statusData.state == STATUS_PAGE_LOADING)
            {
                statusData.state = STATUS_PAGE_ACTIVE;
            }
            if (consumedLen != NULL)
            {
                uint16_t endIdx = offset + 10;
                while (endIdx < len && (data[endIdx] == '\r' || data[endIdx] == '\n' || data[endIdx] == ' '))
                {
                    endIdx++;
                }
                *consumedLen = endIdx;
            }
            return 1;
        }
    }

    const char* startPtr = data + index;

    if (strncmp(startPtr, "ms:", 3) != 0)
    {
        return 0; // 不是状态消息格式
    }

    // 特殊指令：ms:timeout（不区分大小写）
    if (len - index >= 10 && StatusPage_MatchPrefixIgnoreCase(startPtr, "ms:timeout"))
    {
        statusData.timeoutWarning = 1;
        statusData.dataValid = 0;
        if (statusData.state == STATUS_PAGE_LOADING)
        {
            statusData.state = STATUS_PAGE_ACTIVE;
        }
        if (consumedLen != NULL)
        {
            uint16_t endIdx = index + 10;
            while (endIdx < len && (data[endIdx] == '\r' || data[endIdx] == '\n' || data[endIdx] == ' '))
            {
                endIdx++;
            }
            *consumedLen = endIdx;
        }
        return 1;
    }

    if (len - index < 16) return 0; // 长度不足

    const char* timePtr = strstr(startPtr, "t_");
    if (timePtr == NULL) return 0;

    timePtr += 2; // 跳过"t_"

    // 解析时间 HH:MM:SS
    unsigned int hour, minute, second;
    if (sscanf(timePtr, "%u:%u:%u", &hour, &minute, &second) != 3)
    {
        return 0; // 时间格式错误
    }

    // 查找人数部分 ",p_N"
    const char* peoplePtr = strstr(timePtr, ",p_");
    if (peoplePtr == NULL)
    {
        return 0; // 必须包含",p_"
    }
    peoplePtr += 3; // 跳过",p_"

    if (*peoplePtr == '\0')
    {
        return 0; // 人数部分为空
    }

    const char* digitPtr = peoplePtr;
    while (digitPtr < data + len && isdigit((unsigned char)*digitPtr))
    {
        digitPtr++;
    }

    if (digitPtr == peoplePtr)
    {
        return 0; // 不存在数字
    }

    unsigned int count = 0;
    if (sscanf(peoplePtr, "%u", &count) != 1)
    {
        return 0;
    }

    // 更新数据（进行范围检查）
    if (hour > 23 || minute > 59 || second > 59 || count > 255)
    {
        return 0; // 值超出范围
    }

    statusData.hour = (uint8_t)hour;
    statusData.minute = (uint8_t)minute;
    statusData.second = (uint8_t)second;
    statusData.onlineCount = (uint8_t)count;
    statusData.dataValid = 1;
    statusData.timeoutWarning = 0;

    if (statusData.state == STATUS_PAGE_LOADING)
    {
        statusData.state = STATUS_PAGE_ACTIVE;
    }

    if (consumedLen != NULL)
    {
        *consumedLen = (uint16_t)(digitPtr - data);
    }

    return 1; // 解析成功
}

/**
 * @brief 获取当前状态栏页面状态
 * @return StatusPageState_t 当前状态
 */
StatusPageState_t StatusPage_GetState(void)
{
    return statusData.state;
}

/**
 * @brief 检查是否在状态栏页面
 * @return 1=在状态栏页面, 0=不在
 */
uint8_t StatusPage_IsActive(void)
{
    return (statusData.state != STATUS_PAGE_IDLE) ? 1 : 0;
}

/* USER CODE END */
