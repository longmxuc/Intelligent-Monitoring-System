#ifndef __MQ2_H__
#define __MQ2_H__

#include "stm32f1xx_hal.h"
#include <math.h>

#ifdef __cplusplus
extern "C" {
#endif

    typedef struct {
        float vref;      // STM32 ADC 参考电压，通常 3.3
        float vcc_mq;    // MQ2 供电电压，通常 5.0
        float k_div;     // 分压系数 Vadc = Vout * k_div（例：12k/22k -> 0.647）
        float r_load;    // 模块负载电阻 RL（常见 5k）
        float Ro;        // 标定电阻（洁净空气），上电可从Flash读取
        uint8_t calibrated; // 已标定标志
        // 拟合系数（不同气体不同；默认给“烟雾”的经验值，需现场修正）
        float fit_a;     // log10(ppm) = a * log10(Rs/Ro) + b
        float fit_b;
    } MQ2_Params;

    typedef struct {
        float v_adc;     // 分压后的 ADC 电压 (V)
        float v_out;     // 还原到模块 AOUT 电压 (V)
        float Rs;        // 传感器电阻 (ohm)
        float Rs_Ro;     // 比值
        float ppm;       // 估算 ppm（若未校准或非法返回 <0）
    } MQ2_Result;

    static inline void MQ2_Default(MQ2_Params *p)
    {
        p->vref = 3.3f;
        p->vcc_mq = 5.0f;
        p->k_div = 0.647f;     // 12k/22k
        p->r_load = 5000.0f;   // 5k
        p->Ro = 10000.0f;      // 先占位，上电后建议从Flash读取
        p->calibrated = 0;
        p->fit_a = -1.431f;    // 示例：烟雾
        p->fit_b =  0.540f;
    }

    // 用“单次 ADC 原始值”计算一次结果
    void MQ2_FromAdcRaw(const MQ2_Params *p, uint16_t adc_raw, MQ2_Result *out);

    // 用“多样本求和+个数”的均值计算一次结果（适合 DMA 环形平均）
    void MQ2_FromAdcSum(const MQ2_Params *p, uint32_t sum_raw, uint16_t cnt, MQ2_Result *out);

    // 在洁净空气中标定：输入多次原始值求平均，clean_air_factor 典型 9.8
    // 返回计算出的 Ro，并把 p->Ro 更新且置 calibrated=1
    float MQ2_Calibrate(MQ2_Params *p, uint32_t sum_raw, uint16_t cnt, float clean_air_factor);

#ifdef __cplusplus
}
#endif
#endif /* __MQ2_H__ */
