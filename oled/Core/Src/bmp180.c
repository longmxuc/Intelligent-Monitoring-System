#include "bmp180.h"
#include <string.h>
#include <math.h>

// 内部：I2C 读写辅助
static HAL_StatusTypeDef bmp180_write8(BMP180_HandleTypeDef *dev, uint8_t reg, uint8_t val) {
    return HAL_I2C_Mem_Write(dev->hi2c, (BMP180_I2C_ADDR << 1), reg, I2C_MEMADD_SIZE_8BIT, &val, 1, 100);
}
static HAL_StatusTypeDef bmp180_read8(BMP180_HandleTypeDef *dev, uint8_t reg, uint8_t *val) {
    return HAL_I2C_Mem_Read(dev->hi2c, (BMP180_I2C_ADDR << 1), reg, I2C_MEMADD_SIZE_8BIT, val, 1, 100);
}
static HAL_StatusTypeDef bmp180_read_buf(BMP180_HandleTypeDef *dev, uint8_t reg, uint8_t *buf, uint16_t len) {
    return HAL_I2C_Mem_Read(dev->hi2c, (BMP180_I2C_ADDR << 1), reg, I2C_MEMADD_SIZE_8BIT, buf, len, 200);
}

// 大端转 16 位
static int16_t be_to_s16(uint8_t msb, uint8_t lsb) {
    return (int16_t)((msb << 8) | lsb);
}
static uint16_t be_to_u16(uint8_t msb, uint8_t lsb) {
    return (uint16_t)((msb << 8) | lsb);
}

HAL_StatusTypeDef BMP180_Init(BMP180_HandleTypeDef *dev, I2C_HandleTypeDef *hi2c, bmp180_oss_t oss) {
    dev->hi2c = hi2c;
    dev->oss  = oss;

    uint8_t id = 0;
    if (bmp180_read8(dev, BMP180_CHIP_ID_REG, &id) != HAL_OK) return HAL_ERROR;
    if (id != BMP180_CHIP_ID_VAL) return HAL_ERROR;

    uint8_t calib[BMP180_CALIB_LEN];
    if (bmp180_read_buf(dev, BMP180_CALIB_START, calib, BMP180_CALIB_LEN) != HAL_OK) return HAL_ERROR;

    dev->AC1 = be_to_s16(calib[0],  calib[1]);
    dev->AC2 = be_to_s16(calib[2],  calib[3]);
    dev->AC3 = be_to_s16(calib[4],  calib[5]);
    dev->AC4 = be_to_u16(calib[6],  calib[7]);
    dev->AC5 = be_to_u16(calib[8],  calib[9]);
    dev->AC6 = be_to_u16(calib[10], calib[11]);
    dev->B1  = be_to_s16(calib[12], calib[13]);
    dev->B2  = be_to_s16(calib[14], calib[15]);
    dev->MB  = be_to_s16(calib[16], calib[17]);
    dev->MC  = be_to_s16(calib[18], calib[19]);
    dev->MD  = be_to_s16(calib[20], calib[21]);

    return HAL_OK;
}

// 触发温度测量并读取 UT
static HAL_StatusTypeDef bmp180_read_UT(BMP180_HandleTypeDef *dev, int32_t *UT) {
    if (bmp180_write8(dev, BMP180_REG_CONTROL, BMP180_CMD_TEMP) != HAL_OK) return HAL_ERROR;
    HAL_Delay(5); // 数据手册：4.5ms
    uint8_t buf[2];
    if (bmp180_read_buf(dev, BMP180_REG_OUT_MSB, buf, 2) != HAL_OK) return HAL_ERROR;
    *UT = (int32_t)((buf[0] << 8) | buf[1]);
    return HAL_OK;
}

// 触发压力测量并读取 UP（根据 OSS）
static HAL_StatusTypeDef bmp180_read_UP(BMP180_HandleTypeDef *dev, int32_t *UP) {
    uint8_t cmd = 0x34 + ((uint8_t)dev->oss << 6);
    if (bmp180_write8(dev, BMP180_REG_CONTROL, cmd) != HAL_OK) return HAL_ERROR;

    // 转换时间：OSS0=4.5ms, OSS1=7.5ms, OSS2=13.5ms, OSS3=25.5ms
    static const uint8_t delay_ms[4] = {5, 8, 14, 26};
    HAL_Delay(delay_ms[dev->oss]);

    uint8_t buf[3];
    if (bmp180_read_buf(dev, BMP180_REG_OUT_MSB, buf, 3) != HAL_OK) return HAL_ERROR;
    int32_t raw = ((int32_t)buf[0] << 16) | ((int32_t)buf[1] << 8) | buf[2];
    *UP = raw >> (8 - dev->oss); // 根据 OSS 右移
    return HAL_OK;
}

// 计算真值（按 Bosch 数据手册固定点算法）
HAL_StatusTypeDef BMP180_ReadTempPressure(BMP180_HandleTypeDef *dev, int32_t *temp_x10, int32_t *press_pa) {
    int32_t UT = 0, UP = 0;
    if (bmp180_read_UT(dev, &UT) != HAL_OK) return HAL_ERROR;
    if (bmp180_read_UP(dev, &UP) != HAL_OK) return HAL_ERROR;

    // 温度计算
    int32_t X1 = ((UT - (int32_t)dev->AC6) * (int32_t)dev->AC5) >> 15;
    int32_t X2 = ((int32_t)dev->MC << 11) / (X1 + dev->MD);
    int32_t B5 = X1 + X2;
    int32_t T  = (B5 + 8) >> 4; // 0.1°C
    if (temp_x10) *temp_x10 = T;

    // 压力计算
    int32_t B6 = B5 - 4000;
    X1 = ((int32_t)dev->B2 * ((B6 * B6) >> 12)) >> 11;
    X2 = ((int32_t)dev->AC2 * B6) >> 11;
    int32_t X3 = X1 + X2;
    int32_t B3 = ((((int32_t)dev->AC1 * 4 + X3) << dev->oss) + 2) >> 2;

    X1 = ((int32_t)dev->AC3 * B6) >> 13;
    X2 = ((int32_t)dev->B1 * ((B6 * B6) >> 12)) >> 16;
    X3 = ((X1 + X2) + 2) >> 2;
    uint32_t B4 = ((uint32_t)dev->AC4 * (uint32_t)(X3 + 32768)) >> 15;
    uint32_t B7 = ((uint32_t)UP - (uint32_t)B3) * (uint32_t)(50000 >> dev->oss);

    int32_t p;
    if (B7 < 0x80000000U) {
        p = (int32_t)((B7 << 1) / B4);
    } else {
        p = (int32_t)((B7 / B4) << 1);
    }
    X1 = (p >> 8) * (p >> 8);
    X1 = (X1 * 3038) >> 16;
    X2 = (-7357 * p) >> 16;
    p = p + ((X1 + X2 + 3791) >> 4);

    if (press_pa) *press_pa = p; // Pa
    return HAL_OK;
}
