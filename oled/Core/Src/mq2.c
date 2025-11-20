#include "mq2.h"

static float _adc_to_vadc(const MQ2_Params *p, uint16_t raw)
{
    return p->vref * ((float)raw / 4095.0f);
}

static float _vadc_to_vout(const MQ2_Params *p, float v_adc)
{
    return v_adc / ((p->k_div > 0.0001f) ? p->k_div : 1.0f);
}

static float _vout_to_Rs(const MQ2_Params *p, float v_out)
{
    if (v_out < 0.01f) v_out = 0.01f; // 防0
    return p->r_load * (p->vcc_mq - v_out) / v_out;
}

static float _rsro_to_ppm(const MQ2_Params *p, float rs_ro)
{
    if (!p->calibrated || rs_ro <= 0.0f) return -1.0f;
    float logppm = p->fit_a * log10f(rs_ro) + p->fit_b;
    return powf(10.0f, logppm);
}

void MQ2_FromAdcRaw(const MQ2_Params *p, uint16_t adc_raw, MQ2_Result *out)
{
    out->v_adc = _adc_to_vadc(p, adc_raw);
    out->v_out = _vadc_to_vout(p, out->v_adc);
    out->Rs    = _vout_to_Rs(p, out->v_out);
    out->Rs_Ro = (p->Ro > 1.0f) ? (out->Rs / p->Ro) : -1.0f;
    out->ppm   = _rsro_to_ppm(p, out->Rs_Ro);
}

void MQ2_FromAdcSum(const MQ2_Params *p, uint32_t sum_raw, uint16_t cnt, MQ2_Result *out)
{
    if (cnt == 0) cnt = 1;
    float avg = (float)sum_raw / (float)cnt;
    uint16_t raw = (avg <= 0.0f) ? 0u : (uint16_t)(avg + 0.5f);
    MQ2_FromAdcRaw(p, raw, out);
}

float MQ2_Calibrate(MQ2_Params *p, uint32_t sum_raw, uint16_t cnt, float clean_air_factor)
{
    if (cnt == 0) cnt = 1;
    float avg = (float)sum_raw / (float)cnt;
    float v_adc = _adc_to_vadc(p, (uint16_t)(avg + 0.5f));
    float v_out = _vadc_to_vout(p, v_adc);
    float Rs    = _vout_to_Rs(p, v_out);
    if (clean_air_factor < 1.0f) clean_air_factor = 9.8f;
    p->Ro = Rs / clean_air_factor;
    p->calibrated = 1;
    return p->Ro;
}
