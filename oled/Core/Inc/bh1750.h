#ifndef __BH1750_H__
#define __BH1750_H__

#include "stm32f1xx_hal.h"  // 根据芯片系列替换

#ifdef __cplusplus
extern "C" {
#endif

    // 7-bit 地址（HAL 传参需 <<1）
#define BH1750_ADDR_LOW   (0x23)   // ADDR=GND
#define BH1750_ADDR_HIGH  (0x5C)   // ADDR=VCC

    // 命令集（参考数据手册）
#define BH1750_POWER_DOWN        0x00
#define BH1750_POWER_ON          0x01
#define BH1750_RESET             0x07

    // 连续测量模式
#define BH1750_CONT_HRES_MODE        0x10  // 1 lx 分辨率，典型 120ms
#define BH1750_CONT_HRES_MODE2       0x11  // 0.5 lx 分辨率，典型 120ms
#define BH1750_CONT_LRES_MODE        0x13  // 4 lx 分辨率，典型 16ms

    // 一次性测量模式（触发一次自动掉电）
#define BH1750_ONESHOT_HRES_MODE     0x20
#define BH1750_ONESHOT_HRES_MODE2    0x21
#define BH1750_ONESHOT_LRES_MODE     0x23

    typedef enum {
        BH1750_OK = 0,
        BH1750_ERR
    } BH1750_Status;

    typedef struct {
        I2C_HandleTypeDef *hi2c;
        uint8_t devAddr7;     // 7-bit 地址（0x23 或 0x5C）
        uint8_t mode;         // 当前测量模式
    } BH1750_Handle;

    BH1750_Status BH1750_Init(BH1750_Handle *dev, I2C_HandleTypeDef *hi2c, uint8_t devAddr7);
    BH1750_Status BH1750_PowerOn(BH1750_Handle *dev);
    BH1750_Status BH1750_PowerDown(BH1750_Handle *dev);
    BH1750_Status BH1750_Reset(BH1750_Handle *dev);
    BH1750_Status BH1750_SetMode(BH1750_Handle *dev, uint8_t mode);

    /**
     * 读取照度（lux）
     * - 连续模式：直接读
     * - 一次性模式：内部会先发测量命令并等待转换时间
     */
    BH1750_Status BH1750_ReadLux(BH1750_Handle *dev, float *lux);

#ifdef __cplusplus
}
#endif

#endif /* __BH1750_H__ */
