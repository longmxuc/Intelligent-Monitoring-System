#ifndef __BMP180_H__
#define __BMP180_H__

#include <math.h>

#include "stm32f1xx_hal.h"
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

    // 7-bit address = 0x77, HAL 使用 8-bit 时移位后的地址在内部处理，无需手动<<1
#define BMP180_I2C_ADDR         (0x77)
#define BMP180_CHIP_ID_REG      0xD0
#define BMP180_CHIP_ID_VAL      0x55

    // 校准寄存器首地址
#define BMP180_CALIB_START      0xAA
#define BMP180_CALIB_LEN        22

    // 控制与数据寄存器
#define BMP180_REG_CONTROL      0xF4
#define BMP180_REG_OUT_MSB      0xF6
#define BMP180_REG_OUT_LSB      0xF7
#define BMP180_REG_OUT_XLSB     0xF8

    // 指令
#define BMP180_CMD_TEMP         0x2E
    // 压力测量不同过采样设置
    typedef enum {
        BMP180_OSS_0 = 0, // Ultra low power
        BMP180_OSS_1 = 1, // Standard
        BMP180_OSS_2 = 2, // High
        BMP180_OSS_3 = 3  // Ultra high
    } bmp180_oss_t;

    typedef struct {
        // 校准参数（有符号/无符号按手册）
        int16_t  AC1;
        int16_t  AC2;
        int16_t  AC3;
        uint16_t AC4;
        uint16_t AC5;
        uint16_t AC6;
        int16_t  B1;
        int16_t  B2;
        int16_t  MB;
        int16_t  MC;
        int16_t  MD;

        I2C_HandleTypeDef *hi2c;
        bmp180_oss_t oss;
    } BMP180_HandleTypeDef;

    // 初始化：读取校准参数与芯片ID
    HAL_StatusTypeDef BMP180_Init(BMP180_HandleTypeDef *dev, I2C_HandleTypeDef *hi2c, bmp180_oss_t oss);

    // 读取温度（0.1℃）与压力（Pa）
    HAL_StatusTypeDef BMP180_ReadTempPressure(BMP180_HandleTypeDef *dev, int32_t *temp_x10, int32_t *press_pa);

    // 简单海拔计算（以 101325Pa 为海平面参考）
    static inline float BMP180_PressureToAltitude(float pressure_pa, float p0_pa) {
        return 44330.0f * (1.0f - powf(pressure_pa / p0_pa, 0.190294957f));
    }

#ifdef __cplusplus
}
#endif

#endif // __BMP180_H__
