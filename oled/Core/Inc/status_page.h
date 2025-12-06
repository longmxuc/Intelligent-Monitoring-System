/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file    status_page.h
  * @brief   状态栏页面功能模块
  ******************************************************************************
  * @attention
  *
  * Copyright (c) 2025 STMicroelectronics.
  * All rights reserved.
  *
  ******************************************************************************
  */
/* USER CODE END Header */

#ifndef __STATUS_PAGE_H__
#define __STATUS_PAGE_H__

#ifdef __cplusplus
extern "C" {
#endif

/* Includes ------------------------------------------------------------------*/
#include "main.h"
#include "oled.h"
#include "usart.h"

/* Exported types ------------------------------------------------------------*/
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

/* Exported constants --------------------------------------------------------*/

/* Exported macro ------------------------------------------------------------*/

/* Exported functions prototypes ---------------------------------------------*/
/**
 * @brief 初始化状态栏页面模块
 */
void StatusPage_Init(void);

/**
 * @brief 进入状态栏页面（发送onmessage命令）
 */
void StatusPage_Enter(void);

/**
 * @brief 退出状态栏页面（发送offmessage命令）
 */
void StatusPage_Exit(void);

/**
 * @brief 更新状态栏页面显示
 * @note 需要在主循环中定期调用
 */
void StatusPage_UpdateDisplay(void);

/**
 * @brief 解析状态消息数据
 * @param data 接收到的数据字符串（格式: "ms:t_17:15:15,p_1"）
 * @return 1=解析成功, 0=解析失败
 */
uint8_t StatusPage_ParseMessage(const char* data, uint16_t len, uint16_t* consumedLen);

/**
 * @brief 获取当前状态栏页面状态
 * @return StatusPageState_t 当前状态
 */
StatusPageState_t StatusPage_GetState(void);

/**
 * @brief 检查是否在状态栏页面
 * @return 1=在状态栏页面, 0=不在
 */
uint8_t StatusPage_IsActive(void);

#ifdef __cplusplus
}
#endif

#endif /* __STATUS_PAGE_H__ */

