/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file           : main.c
  * @brief          : Main program body
  ******************************************************************************
  * @attention
  *
  * Copyright (c) 2025 STMicroelectronics.
  * All rights reserved.
  *
  * This software is licensed under terms that can be found in the LICENSE file
  * in the root directory of this software component.
  * If no LICENSE file comes with this software, it is provided AS-IS.
  *
  ******************************************************************************
  */
/* USER CODE END Header */
/* Includes ------------------------------------------------------------------*/
#include "main.h"
#include "adc.h"
#include "dma.h"
#include "i2c.h"
#include "usart.h"
#include "gpio.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <sys/types.h>
#include <ctype.h>

#include "oled.h"
#include "aht20.h"
#include "bh1750.h"
#include "mq2.h"
#include "bmp180.h"
/* USER CODE END Includes */

/* Private typedef -----------------------------------------------------------*/
/* USER CODE BEGIN PTD */
/**
 * @brief 状态栏页面状态枚举
 */
typedef enum {
    STATUS_PAGE_IDLE = 0,        // 空闲状态（不在状态栏页面）
    STATUS_PAGE_LOADING,         // 加载中（等待服务器响应）
    STATUS_PAGE_ACTIVE           // 激活状态（显示时间和在线人数）
} StatusPageState_t;

/**
 * @brief 状态栏页面数据结构
 */
typedef struct {
    StatusPageState_t state;     // 当前状态
    uint8_t hour;                // 小时 (0-23)
    uint8_t minute;              // 分钟 (0-59)
    uint8_t second;              // 秒 (0-59)
    uint8_t onlineCount;         // 在线人数
    uint8_t dataValid;           // 数据是否有效 (0=无效, 1=有效)
    uint8_t timeoutWarning;      // 是否处于超时提示状态
} StatusPageData_t;

/* USER CODE END PTD */

/* Private define ------------------------------------------------------------*/
/* USER CODE BEGIN PD */
// 串口发送控制宏定义
#define ENABLE_USART2_TX  1  // 1=启用USART2发送(Air780e), 0=禁用
#define ENABLE_USART3_TX  1  // 1=启用USART3发送(蓝牙), 0=禁用

// 异常检测相关宏定义
#define ALERT_DURATION_MS  3000  // 异常状态持续3秒后发送警告（可调整）

// 状态栏页面相关宏定义
#define STATUS_PAGE_PAGE_NUM 3  // 状态栏页面编号（与监测页区分）

/* USER CODE END PD */

/* Private macro -------------------------------------------------------------*/
/* USER CODE BEGIN PM */

/* USER CODE END PM */

/* Private variables ---------------------------------------------------------*/

/* USER CODE BEGIN PV */
uint8_t receiveData[50];
static uint8_t usart2_rx_byte = 0;
static char usart2_cmd_buf[50];
static uint8_t usart2_cmd_len = 0;
static volatile uint8_t oledPowerCut = 0; // 0=上电,1=断电
static volatile uint8_t oledNeedReinit = 0; // 需要重新初始化OLED
static volatile uint8_t oledPendingPowerOff = 0; // 待断电标志（由中断设置，主循环处理）
static volatile uint8_t bh1750PowerDown = 0; // 0=正常工作,1=PowerDown模式（低功耗）
static volatile uint8_t bmp180Disabled = 0; // 0=正常工作,1=停止工作（不关闭电源，避免影响I2C总线）
static volatile uint8_t blePowerCut = 0; // 0=上电,1=断电

// 状态栏页面数据
static StatusPageData_t statusData = {
    .state = STATUS_PAGE_IDLE,
    .hour = 0,
    .minute = 0,
    .second = 0,
    .onlineCount = 0,
    .dataValid = 0,
    .timeoutWarning = 0
};

/* USER CODE END PV */

/* Private function prototypes -----------------------------------------------*/
void SystemClock_Config(void);
/* USER CODE BEGIN PFP */
void Dual_UART_Transmit(uint8_t* data, uint16_t len, uint32_t timeout);
void Alert_SendWarning(const char* msg);
void Alert_CheckAndSend(float temperature, float humidity, float lux,
                        float ppm, float pressure, uint8_t ppmCalibrated,
                        uint32_t currentTime);
static uint8_t USART2_BufferStartsWithTimeout(const char* buf, uint16_t len);

// 状态栏页面函数声明
void StatusPage_Init(void);
void StatusPage_Enter(void);
void StatusPage_Exit(void);
void StatusPage_UpdateDisplay(void);
uint8_t StatusPage_ParseMessage(const char* data, uint16_t len, uint16_t* consumedLen);
StatusPageState_t StatusPage_GetState(void);
uint8_t StatusPage_IsActive(void);
static void StatusPage_SendCommand(const char* cmd);
static void StatusPage_DisplayLoading(void);
static void StatusPage_DisplayContent(void);
static uint8_t StatusPage_MatchPrefixIgnoreCase(const char* src, const char* keyword);

/* USER CODE END PFP */

/* Private user code ---------------------------------------------------------*/
/* USER CODE BEGIN 0 */
// 中值滤波相关宏定义
#define MEDIAN_FILTER_SIZE 5    // 中值滤波缓冲区大小（奇数推荐，5个数据）

// 中值滤波结构体（可复用于多个传感器）
typedef struct
{
    float buffer[MEDIAN_FILTER_SIZE];
    uint8_t index;
    uint8_t count;
    float lastValue;
    uint32_t lastUpdateTime; // 上次更新时间戳（用于超时重置）
    uint8_t consecutiveRiseCount; // 连续上升次数（用于火情检测）
    float trendStartValue; // 趋势开始时的值（用于累计变化检查）
} MedianFilter_t;

// 异常阈值结构体
typedef struct
{
    float tempMin; // 温度最小值（低于此值异常）
    float tempMax; // 温度最大值（高于此值异常）
    float humiMin; // 湿度最小值（低于此值异常）
    float humiMax; // 湿度最大值（高于此值异常）
    float luxMin; // 亮度最小值（低于此值异常）
    float luxMax; // 亮度最大值（高于此值异常）
    float ppmMin; // PPM最小值（低于此值异常）
    float ppmMax; // PPM最大值（高于此值异常）
    float pressureMin; // 大气压最小值（低于此值异常）
    float pressureMax; // 大气压最大值（高于此值异常）
} AlertThreshold_t;

// 异常状态监测结构体
typedef struct
{
    uint8_t isAbnormal; // 当前是否异常：0=正常，1=异常
    uint8_t lastStatus; // 上次状态：0=正常，1=异常
    uint32_t abnormalStartTime; // 异常开始时间（毫秒）
    uint8_t alertSent; // 是否已发送警告：0=未发送，1=已发送
} AlertStatus_t;

// 处理多模块电源控制命令（来自串口2或串口3）
static uint8_t USART2_BufferStartsWithTimeout(const char* buf, uint16_t len)
{
    const char* keyword = "ms:timeout";
    if (buf == NULL || len < 10) return 0;
    for (uint8_t i = 0; i < 10; i++)
    {
        if (tolower((unsigned char)buf[i]) != keyword[i])
        {
            return 0;
        }
    }
    return 1;
}

static void ProcessPeripheralPowerCommand(const char* text)
{
    if (text == NULL) return;
    if (strstr(text, "OFFMQ2") != NULL)
    {
        HAL_GPIO_WritePin(MQ2_POWER_GPIO_Port, MQ2_POWER_Pin, GPIO_PIN_RESET);
    }
    if (strstr(text, "ONMQ2") != NULL)
    {
        HAL_GPIO_WritePin(MQ2_POWER_GPIO_Port, MQ2_POWER_Pin, GPIO_PIN_SET);
    }
    if (strstr(text, "OFFBH1750") != NULL)
    {
        // 只发送PowerDown命令，不关闭电源，避免影响I2C总线
        bh1750PowerDown = 1;
    }
    if (strstr(text, "ONBH1750") != NULL)
    {
        // 退出PowerDown模式，恢复正常工作
        bh1750PowerDown = 0;
    }
    if (strstr(text, "OFFBPM180") != NULL)
    {
        // 不关闭电源，只停止读取操作，避免影响I2C总线
        bmp180Disabled = 1;
    }
    if (strstr(text, "ONBPM180") != NULL)
    {
        // 恢复正常工作
        bmp180Disabled = 0;
    }
    if (strstr(text, "OFFOLED") != NULL)
    {
        // 只设置待断电标志，不直接断电，让主循环安全地处理断电
        // 这样可以避免在I2C通信过程中突然断电导致死机
        oledPendingPowerOff = 1;
    }
    if (strstr(text, "ONOLED") != NULL)
    {
        HAL_GPIO_WritePin(OLED_POWER_GPIO_Port, OLED_POWER_Pin, GPIO_PIN_SET);
        oledPowerCut = 0;
        oledNeedReinit = 1;
    }
    if (strstr(text, "OFFBLE") != NULL)
    {
        HAL_GPIO_WritePin(BLE_POWER_GPIO_Port, BLE_POWER_Pin, GPIO_PIN_RESET);
        blePowerCut = 1; // 记录蓝牙已断电
    }
    if (strstr(text, "ONBLE") != NULL)
    {
        HAL_GPIO_WritePin(BLE_POWER_GPIO_Port, BLE_POWER_Pin, GPIO_PIN_SET);
        blePowerCut = 0; // 记录蓝牙已上电
    }
}

// 接收中断回调函数（蓝牙）
void HAL_UARTEx_RxEventCallback(UART_HandleTypeDef* huart, uint16_t Size)
{
    if (huart == &huart3)
    {
        // 解析指令并可选回显
        char buf[64];
        uint16_t n = (Size < sizeof(buf) - 1) ? Size : (sizeof(buf) - 1);
        if (n > 0)
        {
            memcpy(buf, receiveData, n);
            buf[n] = '\0';
            
            uint16_t consumed = 0;
            if (StatusPage_IsActive() && StatusPage_ParseMessage(buf, n, &consumed))
            {
                if (consumed < n)
                {
                    ProcessPeripheralPowerCommand(buf + consumed);
                }
            }
            else
            {
                ProcessPeripheralPowerCommand(buf);
            }
            // HAL_UART_Transmit_DMA(&huart3, (uint8_t*)buf, n);
        }
        // 开启下一次接收
        HAL_UARTEx_ReceiveToIdle_DMA(&huart3, receiveData, sizeof(receiveData));
        __HAL_DMA_DISABLE_IT(&hdma_usart3_rx, DMA_IT_TC);
    }
}

// 串口普通接收完成回调（用于USART2逐字节接收）
void HAL_UART_RxCpltCallback(UART_HandleTypeDef* huart)
{
    if (huart == &huart2)
    {
        uint8_t ch = usart2_rx_byte;

        if (ch == '\n' || ch == '\r')
        {
            if (usart2_cmd_len > 0)
            {
                usart2_cmd_buf[usart2_cmd_len] = '\0';
                uint16_t consumed = 0;
                if (!StatusPage_ParseMessage(usart2_cmd_buf, usart2_cmd_len, &consumed))
                {
                    ProcessPeripheralPowerCommand(usart2_cmd_buf);
                }
                usart2_cmd_len = 0;
                usart2_cmd_buf[0] = '\0';
            }
        }
        else if (ch == ' ')
        {
            if (usart2_cmd_len > 0)
            {
                usart2_cmd_buf[usart2_cmd_len] = '\0';
                if (strncmp(usart2_cmd_buf, "ms:", 3) != 0)
                {
                    ProcessPeripheralPowerCommand(usart2_cmd_buf);
                }
                usart2_cmd_len = 0;
                usart2_cmd_buf[0] = '\0';
            }
        }
        else
        {
            if (usart2_cmd_len < sizeof(usart2_cmd_buf) - 1)
            {
                usart2_cmd_buf[usart2_cmd_len++] = (char)ch;
                usart2_cmd_buf[usart2_cmd_len] = '\0';

                if (USART2_BufferStartsWithTimeout(usart2_cmd_buf, usart2_cmd_len))
                {
                    uint16_t consumed = 0;
                    if (StatusPage_ParseMessage(usart2_cmd_buf, usart2_cmd_len, &consumed))
                    {
                        if (consumed < usart2_cmd_len)
                        {
                            uint16_t remaining = usart2_cmd_len - consumed;
                            memmove(usart2_cmd_buf, usart2_cmd_buf + consumed, remaining);
                            usart2_cmd_len = remaining;
                            usart2_cmd_buf[remaining] = '\0';
                        }
                        else
                        {
                            usart2_cmd_len = 0;
                            usart2_cmd_buf[0] = '\0';
                        }
                    }
                    else if (usart2_cmd_len >= 30)
                    {
                        usart2_cmd_len = 0;
                        usart2_cmd_buf[0] = '\0';
                    }
                }
                else if (strncmp(usart2_cmd_buf, "ms:", 3) == 0 && usart2_cmd_len >= 18)
                {
                    if (strstr(usart2_cmd_buf, ",p_") != NULL)
                    {
                        uint16_t consumed = 0;
                        if (StatusPage_ParseMessage(usart2_cmd_buf, usart2_cmd_len, &consumed))
                        {
                            if (consumed < usart2_cmd_len)
                            {
                                uint16_t remaining = usart2_cmd_len - consumed;
                                memmove(usart2_cmd_buf, usart2_cmd_buf + consumed, remaining);
                                usart2_cmd_len = remaining;
                                usart2_cmd_buf[remaining] = '\0';
                            }
                            else
                            {
                                usart2_cmd_len = 0;
                                usart2_cmd_buf[0] = '\0';
                            }
                        }
                        else if (usart2_cmd_len >= 30)
                        {
                            usart2_cmd_len = 0;
                            usart2_cmd_buf[0] = '\0';
                        }
                    }
                    else if (usart2_cmd_len >= 30)
                    {
                        usart2_cmd_len = 0;
                        usart2_cmd_buf[0] = '\0';
                    }
                }
                else if (strncmp(usart2_cmd_buf, "ms:", 3) != 0 &&
                         (strstr(usart2_cmd_buf, "OFFMQ2") || strstr(usart2_cmd_buf, "ONMQ2") ||
                          strstr(usart2_cmd_buf, "OFFBH1750") || strstr(usart2_cmd_buf, "ONBH1750") ||
                          strstr(usart2_cmd_buf, "OFFBPM180") || strstr(usart2_cmd_buf, "ONBPM180") ||
                          strstr(usart2_cmd_buf, "OFFOLED") || strstr(usart2_cmd_buf, "ONOLED") ||
                          strstr(usart2_cmd_buf, "OFFBLE") || strstr(usart2_cmd_buf, "ONBLE")))
                {
                    ProcessPeripheralPowerCommand(usart2_cmd_buf);
                    usart2_cmd_len = 0;
                    usart2_cmd_buf[0] = '\0';
                }
            }
            else
            {
                usart2_cmd_len = 0;
                usart2_cmd_buf[0] = '\0';
            }
        }

        HAL_UART_Receive_IT(&huart2, &usart2_rx_byte, 1);
    }
}

/**
 * @brief 冒泡排序函数（用于中值滤波）
 * @param arr 待排序数组
 * @param size 数组大小
 */
static void BubbleSort(float arr[], uint8_t size)
{
    for (uint8_t i = 0; i < size - 1; i++)
    {
        for (uint8_t j = 0; j < size - 1 - i; j++)
        {
            if (arr[j] > arr[j + 1])
            {
                // 交换
                float temp = arr[j];
                arr[j] = arr[j + 1];
                arr[j + 1] = temp;
            }
        }
    }
}

/**
 * @brief 计算中值（用于中值滤波）
 * @param arr 数据数组
 * @param size 数组大小
 * @return 中值
 */
static float GetMedian(float arr[], uint8_t size)
{
    // 创建临时数组用于排序（不修改原数组）
    float tempArr[MEDIAN_FILTER_SIZE];
    for (uint8_t i = 0; i < size; i++)
    {
        tempArr[i] = arr[i];
    }

    // 排序
    BubbleSort(tempArr, size);

    // 返回中值
    if (size % 2 == 0)
    {
        // 偶数个元素，取中间两个的平均值
        return (tempArr[size / 2 - 1] + tempArr[size / 2]) / 2.0f;
    }
    else
    {
        // 奇数个元素，取中间值
        return tempArr[size / 2];
    }
}

/**
 * @brief 通用中值滤波处理函数（可复用于任何传感器数据）
 * @param filter 中值滤波结构体指针
 * @param rawValue 原始输入值
 * @param fastMode 快速模式：缓冲区未满时使用当前值（更实时），满后使用中值
 * @param currentTime 当前时间戳（用于更新lastUpdateTime）
 * @return 过滤后的值
 */
static float MedianFilter_Process(MedianFilter_t* filter, float rawValue, uint8_t fastMode, uint32_t currentTime)
{
    // 如果是首次有效数据，初始化
    if (filter->count == 0)
    {
        filter->buffer[0] = rawValue;
        filter->index = 1;
        filter->count = 1;
        filter->lastValue = rawValue;
        filter->lastUpdateTime = currentTime;
        return rawValue;
    }

    // 将新数据加入缓冲区
    filter->buffer[filter->index] = rawValue;

    // 更新索引（循环缓冲）
    filter->index = (filter->index + 1) % MEDIAN_FILTER_SIZE;

    // 更新已填充数量
    if (filter->count < MEDIAN_FILTER_SIZE)
    {
        filter->count++;
    }

    // 快速模式：缓冲区未满时直接使用当前值（实时性好），满后使用中值（抗干扰）
    if (fastMode && filter->count < MEDIAN_FILTER_SIZE)
    {
        // 缓冲区未满，使用当前值（实时显示）
        filter->lastValue = rawValue;
        filter->lastUpdateTime = currentTime;
        return rawValue;
    }

    // 计算中值（排序后取中间值）
    float median = GetMedian(filter->buffer, filter->count);

    // 更新上次有效值和时间戳
    filter->lastValue = median;
    filter->lastUpdateTime = currentTime;

    return median;
}

/**
 * @brief AHT20数据过滤函数（范围检查 + 非对称变化率限制 + 连续上升趋势检测 + 超时重置 + 中值滤波）
 * @param rawTemp 原始温度值
 * @param rawHumi 原始湿度值
 * @param filteredTemp 过滤后的温度值（输出）
 * @param filteredHumi 过滤后的湿度值（输出）
 * @param tempFilter 温度中值滤波结构体指针
 * @param humiFilter 湿度中值滤波结构体指针
 * @param currentTime 当前时间戳（用于超时检测）
 * @return 1=数据有效，0=数据无效被过滤
 */
uint8_t AHT20_FilterData(float rawTemp, float rawHumi,
                         float* filteredTemp, float* filteredHumi,
                         MedianFilter_t* tempFilter, MedianFilter_t* humiFilter,
                         uint32_t currentTime)
{
    // ====== 1. 范围检查（限幅滤波）======
    const float TEMP_MIN = -10.0f; // 温度最小值（℃）
    const float TEMP_MAX = 60.0f; // 温度最大值（℃）
    const float HUMI_MIN = 0.0f; // 湿度最小值（%）
    const float HUMI_MAX = 100.0f; // 湿度最大值（%）

    // 检查是否在合理范围内
    if (rawTemp < TEMP_MIN || rawTemp > TEMP_MAX ||
        rawHumi < HUMI_MIN || rawHumi > HUMI_MAX)
    {
        // 超出范围，使用上次有效值
        *filteredTemp = tempFilter->lastValue;
        *filteredHumi = humiFilter->lastValue;
        return 0; // 数据无效
    }

    // ====== 2. 非对称变化率检查 + 连续上升趋势检测（火情检测）======
    // 非对称阈值：上升严格，下降宽松
    const float TEMP_MAX_DELTA_UP = 5.0f; // 温度上升最大变化率（℃/次）- 严格限制
    const float TEMP_MAX_DELTA_DOWN = 15.0f; // 温度下降最大变化率（℃/次）- 允许快速冷却
    const float HUMI_MAX_DELTA_UP = 10.0f; // 湿度上升最大变化率（%/次）
    const float HUMI_MAX_DELTA_DOWN = 20.0f; // 湿度下降最大变化率（%/次）

    // 连续上升趋势检测参数（用于火情等真实快速上升场景）
    const uint8_t CONSECUTIVE_RISE_THRESHOLD = 3; // 连续上升3次后，判定为真实趋势
    const float TEMP_EMERGENCY_DELTA_UP = 15.0f; // 紧急模式下的温度上升阈值（更宽松，允许快速火情）

    // 超时重置机制：缩短超时时间以提高响应速度
    const uint32_t TIMEOUT_MS = 5000; // 5秒超时（10个采样周期），缩短以提高火情响应速度

    // 如果是首次有效数据，直接使用
    if (tempFilter->count == 0)
    {
        *filteredTemp = MedianFilter_Process(tempFilter, rawTemp, 1, currentTime); // 启用快速模式
        *filteredHumi = MedianFilter_Process(humiFilter, rawHumi, 1, currentTime); // 启用快速模式
        // 初始化趋势检测
        tempFilter->consecutiveRiseCount = 0;
        tempFilter->trendStartValue = rawTemp;
        humiFilter->consecutiveRiseCount = 0;
        humiFilter->trendStartValue = rawHumi;
        return 1;
    }

    // ====== 超时重置检查 ======
    uint32_t tempTimeSinceUpdate = currentTime - tempFilter->lastUpdateTime;
    uint32_t humiTimeSinceUpdate = currentTime - humiFilter->lastUpdateTime;

    // 如果温度数据超时，强制重置并接受新值
    if (tempTimeSinceUpdate > TIMEOUT_MS)
    {
        // 超时重置：清空缓冲区，强制接受当前值
        tempFilter->count = 0;
        tempFilter->index = 0;
        tempFilter->lastValue = rawTemp;
        tempFilter->lastUpdateTime = currentTime;
        tempFilter->consecutiveRiseCount = 0;
        tempFilter->trendStartValue = rawTemp;
    }

    // 如果湿度数据超时，强制重置并接受新值
    if (humiTimeSinceUpdate > TIMEOUT_MS)
    {
        humiFilter->count = 0;
        humiFilter->index = 0;
        humiFilter->lastValue = rawHumi;
        humiFilter->lastUpdateTime = currentTime;
        humiFilter->consecutiveRiseCount = 0;
        humiFilter->trendStartValue = rawHumi;
    }

    // ====== 非对称变化率检查 + 连续上升趋势检测 ======
    float tempChange = rawTemp - tempFilter->lastValue; // 正数=上升，负数=下降
    float humiChange = rawHumi - humiFilter->lastValue;

    // ====== 温度变化率检查（带连续上升趋势检测）======
    float tempDelta = fabsf(tempChange);
    uint8_t tempValid = 0;

    if (tempTimeSinceUpdate > TIMEOUT_MS)
    {
        // 超时后直接接受
        tempValid = 1;
        tempFilter->consecutiveRiseCount = 0;
        tempFilter->trendStartValue = rawTemp;
    }
    else if (tempChange > 0)
    {
        // 温度上升：检测连续上升趋势
        tempFilter->consecutiveRiseCount++;

        // 如果连续上升次数达到阈值，判定为真实趋势（如火情）
        if (tempFilter->consecutiveRiseCount >= CONSECUTIVE_RISE_THRESHOLD)
        {
            // 紧急模式：使用更宽松的阈值，允许快速上升
            // 同时检查累计上升是否在合理范围内（防止异常脉冲）
            float totalRise = rawTemp - tempFilter->trendStartValue;
            if (totalRise > 0 && totalRise <= (TEMP_MAX - tempFilter->trendStartValue) &&
                tempDelta <= TEMP_EMERGENCY_DELTA_UP)
            {
                // 连续上升且累计值合理，判定为真实火情，接受数据
                tempValid = 1;
            }
            else
            {
                // 虽然连续上升，但累计值异常，拒绝
                tempValid = 0;
            }
        }
        else
        {
            // 连续上升次数未达阈值，使用正常严格阈值
            tempValid = (tempDelta <= TEMP_MAX_DELTA_UP);
            if (!tempValid && tempFilter->consecutiveRiseCount == 1)
            {
                // 如果单次变化超过阈值，记录趋势起点（第一次超过阈值时）
                tempFilter->trendStartValue = tempFilter->lastValue;
            }
            else if (tempValid && tempFilter->consecutiveRiseCount == 1)
            {
                // 通过检查，如果这是第一次上升，记录趋势起点
                tempFilter->trendStartValue = tempFilter->lastValue;
            }
        }
    }
    else if (tempChange < 0)
    {
        // 温度下降：使用宽松阈值，允许快速冷却
        tempFilter->consecutiveRiseCount = 0; // 重置上升计数
        tempValid = (tempDelta <= TEMP_MAX_DELTA_DOWN);
        // 下降时重置趋势起点
        tempFilter->trendStartValue = tempFilter->lastValue;
    }
    else
    {
        // 温度不变
        tempFilter->consecutiveRiseCount = 0;
        tempValid = 1;
    }

    // ====== 湿度变化率检查（非对称，暂不实现趋势检测）======
    float humiDelta = fabsf(humiChange);
    uint8_t humiValid = 0;
    if (humiTimeSinceUpdate > TIMEOUT_MS)
    {
        // 超时后直接接受
        humiValid = 1;
        humiFilter->consecutiveRiseCount = 0;
        humiFilter->trendStartValue = rawHumi;
    }
    else if (humiChange > 0)
    {
        // 湿度上升：使用严格阈值
        humiValid = (humiDelta <= HUMI_MAX_DELTA_UP);
    }
    else
    {
        // 湿度下降：使用宽松阈值
        humiValid = (humiDelta <= HUMI_MAX_DELTA_DOWN);
    }

    // 如果变化率检查失败，使用上次有效值
    if (!tempValid || !humiValid)
    {
        *filteredTemp = tempFilter->lastValue;
        *filteredHumi = humiFilter->lastValue;
        return 0; // 数据无效
    }

    // ====== 3. 中值滤波（抗脉冲干扰）======
    // 启用快速模式：缓冲区未满时实时显示，满后使用中值滤波
    *filteredTemp = MedianFilter_Process(tempFilter, rawTemp, 1, currentTime); // 启用快速模式
    *filteredHumi = MedianFilter_Process(humiFilter, rawHumi, 1, currentTime); // 启用快速模式

    return 1; // 数据有效
}

/**
 * @brief MQ2数据过滤函数（范围检查 + 非对称变化率限制 + 超时重置 + 中值滤波）
 * @param rawRsRo 原始Rs/Ro比值
 * @param rawPpm 原始PPM值
 * @param filteredRsRo 过滤后的Rs/Ro比值（输出）
 * @param filteredPpm 过滤后的PPM值（输出）
 * @param rsRoFilter Rs/Ro中值滤波结构体指针
 * @param ppmFilter PPM中值滤波结构体指针
 * @param currentTime 当前时间戳（用于超时检测）
 * @param calibrated 是否已校准标志
 * @return 1=数据有效，0=数据无效被过滤
 */
uint8_t MQ2_FilterData(float rawRsRo, float rawPpm,
                       float* filteredRsRo, float* filteredPpm,
                       MedianFilter_t* rsRoFilter, MedianFilter_t* ppmFilter,
                       uint32_t currentTime, uint8_t calibrated)
{
    // ====== 1. 范围检查（限幅滤波）======
    const float RSRO_MIN = 0.1f; // Rs/Ro比值最小值
    const float RSRO_MAX = 10.0f; // Rs/Ro比值最大值
    const float PPM_MIN = 0.0f; // PPM值最小值
    const float PPM_MAX = 10000.0f; // PPM值最大值

    // 检查Rs/Ro是否在合理范围内
    uint8_t rsRoValid = (rawRsRo >= RSRO_MIN && rawRsRo <= RSRO_MAX);

    // 检查PPM是否在合理范围内（仅在校准后检查）
    uint8_t ppmValid = 1;
    if (calibrated)
    {
        ppmValid = (rawPpm >= PPM_MIN && rawPpm <= PPM_MAX);
    }

    // 如果超出范围，使用上次有效值
    if (!rsRoValid)
    {
        *filteredRsRo = rsRoFilter->lastValue;
    }
    if (!ppmValid)
    {
        *filteredPpm = ppmFilter->lastValue;
        if (!rsRoValid)
        {
            return 0; // 两个都无效
        }
        return 1; // Rs/Ro有效，PPM无效（但PPM可能未校准）
    }

    // ====== 2. 非对称变化率检查（烟雾浓度特性：上升宽松，下降严格）======
    // 非对称阈值设计思路：
    // - 上升宽松：快速响应危险烟雾浓度上升（报警优先级）
    // - 下降严格：防止电气噪声导致的误跳变（稳定性优先级）
    const float RSRO_MAX_DELTA_UP = 2.0f; // Rs/Ro上升最大变化率（宽松，快速响应）
    const float RSRO_MAX_DELTA_DOWN = 0.5f; // Rs/Ro下降最大变化率（严格，防止误跳变）
    const float PPM_MAX_DELTA_UP = 1000.0f; // PPM上升最大变化率（宽松，快速响应危险）
    const float PPM_MAX_DELTA_DOWN = 200.0f; // PPM下降最大变化率（严格，防止误跳变）

    // 超时重置机制：如果长时间未更新，强制接受新值（防止数据锁定）
    const uint32_t TIMEOUT_MS = 5000; // 5秒超时（5个采样周期，MQ2采样周期1秒）

    // 如果是首次有效数据，直接使用
    if (rsRoFilter->count == 0)
    {
        *filteredRsRo = MedianFilter_Process(rsRoFilter, rawRsRo, 1, currentTime);
        if (calibrated && ppmValid)
        {
            *filteredPpm = MedianFilter_Process(ppmFilter, rawPpm, 1, currentTime);
        }
        else
        {
            *filteredPpm = ppmFilter->lastValue;
        }
        return 1;
    }

    // ====== 超时重置检查 ======
    uint32_t rsRoTimeSinceUpdate = currentTime - rsRoFilter->lastUpdateTime;
    uint32_t ppmTimeSinceUpdate = currentTime - ppmFilter->lastUpdateTime;

    // 如果Rs/Ro数据超时，强制重置并接受新值
    if (rsRoTimeSinceUpdate > TIMEOUT_MS)
    {
        rsRoFilter->count = 0;
        rsRoFilter->index = 0;
        rsRoFilter->lastValue = rawRsRo;
        rsRoFilter->lastUpdateTime = currentTime;
    }

    // 如果PPM数据超时，强制重置并接受新值
    if (ppmTimeSinceUpdate > TIMEOUT_MS)
    {
        ppmFilter->count = 0;
        ppmFilter->index = 0;
        ppmFilter->lastValue = rawPpm;
        ppmFilter->lastUpdateTime = currentTime;
    }

    // ====== 非对称变化率检查 ======
    float rsRoChange = rawRsRo - rsRoFilter->lastValue; // 正数=上升，负数=下降
    float ppmChange = (calibrated && ppmValid) ? (rawPpm - ppmFilter->lastValue) : 0.0f;

    // Rs/Ro变化率检查（非对称）
    float rsRoDelta = fabsf(rsRoChange);
    uint8_t rsRoRateValid = 0;
    if (rsRoTimeSinceUpdate > TIMEOUT_MS)
    {
        // 超时后直接接受
        rsRoRateValid = 1;
    }
    else if (rsRoChange > 0)
    {
        // Rs/Ro上升：使用宽松阈值（快速响应危险）
        rsRoRateValid = (rsRoDelta <= RSRO_MAX_DELTA_UP);
    }
    else
    {
        // Rs/Ro下降：使用严格阈值（防止误跳变）
        rsRoRateValid = (rsRoDelta <= RSRO_MAX_DELTA_DOWN);
    }

    // PPM变化率检查（非对称，仅在校准后检查）
    uint8_t ppmRateValid = 1;
    if (calibrated && ppmValid)
    {
        float ppmDelta = fabsf(ppmChange);
        if (ppmTimeSinceUpdate > TIMEOUT_MS)
        {
            // 超时后直接接受
            ppmRateValid = 1;
        }
        else if (ppmChange > 0)
        {
            // PPM上升：使用宽松阈值（快速响应危险）
            ppmRateValid = (ppmDelta <= PPM_MAX_DELTA_UP);
        }
        else
        {
            // PPM下降：使用严格阈值（防止误跳变）
            ppmRateValid = (ppmDelta <= PPM_MAX_DELTA_DOWN);
        }
    }

    // 如果变化率检查失败，使用上次有效值
    if (!rsRoRateValid)
    {
        *filteredRsRo = rsRoFilter->lastValue;
    }
    if (!ppmRateValid)
    {
        *filteredPpm = ppmFilter->lastValue;
        if (!rsRoRateValid)
        {
            return 0; // 两个都无效
        }
        return 1; // Rs/Ro有效，PPM无效
    }

    // ====== 3. 中值滤波（抗脉冲干扰）======
    // 启用快速模式：缓冲区未满时实时显示，满后使用中值滤波
    *filteredRsRo = MedianFilter_Process(rsRoFilter, rawRsRo, 1, currentTime);
    if (calibrated && ppmValid)
    {
        *filteredPpm = MedianFilter_Process(ppmFilter, rawPpm, 1, currentTime);
    }
    else
    {
        *filteredPpm = ppmFilter->lastValue;
    }

    return 1; // 数据有效
}

BH1750_Handle hbh1750;

// MQ2 参数结构体
MQ2_Params mq2Params;
MQ2_Result mq2Result;

// BMP180 句柄
BMP180_HandleTypeDef hbmp180;
float bmp180_temp = 0.0f; // BMP180温度
float bmp180_pressure = 0.0f; // 气压值（Pa）
float bmp180_altitude = 0.0f; // 海拔高度（仅用于OLED显示）

// 异常检测相关全局变量
AlertThreshold_t alertThreshold = {
    .tempMin = 15.0f, // 温度下限
    .tempMax = 27.0f, // 温度上限
    .humiMin = 30.0f, // 湿度下限
    .humiMax = 75.0f, // 湿度上限
    .luxMin = 5.0f, // 亮度下限
    .luxMax = 2000.0f, // 亮度上限
    .ppmMin = 0.0f, // PPM下限
    .ppmMax = 50.0f, // PPM上限
    .pressureMin = 100000.0f, // 大气压下限
    .pressureMax = 103000.0f // 大气压上限
};

// 各传感器的异常状态监测
AlertStatus_t alertTemp = {0}; // 温度异常状态
AlertStatus_t alertHumi = {0}; // 湿度异常状态
AlertStatus_t alertLux = {0}; // 亮度异常状态
AlertStatus_t alertPpm = {0}; // PPM异常状态
AlertStatus_t alertPressure = {0}; // 大气压异常状态

/**
 * @brief 发送警告消息（根据蓝牙连接状态选择串口）
 * @param msg 要发送的消息字符串
 */
void Alert_SendWarning(const char* msg)
{
    if (msg == NULL) return;

    uint16_t len = strlen(msg);
    if (len == 0) return;

    // 如果蓝牙已关闭，直接发送到USART2
    // 如果蓝牙未关闭，检测蓝牙连接状态（BLE_STATE为高电平表示蓝牙已连接）
    if (blePowerCut)
    {
        // 蓝牙已关闭，发送到USART2（Air780e）
#if ENABLE_USART2_TX
        HAL_UART_Transmit(&huart2, (uint8_t*)msg, len, 100);
#endif
    }
    else
    {
        GPIO_PinState bleState = HAL_GPIO_ReadPin(BLE_STATE_GPIO_Port, BLE_STATE_Pin);
        if (bleState == GPIO_PIN_SET)
        {
            // 蓝牙已连接，只发送到USART3（蓝牙）
#if ENABLE_USART3_TX
            HAL_UART_Transmit(&huart3, (uint8_t*)msg, len, 100);
#endif
        }
        else
        {
            // 蓝牙未连接，发送到USART2（Air780e）
#if ENABLE_USART2_TX
            HAL_UART_Transmit(&huart2, (uint8_t*)msg, len, 100);
#endif
        }
    }
}

/**
 * @brief 检查单个传感器数据是否异常并发送警告
 * @param value 当前传感器值
 * @param min 最小值阈值
 * @param max 最大值阈值
 * @param status 异常状态监测结构体指针
 * @param typeChar 类型字符（'T'=温度, 'H'=湿度, 'B'=亮度, 'S'=PPM, 'P'=大气压）
 * @param currentTime 当前时间戳
 */
static void Alert_CheckSensor(float value, float min, float max,
                              AlertStatus_t* status, char typeChar, uint32_t currentTime)
{
    // 检查是否异常（超出范围）
    uint8_t isAbnormal = (value < min || value > max) ? 1 : 0;

    if (isAbnormal)
    {
        // 当前异常
        if (status->lastStatus == 0)
        {
            // 从正常变为异常，记录异常开始时间
            status->abnormalStartTime = currentTime;
            status->alertSent = 0; // 重置警告发送标志
        }

        // 检查异常持续时间
        if (!status->alertSent && (currentTime - status->abnormalStartTime) >= ALERT_DURATION_MS)
        {
            // 异常持续时间达到阈值，发送警告消息
            char msg[32];
            snprintf(msg, sizeof(msg), "D%c%.2f\r\n", typeChar, value);
            Alert_SendWarning(msg);
            status->alertSent = 1; // 标记已发送警告
        }
    }
    else
    {
        // 当前正常
        if (status->lastStatus == 1)
        {
            // 从异常恢复正常，发送安全消息
            char msg[8];
            snprintf(msg, sizeof(msg), "S%c\r\n", typeChar);
            Alert_SendWarning(msg);
            status->alertSent = 0; // 重置警告发送标志
        }
    }

    // 更新状态
    status->isAbnormal = isAbnormal;
    status->lastStatus = isAbnormal;
}

/**
 * @brief 检查所有传感器数据并发送警告
 * @param temperature 当前温度值
 * @param humidity 当前湿度值
 * @param lux 当前亮度值
 * @param ppm 当前PPM值
 * @param pressure 当前大气压值（Pa）
 * @param ppmCalibrated PPM是否已校准（1=已校准，0=未校准）
 * @param currentTime 当前时间戳
 */
void Alert_CheckAndSend(float temperature, float humidity, float lux,
                        float ppm, float pressure, uint8_t ppmCalibrated,
                        uint32_t currentTime)
{
    // 检查温度
    Alert_CheckSensor(temperature, alertThreshold.tempMin, alertThreshold.tempMax,
                      &alertTemp, 'T', currentTime);

    // 检查湿度
    Alert_CheckSensor(humidity, alertThreshold.humiMin, alertThreshold.humiMax,
                      &alertHumi, 'H', currentTime);

    // 检查亮度
    Alert_CheckSensor(lux, alertThreshold.luxMin, alertThreshold.luxMax,
                      &alertLux, 'B', currentTime);

    // 检查PPM（需要MQ2已校准）
    if (ppmCalibrated)
    {
        Alert_CheckSensor(ppm, alertThreshold.ppmMin, alertThreshold.ppmMax,
                          &alertPpm, 'S', currentTime);
    }

    // 检查大气压
    Alert_CheckSensor(pressure, alertThreshold.pressureMin, alertThreshold.pressureMax,
                      &alertPressure, 'P', currentTime);
}

// ====== 状态栏页面功能实现 ======

/**
 * @brief 匹配前缀（不区分大小写）
 * @param src 源字符串
 * @param keyword 关键字
 * @return 1=匹配, 0=不匹配
 */
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

/* USER CODE END 0 */

/**
  * @brief  The application entry point.
  * @retval int
  */
int main(void)
{
    /* USER CODE BEGIN 1 */

    /* USER CODE END 1 */

    /* MCU Configuration--------------------------------------------------------*/

    /* Reset of all peripherals, Initializes the Flash interface and the Systick. */
    HAL_Init();

    /* USER CODE BEGIN Init */

    /* USER CODE END Init */

    /* Configure the system clock */
    SystemClock_Config();

    /* USER CODE BEGIN SysInit */

    /* USER CODE END SysInit */

    /* Initialize all configured peripherals */
    MX_GPIO_Init();
    MX_DMA_Init();
    MX_I2C1_Init();
    MX_USART3_UART_Init();
    MX_ADC1_Init();
    MX_USART2_UART_Init();
    /* USER CODE BEGIN 2 */

    // 启动USART2逐字节中断接收
    HAL_UART_Receive_IT(&huart2, &usart2_rx_byte, 1);

    // BH1750 非阻塞状态机
    typedef enum { BH_IDLE = 0, BH_WAIT, BH_READY } BH_STATE;
    volatile BH_STATE bh_state = BH_IDLE;
    volatile uint32_t bh_deadline_ms = 0; // 转换完成的最早时间点
    volatile float bh_lux = 0.0f; // 最新光照
    volatile uint8_t bh_new = 0; // 有新数据标志

    // 软定时器（毫秒）
    uint32_t t_now = 0;
    uint32_t t_aht20 = 0, t_oled = 0, t_bt = 0, t_bh1750 = 0, t_mq2 = 0, t_bmp180 = 0, t_uart2 = 0;

    // 周期（毫秒）
    const uint32_t PERIOD_ENV_MS = 500; // 温湿度/OLED 刷新周期（500ms）
    const uint32_t PERIOD_BH_MS = 2000; // BH1750 触发周期
    const uint32_t BH_CONV_MS = 180; // BH1750 高分辨率典型转换时间（保守）
    const uint32_t PERIOD_MQ2_MS = 1000; // MQ2 读取周期（1秒，减少功耗波动）
    const uint32_t PERIOD_BMP180_MS = 1000; // BMP180 读取周期（1秒）
    const uint32_t PERIOD_BT_MS = 2000; // 蓝牙发送周期（USART3）
    const uint32_t PERIOD_UART2_MS = 5000; // Air780e发送周期（USART2）

    // 页面切换相关
    uint8_t currentPage = 0; // 当前页面：0-第一页（温湿度亮度），1-第二页（雾度），2-第三页（BMP180），3-状态栏页面
    uint8_t lastKeyState = GPIO_PIN_SET; // 上次按键状态
    uint32_t keyPressTime = 0; // 按键按下时间
    uint8_t lastOledKeyState = GPIO_PIN_SET; // OLED_KEY上次状态
    uint32_t oledKeyPressTime = 0; // OLED_KEY按下时间
    uint8_t lastStateKeyState = GPIO_PIN_SET; // STATE_KEY上次状态
    uint32_t stateKeyPressTime = 0; // STATE_KEY按下时间
    const uint32_t KEY_DEBOUNCE_MS = 50; // 按键消抖时间

    HAL_Delay(100); // 等待100毫秒让OLED初始化
    OLED_Init();
    AHT20_Init();
    StatusPage_Init(); // 初始化状态栏页面模块
    float temperature, humidity;
    char message[100];

    // 开启串口DMA接收（蓝牙）
    HAL_UARTEx_ReceiveToIdle_DMA(&huart3, receiveData, sizeof(receiveData));
    // 关闭接收过半中断
    __HAL_DMA_DISABLE_IT(&hdma_usart3_rx, DMA_IT_TC);
    // 保存之前的温湿度值
    float lastTemperature = 0.0f;
    float lastHumidity = 0.0f;
    float lastLux = -1.0f; // 初始化为无效值，确保首次上报
    float lastPpm = -1.0f; // 保存上次的PPM值

    // ====== AHT20 数据过滤相关变量 ======
    // 过滤后的温湿度值（用于显示和发送）
    float filteredTemperature = 0.0f;
    float filteredHumidity = 0.0f;

    // AHT20 中值滤波结构体（温度、湿度）
    MedianFilter_t tempFilter = {0};
    MedianFilter_t humiFilter = {0};

    // ====== MQ2 数据过滤相关变量 ======
    // 过滤后的MQ2值（用于显示和发送）
    float filteredRsRo = 0.0f;
    float filteredPpm = 0.0f;

    // MQ2 中值滤波结构体（Rs/Ro比值、PPM值）
    MedianFilter_t mq2RsRoFilter = {0};
    MedianFilter_t mq2PpmFilter = {0};

    // 若 ADDR=GND，用 0x23；ADDR=VCC，用 0x5C
    if (BH1750_Init(&hbh1750, &hi2c1, BH1750_ADDR_HIGH) != BH1750_OK)
    {
        // 错误处理
        Error_Handler();
    }

    // 初始化 BMP180 - 工作模式选择
    // ┌─────────────┬────────────┬──────────┬──────────┬──────────┬─────────┐
    // │   模式      │  采样次数  │ 转换时间 │ 电流消耗 │   精度   │  噪声   │
    // ├─────────────┼────────────┼──────────┼──────────┼──────────┼─────────┤
    // │ BMP180_OSS_0│    1次     │  4.5ms   │   3μA    │  最低    │  最大   │ Ultra Low Power
    // │ BMP180_OSS_1│    2次     │  7.5ms   │   5μA    │  标准    │  标准   │ Standard (默认)
    // │ BMP180_OSS_2│    4次     │ 13.5ms   │   7μA    │   高     │  较小   │ High Resolution
    // │ BMP180_OSS_3│    8次     │ 25.5ms   │  12μA    │ 最高★   │ 最小★  │ Ultra High Resolution
    // └─────────────┴────────────┴──────────┴──────────┴──────────┴─────────┘
    // 压力精度：OSS_0=±1hPa, OSS_1=±0.5hPa, OSS_2=±0.25hPa, OSS_3=±0.12hPa
    // 推荐选择：实验室/精确测量用OSS_3；便携/省电用OSS_0；一般应用用OSS_1
    if (BMP180_Init(&hbmp180, &hi2c1, BMP180_OSS_3) != HAL_OK)
    {
        // 使用最高精度模式
        // 错误处理
        Error_Handler();
    }

    // 初始化 MQ2 参数
    MQ2_Default(&mq2Params);
    // 这里可以根据实际情况设置参数或从Flash读取校准值
    // mq2Params.Ro = 从Flash读取的值;
    // mq2Params.calibrated = 1;
    mq2Result.ppm = 0.0f;

    for (uint8_t i = 0; i < 70; i++)
    {
        OLED_NewFrame();

        OLED_DrawCircle(64, 32, i, OLED_COLOR_NORMAL);
        OLED_DrawCircle(64, 32, 2 * i, OLED_COLOR_NORMAL);
        OLED_DrawCircle(64, 32, 3 * i, OLED_COLOR_NORMAL);

        OLED_ShowFrame();
    }

    for (uint8_t i = 0; i < 20; i++)
    {
        OLED_NewFrame();
        OLED_DrawImage(0, 19 - i, &imageImg, OLED_COLOR_NORMAL);
        OLED_PrintString(5, 64 - i, "智能环境监测系统", &font15x15, OLED_COLOR_NORMAL);
        OLED_ShowFrame();
    }

    HAL_Delay(1500);

    // ====== MQ2 快速校准（开发模式）======
    // 快速采样50次，约1秒完成
    uint32_t adc_sum = 0;
    uint16_t sample_count = 50;

    for (uint16_t i = 0; i < sample_count; i++)
    {
        HAL_ADC_Start(&hadc1);
        if (HAL_ADC_PollForConversion(&hadc1, 10) == HAL_OK)
        {
            adc_sum += HAL_ADC_GetValue(&hadc1);
        }
        HAL_ADC_Stop(&hadc1);
        HAL_Delay(10);
    }

    // 执行校准（在洁净空气中校准，clean_air_factor设为1.0）
    float calibrated_Ro = MQ2_Calibrate(&mq2Params, adc_sum, sample_count, 1.0f);

    // ====== 校准结束 ======


    /* USER CODE END 2 */

    /* Infinite loop */
    /* USER CODE BEGIN WHILE */
    while (1)
    {
        t_now = HAL_GetTick();

        // ====== 0) 按键检测与页面切换（带消抖）======
        // 只有在非状态栏页面时才允许SWITCH_KEY切换监测页
        if (currentPage != 3)
        {
            GPIO_PinState currentKeyState = HAL_GPIO_ReadPin(SWITCH_KEY_GPIO_Port, SWITCH_KEY_Pin);
            if (currentKeyState == GPIO_PIN_RESET && lastKeyState == GPIO_PIN_SET)
            {
                // 检测到按键按下（下降沿）
                keyPressTime = t_now;
            }
            else if (currentKeyState == GPIO_PIN_SET && lastKeyState == GPIO_PIN_RESET)
            {
                // 检测到按键释放（上升沿）
                if ((t_now - keyPressTime) >= KEY_DEBOUNCE_MS)
                {
                    // 有效按键，切换页面
                    currentPage = (currentPage + 1) % 3; // 在0、1、2之间切换
                    // 立即刷新OLED显示
                    t_aht20 = 0; // 强制触发OLED刷新
                }
            }
            lastKeyState = currentKeyState;
        }
        else
        {
            // 在状态栏页面时，保持lastKeyState状态
            lastKeyState = HAL_GPIO_ReadPin(SWITCH_KEY_GPIO_Port, SWITCH_KEY_Pin);
        }

        // ====== 0.3) STATE_KEY 控制状态栏页面切换 ======
        GPIO_PinState stateKeyState = HAL_GPIO_ReadPin(STATE_KEY_GPIO_Port, STATE_KEY_Pin);
        if (stateKeyState == GPIO_PIN_RESET && lastStateKeyState == GPIO_PIN_SET)
        {
            // 检测到按键按下（下降沿）
            stateKeyPressTime = t_now;
        }
        else if (stateKeyState == GPIO_PIN_SET && lastStateKeyState == GPIO_PIN_RESET)
        {
            // 检测到按键释放（上升沿）
            if ((t_now - stateKeyPressTime) >= KEY_DEBOUNCE_MS)
            {
                // 有效按键，切换状态栏页面
                if (currentPage == 3)
                {
                    // 当前在状态栏页面，退出并返回监测页第一页
                    StatusPage_Exit();
                    // 清空USART2接收缓冲区，避免残留的状态消息数据影响后续命令
                    usart2_cmd_len = 0;
                    usart2_cmd_buf[0] = '\0';
                    currentPage = 0; // 返回第一页
                    t_aht20 = 0; // 强制触发OLED刷新
                }
                else
                {
                    // 当前在监测页，切换到状态栏页面
                    currentPage = 3;
                    StatusPage_Enter();
                }
            }
        }
        lastStateKeyState = stateKeyState;

        // ====== 0.5) OLED_KEY 控制 OLED 供电（非自锁按键，按一下切换一次）======
        GPIO_PinState oledKeyState = HAL_GPIO_ReadPin(OLED_KEY_GPIO_Port, OLED_KEY_Pin);
        if (oledKeyState == GPIO_PIN_RESET && lastOledKeyState == GPIO_PIN_SET)
        {
            oledKeyPressTime = t_now;
        }
        else if (oledKeyState == GPIO_PIN_SET && lastOledKeyState == GPIO_PIN_RESET)
        {
            if ((t_now - oledKeyPressTime) >= KEY_DEBOUNCE_MS)
            {
                if (oledPowerCut)
                {
                    // 上电：直接操作，因为此时OLED已经断电，不会有I2C冲突
                    HAL_GPIO_WritePin(OLED_POWER_GPIO_Port, OLED_POWER_Pin, GPIO_PIN_SET);
                    HAL_Delay(100);
                    OLED_Init();
                    oledPowerCut = 0;
                    oledNeedReinit = 0;
                }
                else
                {
                    // 断电：使用待断电标志，让主循环安全地处理断电
                    oledPendingPowerOff = 1;
                }
            }
        }
        lastOledKeyState = oledKeyState;

        // ====== 0.6) 处理OLED待断电请求（安全断电）======
        if (oledPendingPowerOff)
        {
            // 先关闭OLED显示（发送关闭命令），确保I2C操作完成
            if (!oledPowerCut)
            {
                // 只有在OLED还上电时才需要关闭显示
                OLED_DisPlay_Off();
                // 等待I2C操作完成
                HAL_Delay(10);
            }
            // 然后断电
            HAL_GPIO_WritePin(OLED_POWER_GPIO_Port, OLED_POWER_Pin, GPIO_PIN_RESET);
            oledPowerCut = 1;
            oledNeedReinit = 0;
            oledPendingPowerOff = 0; // 清除待断电标志
        }

        if (!oledPowerCut && oledNeedReinit)
        {
            HAL_Delay(100);
            OLED_Init();
            oledNeedReinit = 0;
        }

        // ====== 0.7) 处理BH1750 PowerDown模式切换 ======
        static uint8_t lastBh1750PowerDown = 0;
        if (bh1750PowerDown != lastBh1750PowerDown)
        {
            if (bh1750PowerDown)
            {
                // 进入PowerDown模式：先停止状态机，然后发送PowerDown命令
                bh_state = BH_IDLE;
                HAL_Delay(10); // 等待I2C操作完成
                uint8_t cmd = BH1750_POWER_DOWN;
                HAL_I2C_Master_Transmit(&hi2c1, hbh1750.devAddr7 << 1, &cmd, 1, 10);
            }
            else
            {
                // 退出PowerDown模式：发送PowerOn命令并重新初始化
                uint8_t cmd = BH1750_POWER_ON;
                HAL_I2C_Master_Transmit(&hi2c1, hbh1750.devAddr7 << 1, &cmd, 1, 10);
                HAL_Delay(10);
                if (BH1750_Init(&hbh1750, &hi2c1, BH1750_ADDR_HIGH) == BH1750_OK)
                {
                    bh_state = BH_IDLE;
                    t_bh1750 = t_now; // 重置定时器
                }
            }
            lastBh1750PowerDown = bh1750PowerDown;
        }

        // ====== 1) 非阻塞触发 BH1750 测量（极短 I2C 命令）======
        // 只有在BH1750未进入PowerDown模式时才进行操作
        if (!bh1750PowerDown && (uint32_t)(t_now - t_bh1750) >= PERIOD_BH_MS && bh_state == BH_IDLE)
        {
            // 发送一次性高分辨率模式命令（0x20）
            uint8_t cmd = BH1750_ONESHOT_HRES_MODE;
            if (HAL_I2C_Master_Transmit(&hi2c1, hbh1750.devAddr7 << 1, &cmd, 1, 2) == HAL_OK)
            {
                bh_state = BH_WAIT;
                bh_deadline_ms = t_now + BH_CONV_MS;
            }
            else
            {
                // I2C 短暂失败，下一周期再试
                bh_state = BH_IDLE;
            }
            t_bh1750 = t_now; // 即便失败也推进周期，避免总线被打爆
        }
        else if (bh1750PowerDown && bh_state != BH_IDLE)
        {
            // 如果进入PowerDown模式但状态不是IDLE，立即停止
            bh_state = BH_IDLE;
        }

        // ====== 2) 到时读取 BH1750（极短 I2C 读 2 字节）======
        // 只有在BH1750未进入PowerDown模式时才进行读取
        if (!bh1750PowerDown && bh_state == BH_WAIT && (int32_t)(t_now - bh_deadline_ms) >= 0)
        {
            uint8_t buf[2];
            if (HAL_I2C_Master_Receive(&hi2c1, hbh1750.devAddr7 << 1, buf, 2, 2) == HAL_OK)
            {
                uint16_t raw = ((uint16_t)buf[0] << 8) | buf[1];
                bh_lux = (float)raw / 1.2f;
                bh_new = 1;
            }
            // 无论成功与否，都回到 IDLE，等待下一个周期再触发
            bh_state = BH_IDLE;
        }

        // ====== 2.5) 读取 MQ2 雾度传感器（ADC）======
        if ((uint32_t)(t_now - t_mq2) >= PERIOD_MQ2_MS)
        {
            // 启动ADC转换
            HAL_ADC_Start(&hadc1);
            // 等待转换完成（轮询模式，时间很短）
            if (HAL_ADC_PollForConversion(&hadc1, 10) == HAL_OK)
            {
                uint16_t adcValue = HAL_ADC_GetValue(&hadc1);
                // 计算MQ2数据（原始值）
                MQ2_FromAdcRaw(&mq2Params, adcValue, &mq2Result);

                // 数据过滤（范围检查 + 非对称变化率限制 + 超时重置 + 中值滤波）
                MQ2_FilterData(mq2Result.Rs_Ro, mq2Result.ppm,
                               &filteredRsRo, &filteredPpm,
                               &mq2RsRoFilter, &mq2PpmFilter,
                               t_now, mq2Params.calibrated);

                // 更新为过滤后的值
                mq2Result.Rs_Ro = filteredRsRo;
                if (mq2Params.calibrated)
                {
                    mq2Result.ppm = filteredPpm;
                }
            }
            HAL_ADC_Stop(&hadc1);
            t_mq2 = t_now;
        }

        // ====== 2.6) 读取 BMP180 温度和压力 ======
        // 只有在BMP180未禁用时才进行读取（不关闭电源，避免影响I2C总线）
        if (!bmp180Disabled && (uint32_t)(t_now - t_bmp180) >= PERIOD_BMP180_MS)
        {
            int32_t temp_x10 = 0; // 温度 * 10 (0.1°C单位)
            int32_t press_pa = 0; // 压力 (Pa)

            if (BMP180_ReadTempPressure(&hbmp180, &temp_x10, &press_pa) == HAL_OK)
            {
                bmp180_temp = temp_x10 / 10.0f; // 转换为℃
                bmp180_pressure = (float)press_pa; // 保存气压值（Pa）
                // 计算海拔高度（相对于标准海平面气压101325Pa，仅用于OLED显示）
                bmp180_altitude = BMP180_PressureToAltitude((float)press_pa, 101325.0f);
            }
            t_bmp180 = t_now;
        }

        // ====== 3) 环境采样与 OLED 刷新（非阻塞节拍）======
        if ((uint32_t)(t_now - t_aht20) >= PERIOD_ENV_MS)
        {
            // 检查I2C总线状态，如果异常则恢复
            if (HAL_I2C_GetState(&hi2c1) != HAL_I2C_STATE_READY)
            {
                // I2C总线异常，尝试恢复
                HAL_I2C_DeInit(&hi2c1);
                HAL_Delay(10);
                MX_I2C1_Init();
            }
            
            // 读取温湿度（原始数据）
            // 先保存上次的值，以便I2C通信失败时使用
            float lastTempBeforeRead = filteredTemperature;
            float lastHumiBeforeRead = filteredHumidity;
            
            AHT20_Measure();
            float rawTemperature = AHT20_Temperature();
            float rawHumidity = AHT20_Humidity();
            
            // 检查读取到的数据是否合理（快速预检查）
            // 如果数据明显异常（如全0、全1或超出物理范围），可能是I2C通信失败
            uint8_t dataInvalid = 0;
            if (rawTemperature < -50.0f || rawTemperature > 100.0f || 
                rawHumidity < 0.0f || rawHumidity > 100.0f ||
                (rawTemperature == 0.0f && rawHumidity == 0.0f))
            {
                dataInvalid = 1;
            }
            
            // 检查温度变化是否过大（如果温度突然变化超过30度，可能是错误数据）
            if (!dataInvalid && lastTempBeforeRead != 0.0f)
            {
                float tempChange = fabsf(rawTemperature - lastTempBeforeRead);
                if (tempChange > 30.0f) // 温度变化超过30度，可能是错误数据
                {
                    dataInvalid = 1;
                }
            }
            
            if (dataInvalid)
            {
                // 数据异常，可能是I2C通信失败，使用上次的有效值
                rawTemperature = lastTempBeforeRead;
                rawHumidity = lastHumiBeforeRead;
            }

            // 数据过滤（范围检查 + 非对称变化率限制 + 超时重置 + 中值滤波）
            AHT20_FilterData(rawTemperature, rawHumidity,
                             &filteredTemperature, &filteredHumidity,
                             &tempFilter, &humiFilter, t_now);

            // 使用过滤后的数据
            temperature = filteredTemperature;
            humidity = filteredHumidity;

            // 只有在OLED未断电时才刷新显示
            if (!oledPowerCut)
            {
                // 如果是状态栏页面，使用状态栏页面显示函数
                if (currentPage == 3)
                {
                    StatusPage_UpdateDisplay();
                }
                else
                {
                    OLED_NewFrame();

            if (currentPage == 0)
            {
                // ====== 第一页：温湿度 + 亮度 ======
                OLED_DrawImage(3, 3, &hotImg, OLED_COLOR_NORMAL);
                snprintf(message, sizeof(message), "温度:%.2f℃", temperature);
                OLED_PrintString(22, 5, message, &font16x16, OLED_COLOR_NORMAL);

                OLED_DrawImage(3, 22, &airImg, OLED_COLOR_NORMAL);
                snprintf(message, sizeof(message), "湿度:%.2f%%", humidity);
                OLED_PrintString(22, 25, message, &font16x16, OLED_COLOR_NORMAL);

                // 若有新光照数据则显示（第三行）
                if (bh_new)
                {
                    char luxStr[32];
                    snprintf(luxStr, sizeof(luxStr), "亮度:%.1fLx", bh_lux);
                    OLED_PrintString(22, 45, luxStr, &font16x16, OLED_COLOR_NORMAL);
                    OLED_DrawImage(5, 45, &lightImg, OLED_COLOR_NORMAL);
                    bh_new = 0; // 消费掉新数据标志
                }
                else
                {
                    // 没新数据就用上次值
                    char luxStr[32];
                    snprintf(luxStr, sizeof(luxStr), "亮度:%.1fLx", bh_lux);
                    OLED_PrintString(22, 45, luxStr, &font16x16, OLED_COLOR_NORMAL);
                    OLED_DrawImage(5, 45, &lightImg, OLED_COLOR_NORMAL);
                }
            }
            else if (currentPage == 1)
            {
                // ====== 第二页：BMP180（气压+温度+海拔）======
                // 第一行：显示气压值（转换为hPa，气象学标准单位）
                OLED_DrawImage(3, 8, &qiyaImg, OLED_COLOR_NORMAL);
                snprintf(message, sizeof(message), "气压:%.1fhPa", (bmp180_pressure / 100.0f));
                OLED_PrintString(18, 5, message, &font16x16, OLED_COLOR_NORMAL);

                // 第二行：显示温度
                OLED_DrawImage(0, 22, &hotImg, OLED_COLOR_NORMAL);
                snprintf(message, sizeof(message), "温度:%.2f℃", bmp180_temp);
                OLED_PrintString(18, 25, message, &font16x16, OLED_COLOR_NORMAL);

                // 第三行：显示海拔高度
                OLED_DrawImage(4, 48, &haibaImg, OLED_COLOR_NORMAL);
                snprintf(message, sizeof(message), "海拔:%.1fm", bmp180_altitude);
                OLED_PrintString(18, 45, message, &font16x16, OLED_COLOR_NORMAL);
            }
            else
            {
                // ====== 第三页：雾度（MQ2）======
                // 第一行：标题
                OLED_DrawImage(0, 0, &smokeImg, OLED_COLOR_NORMAL);
                OLED_PrintString(30, 5, "雾度传感器", &font16x16, OLED_COLOR_NORMAL);

                // 第二行：显示Rs/Ro比值
                if (mq2Result.Rs_Ro > 0)
                {
                    snprintf(message, sizeof(message), "Rs/Ro: %.2f", mq2Result.Rs_Ro);
                    OLED_PrintString(15, 25, message, &font16x16, OLED_COLOR_NORMAL);
                }
                else
                {
                    OLED_PrintString(15, 25, "Rs/Ro: --", &font16x16, OLED_COLOR_NORMAL);
                }

                // 第三行：显示PPM值
                if (mq2Params.calibrated && mq2Result.ppm >= 0)
                {
                    snprintf(message, sizeof(message), "PPM: %.1f", mq2Result.ppm);
                    OLED_PrintString(20, 45, message, &font16x16, OLED_COLOR_NORMAL);
                }
                else
                {
                    OLED_PrintString(20, 45, "PPM: --", &font16x16, OLED_COLOR_NORMAL);
                }
            }

                    OLED_ShowFrame();
                }
            }

            // ====== 异常检测与警告发送 ======
            // 检查所有传感器数据，如果异常持续3秒则发送警告
            Alert_CheckAndSend(temperature, humidity, bh_lux,
                               mq2Result.ppm, bmp180_pressure,
                               mq2Params.calibrated, t_now);

            t_aht20 = t_now;
            t_oled = t_now; // 若后续拆分绘制，也可以有单独周期
        }

        // ====== 4) USART3蓝牙发送：定时发送（普通阻塞模式）======
        if ((uint32_t)(t_now - t_bt) >= PERIOD_BT_MS)
        {
            // 格式化数据（同时发送MQ2的Rs/Ro比值和PPM值，气压使用hPa单位）
            int len = snprintf(message, sizeof(message),
                               "T=%.2fH=%.2fL=%.1fR=%.2fY=%.1fW=%.2fP=%.2f\r\n",
                               temperature, humidity, bh_lux,
                               mq2Result.Rs_Ro, mq2Result.ppm,
                               bmp180_temp, bmp180_pressure / 100.0f);

#if ENABLE_USART3_TX
            // 如果蓝牙已关闭，不发送到USART3
            // 如果蓝牙未关闭，检测BLE_STATE引脚状态，只有当BLE_STATE为高电平时才发送到USART3（蓝牙）
            if (!blePowerCut)
            {
                GPIO_PinState bleState = HAL_GPIO_ReadPin(BLE_STATE_GPIO_Port, BLE_STATE_Pin);
                if (bleState == GPIO_PIN_SET && len > 0)
                {
                    // BLE_STATE为高电平，允许USART3发送(蓝牙)
                    HAL_UART_Transmit(&huart3, (uint8_t*)message, (uint16_t)len, 100);
                }
            }
#endif

            t_bt = t_now;
        }

        // ====== 5) USART2发送：独立周期发送到Air780e（普通阻塞模式）======
        if ((uint32_t)(t_now - t_uart2) >= PERIOD_UART2_MS)
        {
            // 格式化数据（同时发送MQ2的Rs/Ro比值和PPM值，气压使用hPa单位）
            int len = snprintf(message, sizeof(message),
                               "T=%.2fH=%.2fL=%.1fR=%.2fY=%.1fW=%.2fP=%.2f\r\n",
                               temperature, humidity, bh_lux,
                               mq2Result.Rs_Ro, mq2Result.ppm,
                               bmp180_temp, bmp180_pressure / 100.0f);

#if ENABLE_USART2_TX
            // 如果蓝牙已关闭，直接允许USART2发送
            // 如果蓝牙未关闭，检测BLE_STATE引脚状态，只有当BLE_STATE为低电平时才发送到USART2
            if (blePowerCut)
            {
                // 蓝牙已关闭，直接发送到USART2(Air780e)
                if (len > 0)
                {
                    HAL_UART_Transmit(&huart2, (uint8_t*)message, (uint16_t)len, 100);
                }
            }
            else
            {
                // 蓝牙未关闭，检查BLE_STATE引脚状态
                GPIO_PinState bleState = HAL_GPIO_ReadPin(BLE_STATE_GPIO_Port, BLE_STATE_Pin);
                if (bleState == GPIO_PIN_RESET && len > 0)
                {
                    // BLE_STATE为低电平，允许USART2发送(Air780e)
                    HAL_UART_Transmit(&huart2, (uint8_t*)message, (uint16_t)len, 100);
                }
            }
#endif

            t_uart2 = t_now;
        }


        /*旧代码
        // 读取温湿度
        AHT20_Measure();
        temperature = AHT20_Temperature();
        humidity = AHT20_Humidity();

        OLED_NewFrame();

        OLED_DrawImage(3, 10, &hotImg, OLED_COLOR_NORMAL);
        sprintf(message, "温度: %.2f℃", temperature);
        OLED_PrintString(25, 15, message, &font16x16, OLED_COLOR_NORMAL);

        OLED_DrawImage(3, 32, &airImg, OLED_COLOR_NORMAL);
        sprintf(message, "湿度: %.2f%%", humidity);
        OLED_PrintString(25, 35, message, &font16x16, OLED_COLOR_NORMAL);

        OLED_ShowFrame();

        // 如果温湿度发生变化，发送数据
        if (temperature != lastTemperature || humidity != lastHumidity) {
            // 发送到蓝牙串口
            int len = snprintf(message, sizeof(message), "T=%.2fC,H=%.2f%%\r\n", temperature, humidity);
            if (len > 0) {
                // 若当前USART3空闲则用DMA发送，若忙则跳过，等下个周期
                if (HAL_UART_GetState(&huart3) == HAL_UART_STATE_READY) {
                    HAL_UART_Transmit_DMA(&huart3, (uint8_t *)message, (uint16_t)len);
                }
            }

            // 更新最后的温湿度值
            lastTemperature = temperature;
            lastHumidity = humidity;
        }


        HAL_Delay(500);
        */

        /* USER CODE END WHILE */

        /* USER CODE BEGIN 3 */
    }
    /* USER CODE END 3 */
}

/**
  * @brief System Clock Configuration
  * @retval None
  */
void SystemClock_Config(void)
{
    RCC_OscInitTypeDef RCC_OscInitStruct = {0};
    RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};
    RCC_PeriphCLKInitTypeDef PeriphClkInit = {0};

    /** Initializes the RCC Oscillators according to the specified parameters
    * in the RCC_OscInitTypeDef structure.
    */
    RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSE;
    RCC_OscInitStruct.HSEState = RCC_HSE_ON;
    RCC_OscInitStruct.HSEPredivValue = RCC_HSE_PREDIV_DIV1;
    RCC_OscInitStruct.HSIState = RCC_HSI_ON;
    RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;
    RCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_HSE;
    RCC_OscInitStruct.PLL.PLLMUL = RCC_PLL_MUL2;
    if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK)
    {
        Error_Handler();
    }

    /** Initializes the CPU, AHB and APB buses clocks
    */
    RCC_ClkInitStruct.ClockType = RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_SYSCLK
        | RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2;
    RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
    RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
    RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV2;
    RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV1;

    if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_0) != HAL_OK)
    {
        Error_Handler();
    }
    PeriphClkInit.PeriphClockSelection = RCC_PERIPHCLK_ADC;
    PeriphClkInit.AdcClockSelection = RCC_ADCPCLK2_DIV2;
    if (HAL_RCCEx_PeriphCLKConfig(&PeriphClkInit) != HAL_OK)
    {
        Error_Handler();
    }
}

/* USER CODE BEGIN 4 */

/**
 * @brief  双串口发送函数
 * @param  data: 要发送的数据指针
 * @param  len: 数据长度
 * @param  timeout: 超时时间(ms)
 * @retval None
 * @note   根据宏定义ENABLE_USART2_TX和ENABLE_USART3_TX控制发送
 */
void Dual_UART_Transmit(uint8_t* data, uint16_t len, uint32_t timeout)
{
#if ENABLE_USART3_TX
    // USART3发送(蓝牙)
    HAL_UART_Transmit(&huart3, data, len, timeout);
#endif

#if ENABLE_USART2_TX
    // USART2发送(Air780e)
    HAL_UART_Transmit(&huart2, data, len, timeout);
#endif
}

/* USER CODE END 4 */

/**
  * @brief  This function is executed in case of error occurrence.
  * @retval None
  */
void Error_Handler(void)
{
    /* USER CODE BEGIN Error_Handler_Debug */
    /* User can add his own implementation to report the HAL error return state */
    __disable_irq();
    while (1)
    {
    }
    /* USER CODE END Error_Handler_Debug */
}
#ifdef USE_FULL_ASSERT
/**
  * @brief  Reports the name of the source file and the source line number
  *         where the assert_param error has occurred.
  * @param  file: pointer to the source file name
  * @param  line: assert_param error line source number
  * @retval None
  */
void assert_failed(uint8_t* file, uint32_t line)
{
    /* USER CODE BEGIN 6 */
    /* User can add his own implementation to report the file name and line number,
       ex: printf("Wrong parameters value: file %s on line %d\r\n") */
    /* USER CODE END 6 */
}
#endif /* USE_FULL_ASSERT */
