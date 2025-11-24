/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file           : main.h
  * @brief          : Header for main.c file.
  *                   This file contains the common defines of the application.
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

/* Define to prevent recursive inclusion -------------------------------------*/
#ifndef __MAIN_H
#define __MAIN_H

#ifdef __cplusplus
extern "C" {
#endif

/* Includes ------------------------------------------------------------------*/
#include "stm32f1xx_hal.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */
extern DMA_HandleTypeDef hdma_usart3_rx;
/* USER CODE END Includes */

/* Exported types ------------------------------------------------------------*/
/* USER CODE BEGIN ET */

/* USER CODE END ET */

/* Exported constants --------------------------------------------------------*/
/* USER CODE BEGIN EC */

/* USER CODE END EC */

/* Exported macro ------------------------------------------------------------*/
/* USER CODE BEGIN EM */

/* USER CODE END EM */

/* Exported functions prototypes ---------------------------------------------*/
void Error_Handler(void);

/* USER CODE BEGIN EFP */

/* USER CODE END EFP */

/* Private defines -----------------------------------------------------------*/
#define BH1750_POWER_Pin GPIO_PIN_5
#define BH1750_POWER_GPIO_Port GPIOA
#define BPM180_POWER_Pin GPIO_PIN_6
#define BPM180_POWER_GPIO_Port GPIOA
#define BLE_POWER_Pin GPIO_PIN_7
#define BLE_POWER_GPIO_Port GPIOA
#define OLED_POWER_Pin GPIO_PIN_0
#define OLED_POWER_GPIO_Port GPIOB
#define MQ2_POWER_Pin GPIO_PIN_1
#define MQ2_POWER_GPIO_Port GPIOB
#define SWITCH_KEY_Pin GPIO_PIN_12
#define SWITCH_KEY_GPIO_Port GPIOB
#define OLED_KEY_Pin GPIO_PIN_13
#define OLED_KEY_GPIO_Port GPIOB
#define STATE_KEY_Pin GPIO_PIN_14
#define STATE_KEY_GPIO_Port GPIOB
#define BLE_STATE_Pin GPIO_PIN_8
#define BLE_STATE_GPIO_Port GPIOA

/* USER CODE BEGIN Private defines */

/* USER CODE END Private defines */

#ifdef __cplusplus
}
#endif

#endif /* __MAIN_H */
