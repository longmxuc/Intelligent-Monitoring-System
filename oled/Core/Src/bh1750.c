#include "bh1750.h"

static HAL_StatusTypeDef BH1750_WriteCmd(BH1750_Handle *dev, uint8_t cmd)
{
    return HAL_I2C_Master_Transmit(dev->hi2c, dev->devAddr7 << 1, &cmd, 1, 100);
}

static HAL_StatusTypeDef BH1750_ReadRaw(BH1750_Handle *dev, uint16_t *raw)
{
    uint8_t buf[2] = {0};
    HAL_StatusTypeDef ret = HAL_I2C_Master_Receive(dev->hi2c, dev->devAddr7 << 1, buf, 2, 100);
    if (ret == HAL_OK) {
        *raw = ((uint16_t)buf[0] << 8) | buf[1];
    }
    return ret;
}

BH1750_Status BH1750_Init(BH1750_Handle *dev, I2C_HandleTypeDef *hi2c, uint8_t devAddr7)
{
    dev->hi2c = hi2c;
    dev->devAddr7 = devAddr7;
    dev->mode = BH1750_CONT_HRES_MODE;

    if (BH1750_PowerOn(dev) != BH1750_OK) return BH1750_ERR;
    HAL_Delay(10);
    if (BH1750_Reset(dev) != BH1750_OK) return BH1750_ERR;
    HAL_Delay(10);
    if (BH1750_SetMode(dev, dev->mode) != BH1750_OK) return BH1750_ERR;
    return BH1750_OK;
}

BH1750_Status BH1750_PowerOn(BH1750_Handle *dev)
{
    return (BH1750_WriteCmd(dev, BH1750_POWER_ON) == HAL_OK) ? BH1750_OK : BH1750_ERR;
}

BH1750_Status BH1750_PowerDown(BH1750_Handle *dev)
{
    return (BH1750_WriteCmd(dev, BH1750_POWER_DOWN) == HAL_OK) ? BH1750_OK : BH1750_ERR;
}

BH1750_Status BH1750_Reset(BH1750_Handle *dev)
{
    // Reset 只在上电状态有效
    if (BH1750_WriteCmd(dev, BH1750_RESET) != HAL_OK) return BH1750_ERR;
    return BH1750_OK;
}

BH1750_Status BH1750_SetMode(BH1750_Handle *dev, uint8_t mode)
{
    if (BH1750_WriteCmd(dev, mode) != HAL_OK) return BH1750_ERR;
    dev->mode = mode;

    // 不同模式的典型转换时间（保守一些）
    switch (mode) {
        case BH1750_CONT_HRES_MODE:
        case BH1750_CONT_HRES_MODE2:
        case BH1750_ONESHOT_HRES_MODE:
        case BH1750_ONESHOT_HRES_MODE2:
            HAL_Delay(180); // 典型 120ms，留冗余
            break;
        case BH1750_CONT_LRES_MODE:
        case BH1750_ONESHOT_LRES_MODE:
            HAL_Delay(30);  // 典型 16ms
            break;
        default:
            HAL_Delay(180);
            break;
    }
    return BH1750_OK;
}

BH1750_Status BH1750_ReadLux(BH1750_Handle *dev, float *lux)
{
    HAL_StatusTypeDef ret;
    uint16_t raw = 0;

    // 若是一枪模式，需要先下发当前模式再等待转换
    if (dev->mode == BH1750_ONESHOT_HRES_MODE ||
        dev->mode == BH1750_ONESHOT_HRES_MODE2 ||
        dev->mode == BH1750_ONESHOT_LRES_MODE) {

        if (BH1750_WriteCmd(dev, dev->mode) != HAL_OK) return BH1750_ERR;

        switch (dev->mode) {
            case BH1750_ONESHOT_LRES_MODE:  HAL_Delay(30);  break; // 16ms 典型
            default:                        HAL_Delay(180); break; // 120ms 典型
        }
    }

    ret = BH1750_ReadRaw(dev, &raw);
    if (ret != HAL_OK) return BH1750_ERR;

    // 数据手册换算：HighRes系数 1.2（精度更高可做温度/电压补偿）
    // HighRes2 分辨率更细，公式同样是 raw/1.2
    *lux = (float)raw / 1.2f;

    return BH1750_OK;
}
