# server.py
import asyncio
import json
import platform
import re
import time
import ssl
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Set, Optional, Dict
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
from starlette.responses import FileResponse, Response, PlainTextResponse
import uvicorn
from bleak import BleakClient, BleakScanner  # 添加 BleakScanner
import httpx
import paho.mqtt.client as mqtt
from secrets_manager import SECRETS

# 导入数据库管理器
from db_manager import get_db_manager

# 导入MQTT消息发送模块
from mqtt_message_sender import MqttMessageSender

# ============ 基本配置 ============
PROJECT_DIR = Path(__file__).parent
WEB_DIR = PROJECT_DIR / "web"
INDEX_FILE = WEB_DIR / "index.html"  # 实时数据页
DEVICE_INDEX_FILE = WEB_DIR / "devices.html"  # 设备总览页
RESOURCE_DIR = PROJECT_DIR / "resource"
CAFILE_DIR = PROJECT_DIR / "cafile"

# MQTT配置（主要数据源）
MQTT_BROKER = "b734d07e.ala.cn-hangzhou.emqxsl.cn"
MQTT_PORT = 8883  # MQTT over TLS/SSL
# 支持的设备列表
MQTT_DEVICES = ["D01", "D02", "D03", "D04"]  # 支持多个设备（目前除了前面两个，后面的都是占位符）

# 设备名称映射配置（可自定义每个设备的显示名称）
DEVICE_NAMES = {
    "D01": "实验平台",
    "D02": "算力机房",
    "D03": "液冷中心",
    "D04": "访客中心"
}

# 为每个设备生成主题列表
MQTT_TOPICS = [f"stm32/{device}/data_now" for device in MQTT_DEVICES]  # 传感器数据主题列表
MQTT_CMD_TOPICS = [f"stm32/{device}/data_cmd" for device in MQTT_DEVICES]  # 定位命令主题列表
MQTT_TOPIC_MAP = {device.upper(): f"stm32/{device}/data_now" for device in MQTT_DEVICES}
MQTT_CMD_TOPIC_MAP = {device.upper(): f"stm32/{device}/data_cmd" for device in MQTT_DEVICES}
# 保留旧的主题变量以兼容现有代码（使用D01作为默认）
MQTT_TOPIC = MQTT_TOPICS[0]  # 默认使用D01主题（向后兼容）
MQTT_CMD_TOPIC = MQTT_CMD_TOPICS[0]  # 默认使用D01命令主题（向后兼容）
MQTT_USERNAME = SECRETS.get("MQTT_USERNAME", "")
MQTT_PASSWORD = SECRETS.get("MQTT_PASSWORD", "")
MQTT_CA_CERT_FILE = CAFILE_DIR / "emqxsl-ca.crt"  # CA证书文件路径
# MQTT 控制指令（需要从定位解析中排除）
MQTT_CONTROL_COMMANDS = {"ONMQ2", "OFFMQ2"}

# DeepSeek API 配置（在线模型）
DEEPSEEK_API_KEY = SECRETS.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions"
DEEPSEEK_ONLINE_MODELS = ["deepseek-reasoner", "deepseek-chat"]  # 在线模型列表

# 提示用户配置敏感信息的密钥文件，避免将密钥写死在代码中
if not MQTT_USERNAME or not MQTT_PASSWORD:
    print("【警告】未在密钥文件中配置 MQTT_USERNAME/MQTT_PASSWORD，将无法正常连接 MQTT 服务器。")

if not DEEPSEEK_API_KEY:
    print("【警告】未在密钥文件中配置 DEEPSEEK_API_KEY，AI 分析功能将不可用。")

# 蓝牙设备配置（优先数据源）
BLE_DEVICES = {
    "BT27": "48:87:2D:7D:7C:60",  # 仅使用 BT27 设备
}
UART_RXTX_CHAR = "0000FFE1-0000-1000-8000-00805F9B34FB"  # HM-10/BT05
LINE_END = b"\r\n"

# 数据源状态标志
ble_or_mqtt_first = 1  # 0表示蓝牙优先 1表示MQTT优先
ble_connected = False  # 蓝牙连接状态
ble_connection_attempted = False  # 蓝牙是否已尝试连接
mqtt_connected = False  # MQTT连接状态
mqtt_connection_attempted = False  # MQTT是否已尝试连接
# MQTT首次消息标志（用于屏蔽服务器保留的最后一条消息）
mqtt_first_message_received = {}  # 字典，key为主题，value为是否已收到第一条消息
# 当前活跃的BLE客户端（用于写入命令）
ble_client = None

# 设备最后消息时间记录（用于判断设备在线状态）
device_last_message_time = {}  # 字典，key为设备ID，value为最后一次收到消息的时间戳
DEVICE_ONLINE_TIMEOUT = 10  # 设备在线超时时间（秒），超过此时间未收到消息则判定为离线

# 自动恢复机制配置
AUTO_RECOVERY_NORMAL_PACKETS = 3  # 连续收到N个正常数据包后自动标记为安全（默认3个，即30秒）
# 跟踪每个传感器类型的连续正常数据包计数
warning_recovery_counters = {}  # 字典，key为(device_id, warning_type)，value为连续正常数据包计数
warning_recovery_lock = asyncio.Lock()  # 用于保护计数器的锁

# 传感器正常值阈值（与单片机端保持一致）
SENSOR_THRESHOLDS = {
    'T': {'min': 15.0, 'max': 27.0},  # 温度：15-27°C
    'H': {'min': 30.0, 'max': 75.0},  # 湿度：30-75%
    'B': {'min': 5.0, 'max': 2000.0},  # 亮度：5-2000 lux
    'S': {'min': 0.0, 'max': 50.0},  # PPM：0-50 ppm
    'P': {'min': 1000.0, 'max': 1025.0}  # 大气压：1000-1020 hPa（单片机端100000-102000 Pa）
}

# MQ2 模式（简单供电周期）
MQ2_MODE_CONFIG = {
    "eco": {
        "name": "省电模式",
        "icon": "💤",
        "on_duration": 5 * 60,
        "off_duration": 25 * 60
    },
    "balance": {
        "name": "平衡模式",
        "icon": "⚖️",
        "on_duration": 15 * 60,
        "off_duration": 15 * 60
    },
    "safe": {
        "name": "安全模式",
        "icon": "🔥",
        "on_duration": 25 * 60,
        "off_duration": 5 * 60
    },
    "always": {
        "name": "不省电",
        "icon": "⚡",
        "on_duration": None,
        "off_duration": 0,
        "always_on": True
    },
    "dev": {
        "name": "开发者模式",
        "icon": "🧪",
        "on_duration": 30,
        "off_duration": 10
    }
}

DEFAULT_MQ2_MODE = "eco"
DEFAULT_BMP180_MODE = "always"  # BMP180默认不省电
DEFAULT_BH1750_MODE = "always"  # BH1750默认不省电

# MQ2 初始化与调度任务
mq2_bootstrap_task = None
mq2_cycle_tasks: Dict[str, asyncio.Task] = {}
mq2_cycle_wakeups: Dict[str, asyncio.Event] = {}

# BMP180 初始化与调度任务
bmp180_bootstrap_task = None
bmp180_cycle_tasks: Dict[str, asyncio.Task] = {}
bmp180_cycle_wakeups: Dict[str, asyncio.Event] = {}

# BH1750 初始化与调度任务
bh1750_bootstrap_task = None
bh1750_cycle_tasks: Dict[str, asyncio.Task] = {}
bh1750_cycle_wakeups: Dict[str, asyncio.Event] = {}


def get_managed_mq2_devices():
    seen = set()
    devices = []
    for candidate in ["D01"] + MQTT_DEVICES:
        if not candidate:
            continue
        dev = candidate.upper()
        if dev not in seen:
            seen.add(dev)
            devices.append(dev)
    if not devices:
        devices = ["D01"]
    return devices


def ensure_mq2_cycle_started():
    """
    确保MQ2供电调度器仅针对需要的设备各启动一次。
    """
    global mq2_cycle_tasks, mq2_cycle_wakeups
    for device in get_managed_mq2_devices():
        task = mq2_cycle_tasks.get(device)
        if task and not task.done():
            continue
        if device not in mq2_cycle_wakeups:
            mq2_cycle_wakeups[device] = asyncio.Event()
        mq2_cycle_tasks[device] = asyncio.create_task(mq2_cycle_manager(device))


def wake_mq2_cycle(device_id: str):
    device_id = (device_id or "D01").upper()
    event = mq2_cycle_wakeups.get(device_id)
    if event:
        event.set()


def transports_ready() -> bool:
    """判断是否至少有一种通信链路可用"""
    return ble_connected or mqtt_connected


# Windows 推荐的事件循环策略
if platform.system() == "Windows":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

# 全局事件循环引用
main_loop = None


# ============ 平台兼容性函数 ============
async def get_device_address():
    """
    扫描并获取可用的蓝牙设备地址
    支持BT27设备
    """
    try:
        print(f"【BLE】正在扫描设备 BT27...")
        # 快速扫描（3秒足够发现附近设备）
        devices = await BleakScanner.discover(timeout=3.0)

        # 遍历扫描到的设备，查找我们支持的设备
        for device in devices:
            if device.name in BLE_DEVICES:
                print(f"【BLE】✓ 找到设备：{device.name} - {device.address}")
                return device.address, device.name

        # 如果没有通过名称找到，尝试通过MAC地址匹配（适用于某些平台）
        for device in devices:
            device_addr_upper = device.address.upper().replace(":", "").replace("-", "")
            for name, addr in BLE_DEVICES.items():
                config_addr_upper = addr.upper().replace(":", "").replace("-", "")
                if device_addr_upper == config_addr_upper:
                    print(f"【BLE】✓ 通过MAC地址找到设备：{name} - {device.address}")
                    return device.address, name

        # 如果扫描失败，使用默认的第一个设备地址（Windows直连模式）
        default_name = list(BLE_DEVICES.keys())[0]
        default_addr = BLE_DEVICES[default_name]
        print(f"【BLE】未扫描到设备，尝试直连 {default_name} ({default_addr})")
        return default_addr, default_name

    except Exception as e:
        # 出错时使用默认设备
        default_name = list(BLE_DEVICES.keys())[0]
        default_addr = BLE_DEVICES[default_name]
        print(f"【BLE】扫描失败：{e}，尝试直连 {default_name} ({default_addr})")
        return default_addr, default_name


# ============ WebSocket 广播 ============
connections: Set[WebSocket] = set()
broadcast_queue: asyncio.Queue = asyncio.Queue()  # 兼容 Python 3.8

# ============ MQTT消息发送控制 ============
# 创建MQTT消息发送管理器实例（将在lifespan中初始化）
mqtt_message_sender: Optional[MqttMessageSender] = None


async def broadcaster():
    print("【服务】广播任务已启动。")
    while True:
        msg = await broadcast_queue.get()
        待移除 = []
        for ws in list(connections):
            try:
                await ws.send_text(msg)
            except Exception:
                待移除.append(ws)
        for ws in 待移除:
            connections.discard(ws)


# ============ 统计（每 5 秒打印一次） ============
stat_all = 0  # 最近窗口收到的数据总条数
stat_with_lux = 0  # 其中含亮度字段的条数
stat_with_smoke = 0  # 其中含烟雾字段的条数
stat_lock = asyncio.Lock()


async def stats_task():
    """每 5 秒打印一次统计信息，并清零窗口计数。"""
    print("【统计】统计任务已启动（5 秒间隔）。")
    窗口 = 5.0
    while True:
        await asyncio.sleep(窗口)
        async with stat_lock:
            total = stat_all
            with_lux = stat_with_lux
            with_smoke = stat_with_smoke
            # 清零
            globals()["stat_all"] = 0
            globals()["stat_with_lux"] = 0
            globals()["stat_with_smoke"] = 0

        if total == 0:
            print(
                f"【统计】({time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())} 当前连接数：{len(connections)}) 近 5 秒无数据。")
        else:
            rps = total / 窗口
            ratio_lux = (with_lux / total) * 100.0
            ratio_smoke = (with_smoke / total) * 100.0
            print(
                f"【统计】({time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())} 当前连接数：{len(connections)}) 近 5 秒收到 {total} 条，平均 {rps:.2f} 条/秒；亮度字段占比 {ratio_lux:.1f}%（{with_lux}/{total}）；烟雾字段占比 {ratio_smoke:.1f}%（{with_smoke}/{total}）。")


# ============ BLE 解析 ============
# 数据格式：T=24.61H=45.78L=0.0R=1.01Y=3.4W=26.10P=1014.23
# T=温度 H=湿度 L=光照 R=Rs_Ro Y=烟雾PPM W=温度2 P=气压
PATTERN_DATA = re.compile(
    r"T=([+-]?\d+(?:\.\d+)?)H=([+-]?\d+(?:\.\d+)?)L=([+-]?\d+(?:\.\d+)?)R=([+-]?\d+(?:\.\d+)?)Y=([+-]?\d+(?:\.\d+)?)W=([+-]?\d+(?:\.\d+)?)P=([+-]?\d+(?:\.\d+)?)"
)
_buffer = bytearray()


def _check_sensor_value_normal(warning_type: str, value: float) -> bool:
    """
    检查传感器值是否在正常范围内
    
    参数:
        warning_type: 警告类型（T/H/B/S/P）
        value: 传感器值
    
    返回:
        True表示在正常范围内，False表示异常
    """
    if warning_type not in SENSOR_THRESHOLDS:
        return True  # 未知类型，默认认为正常

    threshold = SENSOR_THRESHOLDS[warning_type]
    return threshold['min'] <= value <= threshold['max']


def _enqueue_reading(t: float, h: float, lux, smoke=None, rs_ro=None, temp2=None, pressure=None, source=None,
                     device_id=None):
    """入队广播，并更新统计计数。"""
    ts = time.time()
    lux_value_display = None if lux is None else round(lux, 1)
    smoke_value = None if smoke is None else round(smoke, 1)
    pressure_value_display = None if pressure is None else round(pressure, 1)
    temp2_value_display = None if temp2 is None else round(temp2, 2)
    rs_ro_value_display = None if rs_ro is None else round(rs_ro, 2)
    # 数据库存储保留更多小数位
    lux_value_db = None if lux is None else round(lux, 1)
    pressure_value_db = None if pressure is None else round(pressure, 2)
    temp2_value_db = None if temp2 is None else round(temp2, 2)
    rs_ro_value_db = None if rs_ro is None else round(rs_ro, 2)
    # 发送给前端的数据（包含大气压、温度2和Rs/Ro）
    payload = {
        "type": "reading",
        "ts": ts,
        "temp": round(t, 2),
        "hum": round(h, 2),
        "lux": lux_value_display,
        "smoke": smoke_value,
        "pressure": pressure_value_display,
        "temp2": temp2_value_display,
        "rs_ro": rs_ro_value_display,
        "device_id": device_id,  # 添加设备ID
    }

    # 更新统计并保存到数据库
    async def _inc_and_queue():
        async with stat_lock:
            globals()["stat_all"] += 1
            if lux is not None:
                globals()["stat_with_lux"] += 1
            if smoke is not None:
                globals()["stat_with_smoke"] += 1
        await broadcast_queue.put(json.dumps(payload))

        # 保存到数据库（包括新增的3个参数和设备ID）
        db = get_db_manager()
        try:
            await db.insert_sensor_data(
                temp=round(t, 2),
                hum=round(h, 2),
                lux=lux_value_db,
                smoke=smoke_value,
                timestamp=ts,
                rs_ro=rs_ro_value_db,
                temp2=temp2_value_db,
                pressure=pressure_value_db,
                device_id=device_id  # 添加设备ID
            )
        except Exception as e:
            print(f"【数据库】保存数据失败：{e}")
        else:
            if smoke_value is not None:
                try:
                    via_label = source or ("BLE" if ble_connected else ("MQTT" if mqtt_connected else None))
                    await db.set_sensor_state(
                        "MQ2",
                        sensor_state=None,
                        via=via_label,
                        last_value=smoke_value,
                        device_id=(device_id or "D01")
                    )
                except Exception as e:
                    print(f"【数据库】更新MQ2最近值失败：{e}")

        # 自动恢复机制：检查是否有未恢复的警告，连续收到N个正常数据包后自动标记为安全
        try:
            async with warning_recovery_lock:
                # 查询所有未恢复的警告类型
                current_device_id = device_id or "D01"
                unresolved_types = await db.get_unresolved_warning_types(device_id=current_device_id)

                if unresolved_types:
                    # 对于每个未恢复的警告类型，检查当前数据值是否正常
                    for warning_type in unresolved_types:
                        # 根据警告类型获取对应的传感器值
                        sensor_value = None
                        if warning_type == 'T':
                            sensor_value = t
                        elif warning_type == 'H':
                            sensor_value = h
                        elif warning_type == 'B':
                            sensor_value = lux
                        elif warning_type == 'S':
                            sensor_value = smoke
                        elif warning_type == 'P':
                            sensor_value = pressure

                        # 如果传感器值为None，跳过（该传感器可能未启用）
                        if sensor_value is None:
                            continue

                        # 检查传感器值是否在正常范围内
                        is_normal = _check_sensor_value_normal(warning_type, sensor_value)

                        counter_key = (current_device_id, warning_type)

                        if is_normal:
                            # 值在正常范围内，增加计数器
                            if counter_key not in warning_recovery_counters:
                                warning_recovery_counters[counter_key] = 0
                            warning_recovery_counters[counter_key] += 1

                            # 检查是否达到阈值
                            if warning_recovery_counters[counter_key] >= AUTO_RECOVERY_NORMAL_PACKETS:
                                # 自动标记为安全
                                type_names = {
                                    'T': '温度',
                                    'H': '湿度',
                                    'B': '亮度',
                                    'S': 'PPM',
                                    'P': '大气压'
                                }
                                type_name = type_names.get(warning_type, warning_type)

                                success = await db.resolve_warning(warning_type, device_id=current_device_id)
                                if success:
                                    # 重置计数器
                                    warning_recovery_counters[counter_key] = 0

                                    # 通过WebSocket推送恢复通知
                                    resolved_notification = {
                                        "type": "warning_resolved",
                                        "warning_type": warning_type,
                                        "warning_name": type_name,
                                        "device_id": current_device_id,
                                        "timestamp": ts,
                                        "auto_recovered": True  # 标记为自动恢复
                                    }
                                    await broadcast_queue.put(json.dumps(resolved_notification))
                                    print(
                                        f"【自动恢复】✓ {type_name}传感器已自动恢复（连续收到{AUTO_RECOVERY_NORMAL_PACKETS}个正常数据包，当前值：{sensor_value}）")
                                else:
                                    # 如果标记失败，可能是已经被手动恢复了，重置计数器
                                    warning_recovery_counters[counter_key] = 0
                            else:
                                # 打印进度（可选，避免日志过多）
                                if warning_recovery_counters[counter_key] == 1:
                                    type_names = {
                                        'T': '温度',
                                        'H': '湿度',
                                        'B': '亮度',
                                        'S': 'PPM',
                                        'P': '大气压'
                                    }
                                    type_name = type_names.get(warning_type, warning_type)
                                    print(
                                        f"【自动恢复】开始监控{type_name}传感器恢复状态（需要连续{AUTO_RECOVERY_NORMAL_PACKETS}个正常数据包，当前值：{sensor_value}）")
                        else:
                            # 值不在正常范围内，重置计数器
                            if counter_key in warning_recovery_counters:
                                type_names = {
                                    'T': '温度',
                                    'H': '湿度',
                                    'B': '亮度',
                                    'S': 'PPM',
                                    'P': '大气压'
                                }
                                type_name = type_names.get(warning_type, warning_type)
                                threshold = SENSOR_THRESHOLDS.get(warning_type, {})
                                print(
                                    f"【自动恢复】{type_name}传感器值异常（当前值：{sensor_value}，正常范围：{threshold.get('min', '?')}-{threshold.get('max', '?')}），重置恢复计数器")
                                del warning_recovery_counters[counter_key]

                # 清理已经不存在的未恢复警告类型的计数器
                if unresolved_types:
                    # 只保留仍然存在的未恢复警告类型的计数器
                    keys_to_remove = [
                        k for k in list(warning_recovery_counters.keys())
                        if k[0] == current_device_id and k[1] not in unresolved_types
                    ]
                    for k in keys_to_remove:
                        del warning_recovery_counters[k]
        except Exception as e:
            print(f"【自动恢复】检查失败：{e}")

    # 检查是否有事件循环
    global main_loop
    if main_loop and main_loop.is_running():
        # 使用 asyncio.run_coroutine_threadsafe 从其他线程调度协程
        asyncio.run_coroutine_threadsafe(_inc_and_queue(), main_loop)
    else:
        # 如果在同一个事件循环中，直接创建任务
        try:
            asyncio.create_task(_inc_and_queue())
        except RuntimeError:
            # 没有运行中的事件循环，尝试使用全局循环
            if main_loop:
                asyncio.run_coroutine_threadsafe(_inc_and_queue(), main_loop)


def ble_notify_handler(_handle, data: bytearray):
    global _buffer, device_last_message_time
    _buffer += data
    while True:
        idx = _buffer.find(LINE_END)
        if idx < 0:
            break
        line = _buffer[:idx].decode(errors="ignore").strip()
        _buffer[:] = _buffer[idx + len(LINE_END):]

        # 更新设备最后消息时间（蓝牙设备对应D01）
        device_last_message_time["D01"] = time.time()

        # 解析数据格式：T=24.61H=45.78%L=0.0R=1.01Y=3.4W=26.10P=1014.23
        m = PATTERN_DATA.fullmatch(line)
        if m:
            t = float(m.group(1))  # T = 温度
            h = float(m.group(2))  # H = 湿度
            l = float(m.group(3))  # L = 光照
            rs_ro = float(m.group(4))  # R = Rs_Ro
            ppm = float(m.group(5))  # Y = PPM (烟雾)
            t2 = float(m.group(6))  # W = 温度2
            p = float(m.group(7))  # P = 气压

            print(f"【BLE】解析数据 - T:{t}°C H:{h}% L:{l}lux Y:{ppm}ppm | R:{rs_ro} W:{t2}°C P:{p}hpa")
            # 蓝牙设备对应D01设备（因为蓝牙连接时会屏蔽D01的MQTT数据）
            _enqueue_reading(t, h, l, ppm, rs_ro, t2, p, source="BLE", device_id="D01")
        else:
            # 尝试解析警告数据（蓝牙设备对应D01）
            if parse_warning_data(line, source="BLE", device_id="D01"):
                # 警告数据已处理
                pass
            else:
                print(f"【BLE】未能解析的数据格式：{line}")


# ============ MQTT 处理 ============
mqtt_client = None


def mqtt_on_connect(client, userdata, flags, rc):
    """MQTT连接回调"""
    global mqtt_connected, mqtt_first_message_received
    if rc == 0:
        mqtt_connected = True
        print("【MQTT】✓ 成功连接到MQTT服务器")
        # 重置首次消息标志（连接成功后，下次收到的第一条消息可能是服务器保留的消息）
        mqtt_first_message_received = {}
        print("【MQTT】已重置首次消息标志，将屏蔽订阅后的第一条消息（通常是服务器保留的最后一条消息）")
        # 订阅所有设备的传感器数据主题
        for topic in MQTT_TOPICS:
            client.subscribe(topic)
            print(f"【MQTT】✓ 已订阅传感器数据主题：{topic}")
        # 订阅所有设备的定位命令主题
        for topic in MQTT_CMD_TOPICS:
            client.subscribe(topic)
            print(f"【MQTT】✓ 已订阅定位命令主题：{topic}")
        print(f"【MQTT】已订阅 {len(MQTT_TOPICS)} 个设备的传感器数据主题和 {len(MQTT_CMD_TOPICS)} 个定位命令主题")
    else:
        mqtt_connected = False
        print(f"【MQTT】❌ 连接失败，错误码：{rc}")


def mqtt_on_disconnect(client, userdata, rc):
    """MQTT断开连接回调"""
    global mqtt_connected
    mqtt_connected = False
    if rc != 0:
        print(f"【MQTT】⚠️ 意外断开连接，错误码：{rc}")
    else:
        print("【MQTT】断开连接")


def extract_device_id_from_topic(topic: str) -> Optional[str]:
    """
    从MQTT主题中提取设备ID
    例如：stm32/D01/data_now -> D01
          stm32/D02/data_cmd -> D02
    """
    try:
        parts = topic.split('/')
        if len(parts) >= 2 and parts[0] == 'stm32':
            device_id = parts[1].upper()
            if device_id in MQTT_DEVICES:
                return device_id
    except Exception:
        pass
    return None


def parse_location_data(payload, device_id: Optional[str] = None):
    """
    解析定位信息（JSON格式）
    支持的格式：
    - JSON格式：{"utc":"2025-11-04T14:59:53Z","iccid":"898604011025D0227746","type":"LBS","imei":"864865082106973","csq":31,"lon":118.0412,"lat":24.37883}
    
    参数:
        payload: 定位数据内容
        device_id: 设备ID（可选）
    """
    try:
        device_info = f" [设备: {device_id}]" if device_id else ""
        print(f"【定位】收到定位信息{device_info}: {payload}")

        # 尝试解析JSON格式的定位数据
        try:
            location_data = json.loads(payload)

            # 检查是否是定位数据（包含lon和lat字段）
            if "lon" in location_data and "lat" in location_data:
                lon = float(location_data["lon"])
                lat = float(location_data["lat"])

                # 提取其他信息（如果有）
                utc = location_data.get("utc", "")
                iccid = location_data.get("iccid", "")
                imei = location_data.get("imei", "")
                csq = location_data.get("csq", None)
                location_type = location_data.get("type", "")

                print(f"【定位】✓ 解析成功 - 经度: {lon}, 纬度: {lat}, 类型: {location_type}")
                if utc:
                    print(f"【定位】UTC时间: {utc}")
                if csq is not None:
                    print(f"【定位】信号强度(CSQ): {csq}")

                # 通过WebSocket推送定位信息
                async def _broadcast_location():
                    try:
                        location_notification = {
                            "type": "location",
                            "lon": lon,
                            "lat": lat,
                            "utc": utc,
                            "iccid": iccid,
                            "imei": imei,
                            "csq": csq,
                            "location_type": location_type,
                            "device_id": device_id,
                            "timestamp": time.time()
                        }
                        await broadcast_queue.put(json.dumps(location_notification))
                        device_info = f" [设备: {device_id}]" if device_id else ""
                        print(f"【定位】✓ 已推送定位信息到前端{device_info}")
                    except Exception as e:
                        print(f"【定位】推送定位信息失败：{e}")

                # 检查是否有事件循环
                global main_loop
                if main_loop and main_loop.is_running():
                    asyncio.run_coroutine_threadsafe(_broadcast_location(), main_loop)
                else:
                    try:
                        asyncio.create_task(_broadcast_location())
                    except RuntimeError:
                        if main_loop:
                            asyncio.run_coroutine_threadsafe(_broadcast_location(), main_loop)

                return True
            else:
                print(f"【定位】JSON数据中缺少lon或lat字段")
                return False

        except json.JSONDecodeError:
            # 不是JSON格式，尝试其他格式
            print(f"【定位】不是JSON格式，尝试其他格式解析")
            if "GPS:" in payload:
                # GPS:lat=39.9042,lon=116.4074,alt=50
                parts = payload[4:].split(',')
                lat = float(parts[0].split('=')[1])
                lon = float(parts[1].split('=')[1])
                print(f"【定位】解析GPS格式 - 经度: {lon}, 纬度: {lat}")
                return True
            elif payload.startswith("LOC="):
                # LOC=39.9042,116.4074
                coords = payload[4:].split(',')
                lat, lon = float(coords[0]), float(coords[1])
                print(f"【定位】解析LOC格式 - 经度: {lon}, 纬度: {lat}")
                return True
            else:
                print(f"【定位】未知格式: {payload}")
                return False

    except Exception as e:
        print(f"【定位】解析失败：{e}")
        import traceback
        traceback.print_exc()
        return False


def parse_warning_data(payload, source="MQTT", device_id: Optional[str] = None):
    """
    解析警告数据
    支持的格式：
    - 异常数据：DT32.25 (D=危险, T=温度, 32.25=异常值)
    - 恢复数据：ST (S=安全, T=温度)
    - 其他类型：H(湿度), B(亮度), S(ppm), P(大气压)
    
    参数:
        payload: 原始消息内容
        source: 数据源（MQTT或BLE）
        device_id: 设备ID（可选）
    """
    try:
        payload = payload.strip()

        # 检查是否是警告数据格式
        # 异常格式：D + 类型字母 + 数值（如：DT32.25, DH45.78, DB1000, DS50.5, DP1014.23）
        # 恢复格式：S + 类型字母（如：ST, SH, SB, SS, SP）

        if len(payload) >= 2:
            # 检查是否是恢复数据（S开头）
            if payload.startswith('S') and len(payload) == 2:
                warning_type = payload[1].upper()
                if warning_type in ['T', 'H', 'B', 'S', 'P']:
                    device_info = f" [设备: {device_id}]" if device_id else ""
                    print(f"【警告-{source}】收到恢复信号{device_info}：{payload} (类型: {warning_type})")

                    # 异步保存恢复数据并推送通知
                    async def _save_resolved():
                        try:
                            db = get_db_manager()
                            success = await db.resolve_warning(warning_type, device_id=(device_id or "D01"))

                            if success:
                                # 重置自动恢复计数器（因为已经手动恢复了）
                                async with warning_recovery_lock:
                                    counter_key = ((device_id or "D01"), warning_type)
                                    if counter_key in warning_recovery_counters:
                                        del warning_recovery_counters[counter_key]
                                        print(f"【自动恢复】已重置{warning_type}类型的恢复计数器（收到手动恢复信号）")

                                # 通过WebSocket推送恢复通知
                                type_names = {
                                    'T': '温度',
                                    'H': '湿度',
                                    'B': '亮度',
                                    'S': 'PPM',
                                    'P': '大气压'
                                }
                                type_name = type_names.get(warning_type, warning_type)

                                resolved_notification = {
                                    "type": "warning_resolved",
                                    "warning_type": warning_type,
                                    "warning_name": type_name,
                                    "device_id": device_id or "D01",
                                    "timestamp": time.time()
                                }
                                await broadcast_queue.put(json.dumps(resolved_notification))
                                device_info = f" [设备: {device_id}]" if device_id else ""
                                print(f"【警告-{source}】✓ 已推送恢复通知{device_info}")
                        except Exception as e:
                            print(f"【警告-{source}】保存恢复数据失败：{e}")

                    # 检查是否有事件循环
                    global main_loop
                    if main_loop and main_loop.is_running():
                        asyncio.run_coroutine_threadsafe(_save_resolved(), main_loop)
                    else:
                        try:
                            asyncio.create_task(_save_resolved())
                        except RuntimeError:
                            if main_loop:
                                asyncio.run_coroutine_threadsafe(_save_resolved(), main_loop)
                    return True

            # 检查是否是异常数据（D开头，后面跟类型字母和数值）
            elif payload.startswith('D') and len(payload) > 2:
                warning_type = payload[1].upper()
                if warning_type in ['T', 'H', 'B', 'S', 'P']:
                    # 提取数值部分（从第3个字符开始）
                    try:
                        warning_value = float(payload[2:])

                        # 根据类型生成中文描述
                        type_names = {
                            'T': '温度',
                            'H': '湿度',
                            'B': '亮度',
                            'S': 'PPM',
                            'P': '大气压'
                        }
                        type_name = type_names.get(warning_type, warning_type)
                        unit = '°C' if warning_type == 'T' else ('%' if warning_type == 'H' else (
                            'lux' if warning_type == 'B' else ('ppm' if warning_type == 'S' else 'hPa')))

                        device_info = f" [设备: {device_id}]" if device_id else ""
                        print(
                            f"【警告-{source}】⚠️ 检测到异常{device_info}：{type_name}异常，当前值：{warning_value}{unit} (消息: {payload})")

                        # 异步保存警告数据并推送通知
                        async def _save_warning():
                            try:
                                db = get_db_manager()
                                await db.insert_warning_data(
                                    warning_type=warning_type,
                                    warning_message=payload,
                                    warning_value=warning_value,
                                    device_id=device_id or "D01"
                                )

                                # 重置自动恢复计数器（因为出现了新的异常）
                                async with warning_recovery_lock:
                                    counter_key = ((device_id or "D01"), warning_type)
                                    if counter_key in warning_recovery_counters:
                                        del warning_recovery_counters[counter_key]
                                        print(f"【自动恢复】已重置{warning_type}类型的恢复计数器（检测到新的异常）")

                                # 通过WebSocket推送警告通知
                                warning_notification = {
                                    "type": "warning",
                                    "warning_type": warning_type,
                                    "warning_name": type_name,
                                    "warning_value": warning_value,
                                    "warning_unit": unit,
                                    "warning_message": payload,
                                    "device_id": device_id or "D01",
                                    "timestamp": time.time()
                                }
                                await broadcast_queue.put(json.dumps(warning_notification))
                            except Exception as e:
                                print(f"【警告-{source}】保存警告数据失败：{e}")

                        # 检查是否有事件循环
                        if main_loop and main_loop.is_running():
                            asyncio.run_coroutine_threadsafe(_save_warning(), main_loop)
                        else:
                            try:
                                asyncio.create_task(_save_warning())
                            except RuntimeError:
                                if main_loop:
                                    asyncio.run_coroutine_threadsafe(_save_warning(), main_loop)
                        return True
                    except ValueError:
                        # 无法解析数值
                        print(f"【警告-{source}】警告数据格式错误，无法解析数值：{payload}")
                        return False

        return False

    except Exception as e:
        print(f"【警告-{source}】解析警告数据失败：{e}")
        return False


def mqtt_on_message(client, userdata, msg):
    """
    MQTT消息回调
    处理从MQTT接收到的消息（传感器数据、定位信息等）
    """
    global ble_connected, mqtt_first_message_received, main_loop, device_last_message_time

    try:
        topic = msg.topic
        payload = msg.payload.decode('utf-8').strip()

        # 从主题中提取设备ID
        device_id = extract_device_id_from_topic(topic)
        device_info = f" [设备: {device_id}]" if device_id else ""
        
        # 更新设备最后消息时间
        if device_id:
            device_last_message_time[device_id] = time.time()

        # 屏蔽传感器数据主题的第一条消息（通常是服务器保留的最后一条消息，会导致重复数据）
        if topic in MQTT_TOPICS and topic not in mqtt_first_message_received:
            mqtt_first_message_received[topic] = True
            print(f"【MQTT】⚠️ 屏蔽第一条消息（服务器保留消息）{device_info} - 主题: {topic}, 内容: {payload[:50]}...")
            return

        # 根据主题区分处理
        if topic in MQTT_CMD_TOPICS:
            # 定位命令主题，处理定位数据（JSON格式）
            # 忽略查询命令"LBS?"（这是我们发送的命令，不是定位数据）
            if payload.strip() == "LBS?":
                print(f"【MQTT-定位】收到定位查询命令（忽略）{device_info}: {payload}")
                return
            normalized_payload = payload.strip().upper()
            if normalized_payload in MQTT_CONTROL_COMMANDS:
                print(f"【MQTT-控制】收到控制指令回显（忽略定位解析）{device_info}: {payload}")
                return

            print(f"【MQTT-定位】收到定位数据{device_info} (主题: {topic}): {payload}")
            if parse_location_data(payload, device_id=device_id):
                # 定位数据已处理
                return
            else:
                print(f"【MQTT-定位】未能解析定位数据{device_info}: {payload}")
                return

        # 传感器数据主题
        elif topic in MQTT_TOPICS:
            # 解析传感器数据格式：T=24.61H=45.78%L=0.0R=1.01Y=3.4W=26.10P=1014.23
            m = PATTERN_DATA.fullmatch(payload)
            if m:
                # 传感器数据：仅在蓝牙未连接时使用（避免重复数据）
                # 注意：多设备模式下，即使蓝牙连接，MQTT的其他设备数据也应该处理
                # 这里保持原有逻辑：如果蓝牙连接，只忽略MQTT数据（假设蓝牙是D01设备）
                # 如果需要支持蓝牙多设备，需要进一步修改
                if ble_connected and device_id == "D01":
                    # 蓝牙已连接且是D01设备，忽略MQTT传感器数据（蓝牙优先）
                    return

                print(f"【MQTT】收到传感器数据{device_info}: {payload}")
                t = float(m.group(1))  # T = 温度
                h = float(m.group(2))  # H = 湿度
                l = float(m.group(3))  # L = 光照
                rs_ro = float(m.group(4))  # R = Rs_Ro
                ppm = float(m.group(5))  # Y = PPM (烟雾)
                t2 = float(m.group(6))  # W = 温度2
                p = float(m.group(7))  # P = 气压

                print(
                    f"【MQTT】解析传感器数据{device_info} - T:{t}°C H:{h}% L:{l}lux Y:{ppm}ppm | R:{rs_ro} W:{t2}°C P:{p}hpa")
                _enqueue_reading(t, h, l, ppm, rs_ro, t2, p, source="MQTT", device_id=device_id)
            else:
                # 非传感器数据格式（可能是警告数据、定位数据或其他指令）
                # 无论蓝牙是否连接都处理
                print(f"【MQTT】收到其他消息{device_info}: {payload}")

                # 检查是否是onmessage或offmessage命令（使用消息发送模块处理）
                global mqtt_message_sender
                payload_normalized = payload.strip().lower()
                if payload_normalized in ["onmessage", "offmessage"]:
                    print(f"【MQTT】检测到消息命令: {payload_normalized}, 设备: {device_id}, mqtt_message_sender: {mqtt_message_sender is not None}")
                    if mqtt_message_sender:
                        result = mqtt_message_sender.handle_message(device_id, payload)
                        print(f"【MQTT】handle_message 返回: {result}")
                        if result:
                            # 消息已被处理（onmessage或offmessage）
                            return
                    else:
                        print(f"【MQTT】警告：mqtt_message_sender 未初始化")

                # 首先尝试解析警告数据
                if parse_warning_data(payload, source="MQTT", device_id=device_id):
                    # 警告数据已处理
                    return

                # 尝试解析JSON格式的定位数据（设备可能将定位数据发送到传感器数据主题）
                try:
                    location_data = json.loads(payload)
                    if "lon" in location_data and "lat" in location_data:
                        # 这是JSON格式的定位数据
                        print(f"【MQTT】检测到JSON格式定位数据{device_info}，尝试解析...")
                        if parse_location_data(payload, device_id=device_id):
                            # 定位数据已处理
                            return
                except (json.JSONDecodeError, ValueError):
                    # 不是JSON格式，继续尝试其他格式
                    pass

                # 尝试解析定位信息（旧格式兼容）
                if "GPS:" in payload or "LOC=" in payload or "POSITION:" in payload:
                    parse_location_data(payload, device_id=device_id)
                else:
                    # 其他未知格式的消息
                    print(f"【MQTT】未知消息格式{device_info}，已记录: {payload}")
        else:
            # 未知主题
            print(f"【MQTT】收到未知主题的消息 (主题: {topic}): {payload}")

    except Exception as e:
        print(f"【MQTT】消息处理错误：{e}")
        import traceback
        traceback.print_exc()


async def test_dns_resolution(hostname):
    """测试DNS解析"""
    import socket
    try:
        print(f"【MQTT】测试DNS解析: {hostname}")
        ip_address = socket.gethostbyname(hostname)
        print(f"【MQTT】✓ DNS解析成功: {hostname} -> {ip_address}")
        return True
    except socket.gaierror as e:
        print(f"【MQTT】❌ DNS解析失败: {e}")
        print(f"【MQTT】提示：请检查网络连接，或尝试使用其他DNS服务器（如 8.8.8.8）")
        return False
    except Exception as e:
        print(f"【MQTT】❌ DNS解析错误: {e}")
        return False


async def mqtt_task():
    """MQTT客户端任务，作为备用数据源。立即启动并持续保持连接。"""
    global mqtt_client, mqtt_connected, mqtt_connection_attempted, ble_connected, ble_connection_attempted

    print("【MQTT】MQTT 任务启动，立即连接并持续保持订阅...")
    print("【MQTT】说明：MQTT将在后台持续运行，蓝牙断开时立即接管数据传输")

    # 短暂延迟，让蓝牙任务先启动（避免资源竞争）
    await asyncio.sleep(2)

    # 开始 MQTT 连接流程（持续保持连接）
    while True:
        try:
            print("【MQTT】正在初始化MQTT客户端...")

            # 检查CA证书文件
            if not MQTT_CA_CERT_FILE.exists():
                print(f"【MQTT】❌ CA证书文件不存在：{MQTT_CA_CERT_FILE}")
                print(f"【MQTT】30秒后重试...")
                await asyncio.sleep(30)
                continue

            print(f"【MQTT】使用CA证书文件：{MQTT_CA_CERT_FILE}")

            # 测试DNS解析
            if not await test_dns_resolution(MQTT_BROKER):
                print(f"【MQTT】⚠️ DNS解析失败")
                print(f"【MQTT】30秒后重试...")
                await asyncio.sleep(30)
                continue

            # 创建MQTT客户端
            mqtt_client = mqtt.Client(client_id=f"python_sensor_client_{int(time.time())}", protocol=mqtt.MQTTv311)
            mqtt_client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
            mqtt_client.tls_set(
                ca_certs=str(MQTT_CA_CERT_FILE),
                cert_reqs=ssl.CERT_REQUIRED,
                tls_version=ssl.PROTOCOL_TLS
            )
            mqtt_client.on_connect = mqtt_on_connect
            mqtt_client.on_disconnect = mqtt_on_disconnect
            mqtt_client.on_message = mqtt_on_message

            print(f"【MQTT】正在连接到 {MQTT_BROKER}:{MQTT_PORT}...")
            mqtt_connection_attempted = True

            mqtt_client.connect(MQTT_BROKER, MQTT_PORT, keepalive=60)
            mqtt_client.loop_start()
            print("【MQTT】已启动网络循环")

            # 等待连接建立
            wait_time = 0
            while not mqtt_connected and wait_time < 10:
                await asyncio.sleep(0.5)
                wait_time += 0.5

            if not mqtt_connected:
                print("【MQTT】⚠️ 连接超时，10秒后重试...")
                mqtt_client.loop_stop()
                await asyncio.sleep(10)
                continue

            print("【MQTT】✓ MQTT连接成功，持续保持连接（零延迟切换就绪）")
            print(f"【MQTT】说明：MQTT持续订阅所有消息（支持 {len(MQTT_DEVICES)} 个设备：{', '.join(MQTT_DEVICES)}）")
            print("【MQTT】  - 传感器数据：蓝牙连接时忽略D01数据，蓝牙断开时立即接管；其他设备数据始终处理")
            print("【MQTT】  - 其他消息（如定位信息）：始终处理")

            # 保持运行，持续监控连接状态
            while mqtt_connected:
                await asyncio.sleep(5)

                # 定期打印状态（每60秒）
                if int(time.time()) % 60 == 0:
                    if ble_connected:
                        print("【MQTT】状态：MQTT已连接（待机中，蓝牙优先）")
                    else:
                        print("【MQTT】状态：MQTT已连接（活动中，提供数据）")

            # MQTT断开，尝试重连
            print("【MQTT】连接断开，10秒后重连...")
            mqtt_client.loop_stop()
            await asyncio.sleep(10)
            continue

        except Exception as e:
            print(f"【MQTT】连接失败：{e}")
            print("【MQTT】10秒后重试...")
            mqtt_connected = False
            await asyncio.sleep(10)


async def mqtt_first_ble_fallback_task():
    """
    MQTT优先任务，MQTT掉线自动切BLE，BLE期间定期重试MQTT。
    """
    global mqtt_connected, ble_connected
    while True:
        # 只要MQTT没连接，就优先连MQTT，否则只保活（数据源由MQTT提供）
        await mqtt_task()
        print("【主控】MQTT离线，尝试启用BLE备用...")
        await ble_task()  # MQTT掉线后尝试蓝牙
        print("【主控】BLE已退出，10秒后重新尝试MQTT连接...")
        await asyncio.sleep(10)


async def ble_task():
    """连接 BLE 并订阅通知，掉线自动重连。支持BT27设备。优先使用的数据源。"""
    global ble_connected, ble_connection_attempted, mqtt_connected, ble_client

    print("【BLE】蓝牙任务启动，优先尝试连接蓝牙设备...")

    # 标记已尝试连接（让MQTT任务知道可以开始等待了）
    ble_connection_attempted = True

    # 尝试连接蓝牙（最多尝试5次，快速重试）
    max_initial_attempts = 5
    initial_connected = False

    for attempt in range(1, max_initial_attempts + 1):
        try:
            # 扫描并获取可用的设备地址（返回地址和设备名称）
            device_addr, device_name = await get_device_address()
            print(f"【BLE】连接尝试 {attempt}/{max_initial_attempts}：{device_name} ({device_addr})")

            async with BleakClient(device_addr, timeout=15.0) as client:
                if not client.is_connected:
                    print(f"【BLE】连接失败（尝试 {attempt}/{max_initial_attempts}），立即重试...")
                    await asyncio.sleep(1)
                    continue

                print(f"【BLE】✓ 已连接到 {device_name}")

                # 等待连接稳定（Windows蓝牙需要短暂等待）
                await asyncio.sleep(0.5)

                # 再次验证连接状态
                if not client.is_connected:
                    print(f"【BLE】连接已断开，重试中...")
                    await asyncio.sleep(2)
                    continue

                # 连接成功，开始订阅
                print(f"【BLE】准备订阅 FFE1 特征通知...")
                try:
                    await client.start_notify(UART_RXTX_CHAR, ble_notify_handler)
                    print(f"【BLE】✓ 已订阅通知，开始接收 {device_name} 的数据（优先数据源）")
                    print(f"【BLE】说明：蓝牙已接管传感器数据，MQTT传感器数据被忽略")

                    # 订阅成功，标记连接成功
                    ble_connected = True
                    ble_client = client
                    initial_connected = True
                except Exception as subscribe_error:
                    print(f"【BLE】订阅失败: {subscribe_error}")
                    print(f"【BLE】立即重试...")
                    await asyncio.sleep(1)
                    continue

                # 保持连接，直到断开（快速检测：100ms轮询）
                while client.is_connected:
                    await asyncio.sleep(0.1)

                # 连接断开
                ble_connected = False
                ble_client = None
                print(f"【BLE】{device_name} 连接断开")
                print(f"【BLE】✓ 已切换到 MQTT 数据源（MQTT 持续连接中，立即接管）")
                break

        except Exception as e:
            print(f"【BLE】连接尝试失败（{attempt}/{max_initial_attempts}）：{e}")
            if attempt < max_initial_attempts:
                await asyncio.sleep(1)

    # 如果初次连接失败，使用 MQTT 并持续重试蓝牙
    if not initial_connected:
        print("【BLE】⚠️ 初次蓝牙连接失败，MQTT 将接管数据传输")
        print("【BLE】说明：系统将持续尝试重连蓝牙，一旦连接成功立即切回")

    # 持续尝试重连蓝牙
    reconnect_interval = 10  # 重连间隔（秒）
    while True:
        # 等待一段时间再重试（避免频繁重连）
        await asyncio.sleep(reconnect_interval)

        try:
            # 扫描并获取可用的设备地址
            device_addr, device_name = await get_device_address()
            print(f"【BLE】尝试重新连接：{device_name} ({device_addr})")

            async with BleakClient(device_addr, timeout=15.0) as client:
                if not client.is_connected:
                    print(f"【BLE】重连失败，{reconnect_interval}秒后重试...")
                    continue

                print(f"【BLE】✓ 重新连接成功：{device_name}")

                # 等待连接稳定
                await asyncio.sleep(0.5)

                # 验证连接状态
                if not client.is_connected:
                    print(f"【BLE】连接已断开，{reconnect_interval}秒后重试...")
                    continue

                # 开始订阅
                try:
                    await client.start_notify(UART_RXTX_CHAR, ble_notify_handler)
                    print(f"【BLE】✓ 已重新订阅通知，恢复数据接收")
                    print(f"【BLE】✓ 已切换回蓝牙数据源（MQTT转入待机状态）")

                    # 订阅成功，标记连接成功
                    ble_connected = True
                    ble_client = client
                except Exception as subscribe_error:
                    print(f"【BLE】订阅失败: {subscribe_error}")
                    print(f"【BLE】{reconnect_interval}秒后重试...")
                    continue

                # 保持连接（快速检测：100ms轮询）
                while client.is_connected:
                    await asyncio.sleep(0.1)

                # 连接断开
                ble_connected = False
                ble_client = None
                print(f"【BLE】连接再次断开")
                print(f"【BLE】✓ 已切换到 MQTT 数据源（立即接管）")

        except Exception as e:
            print(f"【BLE】重连错误：{e}")


# ============ FastAPI 应用（lifespan，避免弃用警告） ============
@asynccontextmanager
async def lifespan(app: FastAPI):
    global main_loop, mq2_bootstrap_task, mq2_cycle_tasks, mq2_cycle_wakeups, mqtt_client
    global bmp180_bootstrap_task, bmp180_cycle_tasks, bmp180_cycle_wakeups
    global bh1750_bootstrap_task, bh1750_cycle_tasks, bh1750_cycle_wakeups
    global mqtt_message_sender
    print("【服务】应用启动中...")

    # 保存主事件循环引用
    main_loop = asyncio.get_running_loop()
    print(f"【服务】事件循环已保存：{main_loop}")
    
    # 初始化MQTT消息发送管理器
    mqtt_message_sender = MqttMessageSender(
        get_mqtt_client=lambda: mqtt_client,
        get_mqtt_connected=lambda: mqtt_connected,
        get_connections=lambda: connections,
        get_cmd_topic_map=lambda: MQTT_CMD_TOPIC_MAP,
        get_main_loop=lambda: main_loop
    )
    print("【服务】MQTT消息发送管理器已初始化")

    # 初始化数据库连接池
    db = get_db_manager()
    db_success = await db.init_pool(minsize=2, maxsize=10)
    if db_success:
        print("【服务】数据库连接池已初始化")
        await db.ensure_sensor_state_table()
        await db.ensure_sensor_readings_table()
        await db.ensure_warning_table()
    else:
        print("【警告】数据库连接失败，数据将不会被持久化")

    # 启动后台任务
    asyncio.create_task(broadcaster())
    if ble_or_mqtt_first == 0:
        # 蓝牙优先
        asyncio.create_task(ble_task())
        asyncio.create_task(mqtt_task())
        print("【主控】已设为蓝牙优先，MQTT待机，蓝牙上线立刻切换。")
    else:
        # MQTT优先，断线后BLE接管且重试MQTT
        asyncio.create_task(mqtt_first_ble_fallback_task())
        print("【主控】已设为MQTT优先，主连MQTT，断线时自动切BLE备用。")
    asyncio.create_task(stats_task())
    mq2_bootstrap_task = asyncio.create_task(initialize_mq2_on_startup())
    bmp180_bootstrap_task = asyncio.create_task(initialize_bmp180_on_startup())
    bh1750_bootstrap_task = asyncio.create_task(initialize_bh1750_on_startup())

    print("【服务】应用已启动。")
    yield
    print("【服务】应用正在关闭...")

    for task in list(mq2_cycle_tasks.values()):
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    mq2_cycle_tasks.clear()
    mq2_cycle_wakeups.clear()
    if mq2_bootstrap_task:
        mq2_bootstrap_task.cancel()
        try:
            await mq2_bootstrap_task
        except asyncio.CancelledError:
            pass
    
    for task in list(bmp180_cycle_tasks.values()):
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    bmp180_cycle_tasks.clear()
    bmp180_cycle_wakeups.clear()
    if bmp180_bootstrap_task:
        bmp180_bootstrap_task.cancel()
        try:
            await bmp180_bootstrap_task
        except asyncio.CancelledError:
            pass
    
    for task in list(bh1750_cycle_tasks.values()):
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    bh1750_cycle_tasks.clear()
    bh1750_cycle_wakeups.clear()
    if bh1750_bootstrap_task:
        bh1750_bootstrap_task.cancel()
        try:
            await bh1750_bootstrap_task
        except asyncio.CancelledError:
            pass

    # 清理MQTT消息发送管理器
    if mqtt_message_sender:
        await mqtt_message_sender.cleanup()

    # 停止MQTT客户端
    if mqtt_client:
        try:
            mqtt_client.loop_stop()
            mqtt_client.disconnect()
            print("【MQTT】已断开连接")
        except:
            pass

    # 关闭数据库连接池
    if db_success:
        await db.close_pool()


app = FastAPI(lifespan=lifespan)

# 静态资源放在 /static，避免拦截 /ws 或 /
app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")
# 将 resource 文件夹挂载到 /resource 路径
app.mount("/resource", StaticFiles(directory=str(RESOURCE_DIR)), name="resource")


# 设备总览首页：强制不缓存，防止浏览器看到旧 HTML
@app.get("/", tags=["首页-设备总览"])
async def device_index():
    if not DEVICE_INDEX_FILE.exists():
        return Response("未找到 web/devices.html", status_code=404)

    try:
        content = DEVICE_INDEX_FILE.read_text(encoding="utf-8")
    except Exception as e:
        print(f"【首页】读取 devices.html 失败：{e}")
        return Response("读取首页失败", status_code=500)

    return Response(
        content,
        media_type="text/html",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"}
    )


# 实时数据页：保持原有逻辑，在返回前注入高德地图 Key
@app.get("/realtime.html", tags=["实时数据页"])
async def realtime_index():
    if not INDEX_FILE.exists():
        return Response("未找到 web/index.html", status_code=404)

    try:
        content = INDEX_FILE.read_text(encoding="utf-8")
    except Exception as e:
        print(f"【实时页】读取 index.html 失败：{e}")
        return Response("读取首页失败", status_code=500)

    amap_key = SECRETS.get("AMAP_WEB_KEY", "")
    if not amap_key:
        print("【警告】未在密钥文件中配置 AMAP_WEB_KEY，高德地图功能将不可用或受限。")
    content = content.replace("__AMAP_WEB_KEY__", amap_key)

    return Response(
        content,
        media_type="text/html",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"}
    )


# 这是给微信验证用的接口
@app.get("/248a1604fe87bdaa034745d8ed14e74e.txt", tags=["微信验证"], response_class=PlainTextResponse)
async def wechat_verify():
    return "6daf8552330d70c4e2200cef15527c71411e42f6"


# ============ 设备控制（BLE 优先，MQTT 兜底） ============
async def send_command_ble_or_mqtt(command: str, device_id: str = "D01"):
    """
    发送命令到设备：优先通过BLE写入，失败或未连接则通过MQTT发布。
    返回字典包含方式、是否成功及附加信息。
    """
    global ble_connected, ble_client, mqtt_client, mqtt_connected
    device_id = (device_id or "D01").upper()

    # 优先尝试BLE（仅D01支持BLE）
    if device_id == "D01" and ble_connected and ble_client is not None:
        try:
            payload = (command + "\r\n").encode("utf-8")
            await ble_client.write_gatt_char(UART_RXTX_CHAR, payload, response=True)
            print(f"【控制】✓ 通过 BLE 发送命令：{command} (设备: {device_id})")
            return {"success": True, "via": "BLE", "device_id": device_id}
        except Exception as e:
            print(f"【控制】通过 BLE 发送命令失败：{e}，设备 {device_id} 将回退到MQTT")

    # 回退到MQTT
    if mqtt_connected and mqtt_client is not None:
        try:
            target_topic = MQTT_CMD_TOPIC_MAP.get(device_id, MQTT_CMD_TOPIC)
            result = mqtt_client.publish(target_topic, command, qos=1)
            if result.rc == mqtt.MQTT_ERR_SUCCESS:
                print(f"【控制】✓ 通过 MQTT 发送命令：{command} -> {target_topic}")
                return {"success": True, "via": "MQTT", "topic": target_topic, "device_id": device_id}
            else:
                print(f"【控制】❌ MQTT 发布失败，错误码: {result.rc}")
                return {"success": False, "via": "MQTT", "error": f"publish rc={result.rc}", "device_id": device_id}
        except Exception as e:
            print(f"【控制】通过 MQTT 发送命令异常：{e}")
            return {"success": False, "via": "MQTT", "error": str(e), "device_id": device_id}

    return {"success": False, "via": None, "error": "BLE和MQTT均未连接", "device_id": device_id}


async def wait_for_startup_transport(preferred: str, preferred_timeout: int = 60, remind_interval: int = 30) -> \
        Optional[str]:
    """
    等待首选通信链路就绪（BLE/MQTT），必要时回退到可用链路。
    preferred_timeout 秒后若首选链路仍不可用且存在其他链路，则回退。
    """
    global ble_connected, mqtt_connected
    preferred = (preferred or "BLE").upper()
    prefer_ble = preferred == "BLE"
    elapsed = 0
    print(f"【MQ2初始化】等待{preferred}链路就绪以初始化MQ2...")

    while True:
        if prefer_ble and ble_connected:
            return "BLE"
        if not prefer_ble and mqtt_connected:
            return "MQTT"

        if preferred_timeout and elapsed >= preferred_timeout:
            fallback = "MQTT" if prefer_ble else "BLE"
            if fallback == "BLE" and ble_connected:
                print(f"【MQ2初始化】⚠️ {preferred}未在{preferred_timeout}秒内就绪，改用BLE初始化。")
                return "BLE"
            if fallback == "MQTT" and mqtt_connected:
                print(f"【MQ2初始化】⚠️ {preferred}未在{preferred_timeout}秒内就绪，改用MQTT初始化。")
                return "MQTT"

        if remind_interval and elapsed and elapsed % remind_interval == 0:
            print(f"【MQ2初始化】仍在等待{preferred}链路（已等待 {elapsed} 秒）...")

        await asyncio.sleep(1)
        elapsed += 1


async def initialize_mq2_on_startup():
    """
    等待通信链路就绪后初始化MQ2，将状态交给调度器统一开启。
    """
    db = get_db_manager()
    # 确保 D01 优先，其它设备按配置依次处理
    ordered_devices = get_managed_mq2_devices()

    for device in ordered_devices:
        prefer = "BLE" if (device == "D01" and ble_or_mqtt_first == 0) else "MQTT"
        transport = await wait_for_startup_transport(prefer)
        if transport:
            print(f"【MQ2初始化】通信链路 {transport} 已就绪（设备 {device}），交由调度器开启 MQ2。")
            phase_message = f"等待调度器开启（链路：{transport}）"
            via_label = transport
        else:
            print(f"【MQ2初始化】未等到可用通信链路（设备 {device}），调度器将持续重试。")
            phase_message = "等待调度器开启（链路未就绪）"
            via_label = None

        try:
            await db.set_sensor_state(
                "MQ2",
                sensor_state="off",
                via=via_label,
                mode=DEFAULT_MQ2_MODE,
                phase="pending",
                phase_message=phase_message,
                phase_until=None,
                device_id=device
            )
        except Exception as e:
            print(f"【MQ2初始化】记录设备 {device} 状态失败：{e}")

    ensure_mq2_cycle_started()


def ensure_bmp180_cycle_started():
    """确保BMP180供电调度器仅针对需要的设备各启动一次。"""
    global bmp180_cycle_tasks, bmp180_cycle_wakeups
    for device in get_managed_mq2_devices():  # 复用MQ2的设备列表
        task = bmp180_cycle_tasks.get(device)
        if task and not task.done():
            continue
        if device not in bmp180_cycle_wakeups:
            bmp180_cycle_wakeups[device] = asyncio.Event()
        bmp180_cycle_tasks[device] = asyncio.create_task(bmp180_cycle_manager(device))


def ensure_bh1750_cycle_started():
    """确保BH1750供电调度器仅针对需要的设备各启动一次。"""
    global bh1750_cycle_tasks, bh1750_cycle_wakeups
    for device in get_managed_mq2_devices():  # 复用MQ2的设备列表
        task = bh1750_cycle_tasks.get(device)
        if task and not task.done():
            continue
        if device not in bh1750_cycle_wakeups:
            bh1750_cycle_wakeups[device] = asyncio.Event()
        bh1750_cycle_tasks[device] = asyncio.create_task(bh1750_cycle_manager(device))


async def initialize_bmp180_on_startup():
    """等待通信链路就绪后初始化BMP180，将状态交给调度器统一开启。"""
    db = get_db_manager()
    ordered_devices = get_managed_mq2_devices()

    for device in ordered_devices:
        prefer = "BLE" if (device == "D01" and ble_or_mqtt_first == 0) else "MQTT"
        transport = await wait_for_startup_transport(prefer)
        if transport:
            print(f"【BMP180初始化】通信链路 {transport} 已就绪（设备 {device}），交由调度器开启 BMP180。")
            phase_message = f"等待调度器开启（链路：{transport}）"
            via_label = transport
        else:
            print(f"【BMP180初始化】未等到可用通信链路（设备 {device}），调度器将持续重试。")
            phase_message = "等待调度器开启（链路未就绪）"
            via_label = None

        try:
            await db.set_sensor_state(
                "BMP180",
                sensor_state="off",
                via=via_label,
                mode=DEFAULT_BMP180_MODE,
                phase="pending",
                phase_message=phase_message,
                phase_until=None,
                device_id=device
            )
        except Exception as e:
            print(f"【BMP180初始化】记录设备 {device} 状态失败：{e}")

    ensure_bmp180_cycle_started()


async def initialize_bh1750_on_startup():
    """等待通信链路就绪后初始化BH1750，将状态交给调度器统一开启。"""
    db = get_db_manager()
    ordered_devices = get_managed_mq2_devices()

    for device in ordered_devices:
        prefer = "BLE" if (device == "D01" and ble_or_mqtt_first == 0) else "MQTT"
        transport = await wait_for_startup_transport(prefer)
        if transport:
            print(f"【BH1750初始化】通信链路 {transport} 已就绪（设备 {device}），交由调度器开启 BH1750。")
            phase_message = f"等待调度器开启（链路：{transport}）"
            via_label = transport
        else:
            print(f"【BH1750初始化】未等到可用通信链路（设备 {device}），调度器将持续重试。")
            phase_message = "等待调度器开启（链路未就绪）"
            via_label = None

        try:
            await db.set_sensor_state(
                "BH1750",
                sensor_state="off",
                via=via_label,
                mode=DEFAULT_BH1750_MODE,
                phase="pending",
                phase_message=phase_message,
                phase_until=None,
                device_id=device
            )
        except Exception as e:
            print(f"【BH1750初始化】记录设备 {device} 状态失败：{e}")

    ensure_bh1750_cycle_started()


def get_mq2_mode_config(mode_key: str):
    return MQ2_MODE_CONFIG.get(mode_key, MQ2_MODE_CONFIG[DEFAULT_MQ2_MODE])


def get_bmp180_mode_config(mode_key: str):
    return MQ2_MODE_CONFIG.get(mode_key, MQ2_MODE_CONFIG[DEFAULT_BMP180_MODE])


def get_bh1750_mode_config(mode_key: str):
    return MQ2_MODE_CONFIG.get(mode_key, MQ2_MODE_CONFIG[DEFAULT_BH1750_MODE])


async def wait_for_cycle_signal(timeout: float, device_id: str = "D01"):
    """
    在循环中等待调度唤醒或超时。
    """
    if timeout <= 0:
        return
    device_id = (device_id or "D01").upper()
    event = mq2_cycle_wakeups.setdefault(device_id, asyncio.Event())
    try:
        await asyncio.wait_for(event.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        pass
    else:
        event.clear()


async def apply_mq2_phase(db, mode_key: str, target_phase: str, config: dict, duration: Optional[int],
                          device_id: str = "D01"):
    """
    根据目标阶段发送开启/关闭命令，并写入数据库状态。
    """
    command = "ONMQ2" if target_phase == "on" else "OFFMQ2"
    result = await send_command_ble_or_mqtt(command, device_id=device_id)
    if not result.get("success"):
        message = f"{'开启' if target_phase == 'on' else '关闭'}失败：{result.get('error', '未知错误')}"
        await db.set_sensor_state(
            "MQ2",
            phase="error",
            phase_message=message,
            phase_until=None,
            device_id=device_id
        )
        print(f"【MQ2调度】❌ {message}")
        return False

    phase_until = time.time() + duration if duration else None
    status_text = "供电中" if target_phase == "on" else "休眠中"
    await db.set_sensor_state(
        "MQ2",
        sensor_state=target_phase,
        via=result.get("via"),
        mode=mode_key,
        phase=target_phase,
        phase_message=f"{config['name']} · {status_text}",
        phase_until=phase_until,
        next_run_time=phase_until,
        device_id=device_id
    )
    label = "开启" if target_phase == "on" else "关闭"
    print(
        f"【MQ2调度】✓ {config['name']} {label}成功，下一次在 {('%.0f秒后' % duration) if duration else '持续运行'} 切换")
    return True


async def mq2_cycle_manager(device_id: str):
    """
    简易供电调度器：根据模式在开/关之间循环。
    """
    db = get_db_manager()
    device_id = (device_id or "D01").upper()
    print(f"【MQ2调度】简单供电调度器已启动（设备 {device_id}）")

    while True:
        try:
            record = await db.get_sensor_state("MQ2", device_id=device_id)
            if not record:
                await db.set_sensor_state(
                    "MQ2",
                    "on",
                    mode=DEFAULT_MQ2_MODE,
                    phase="pending",
                    phase_message="等待调度",
                    phase_until=None,
                    device_id=device_id
                )
                await asyncio.sleep(2)
                continue

            mode = record.get("mode") or DEFAULT_MQ2_MODE
            if mode not in MQ2_MODE_CONFIG:
                mode = DEFAULT_MQ2_MODE
                await db.set_sensor_state("MQ2", mode=mode, device_id=device_id)

            config = get_mq2_mode_config(mode)
            phase = (record.get("phase") or "pending").lower()
            phase_until = record.get("phase_until")
            state_device_id = record.get("device_id") or device_id

            if phase == "manual":
                # 手动关闭期间保持关闭状态
                await db.set_sensor_state(
                    "MQ2",
                    sensor_state="off",
                    phase="manual",
                    phase_message=record.get("phase_message") or "手动关闭",
                    phase_until=None,
                    next_run_time=None,
                    device_id=state_device_id
                )
                await wait_for_cycle_signal(5, device_id=device_id)
                continue

            if config.get("always_on"):
                if phase != "on" or record.get("sensor_state") != "on":
                    await apply_mq2_phase(db, mode, "on", config, duration=None, device_id=state_device_id)
                    continue
                await wait_for_cycle_signal(10, device_id=device_id)
                continue

            if phase not in ("on", "off") or not phase_until:
                if await apply_mq2_phase(db, mode, "on", config, config["on_duration"], device_id=state_device_id):
                    continue
                await wait_for_cycle_signal(5, device_id=device_id)
                continue

            now = time.time()
            if now >= phase_until - 0.2:
                next_phase = "off" if phase == "on" else "on"
                duration = config["on_duration"] if next_phase == "on" else config["off_duration"]
                if await apply_mq2_phase(db, mode, next_phase, config, duration, device_id=state_device_id):
                    continue
                await wait_for_cycle_signal(5, device_id=device_id)
                continue

            sleep_for = max(1, min(5, phase_until - now))
            await wait_for_cycle_signal(sleep_for, device_id=device_id)
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"【MQ2调度】❌ 调度器错误（设备 {device_id}）：{e}")
            import traceback
            traceback.print_exc()
            await wait_for_cycle_signal(5, device_id=device_id)

    print(f"【MQ2调度】简单供电调度器已停止（设备 {device_id}）")


# ============ BMP180 调度器 ============
async def apply_bmp180_phase(db, mode_key: str, target_phase: str, config: dict, duration: Optional[int],
                             device_id: str = "D01"):
    """根据目标阶段发送开启/关闭命令，并写入数据库状态。"""
    command = "ONBMP180" if target_phase == "on" else "OFFBMP180"
    result = await send_command_ble_or_mqtt(command, device_id=device_id)
    if not result.get("success"):
        message = f"{'开启' if target_phase == 'on' else '关闭'}失败：{result.get('error', '未知错误')}"
        await db.set_sensor_state(
            "BMP180",
            phase="error",
            phase_message=message,
            phase_until=None,
            device_id=device_id
        )
        print(f"【BMP180调度】❌ {message}")
        return False

    phase_until = time.time() + duration if duration else None
    status_text = "供电中" if target_phase == "on" else "休眠中"
    await db.set_sensor_state(
        "BMP180",
        sensor_state=target_phase,
        via=result.get("via"),
        mode=mode_key,
        phase=target_phase,
        phase_message=f"{config['name']} · {status_text}",
        phase_until=phase_until,
        next_run_time=phase_until,
        device_id=device_id
    )
    label = "开启" if target_phase == "on" else "关闭"
    print(f"【BMP180调度】✓ {config['name']} {label}成功，下一次在 {('%.0f秒后' % duration) if duration else '持续运行'} 切换")
    return True


async def wait_for_bmp180_cycle_signal(timeout: float, device_id: str = "D01"):
    """在循环中等待调度唤醒或超时。"""
    if timeout <= 0:
        return
    device_id = (device_id or "D01").upper()
    event = bmp180_cycle_wakeups.setdefault(device_id, asyncio.Event())
    try:
        await asyncio.wait_for(event.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        pass
    else:
        event.clear()


def wake_bmp180_cycle(device_id: str = "D01"):
    """唤醒BMP180调度器。"""
    device_id = (device_id or "D01").upper()
    event = bmp180_cycle_wakeups.get(device_id)
    if event:
        event.set()


async def bmp180_cycle_manager(device_id: str):
    """简易供电调度器：根据模式在开/关之间循环。"""
    db = get_db_manager()
    device_id = (device_id or "D01").upper()
    print(f"【BMP180调度】简单供电调度器已启动（设备 {device_id}）")

    while True:
        try:
            record = await db.get_sensor_state("BMP180", device_id=device_id)
            if not record:
                await db.set_sensor_state(
                    "BMP180",
                    "on",
                    mode=DEFAULT_BMP180_MODE,
                    phase="pending",
                    phase_message="等待调度",
                    phase_until=None,
                    device_id=device_id
                )
                await asyncio.sleep(2)
                continue

            mode = record.get("mode") or DEFAULT_BMP180_MODE
            if mode not in MQ2_MODE_CONFIG:
                mode = DEFAULT_BMP180_MODE
                await db.set_sensor_state("BMP180", mode=mode, device_id=device_id)

            config = get_bmp180_mode_config(mode)
            phase = (record.get("phase") or "pending").lower()
            phase_until = record.get("phase_until")
            state_device_id = record.get("device_id") or device_id

            if phase == "manual":
                await db.set_sensor_state(
                    "BMP180",
                    sensor_state="off",
                    phase="manual",
                    phase_message=record.get("phase_message") or "手动关闭",
                    phase_until=None,
                    next_run_time=None,
                    device_id=state_device_id
                )
                await wait_for_bmp180_cycle_signal(5, device_id=device_id)
                continue

            if config.get("always_on"):
                if phase != "on" or record.get("sensor_state") != "on":
                    await apply_bmp180_phase(db, mode, "on", config, duration=None, device_id=state_device_id)
                    continue
                await wait_for_bmp180_cycle_signal(10, device_id=device_id)
                continue

            if phase not in ("on", "off") or not phase_until:
                if await apply_bmp180_phase(db, mode, "on", config, config["on_duration"], device_id=state_device_id):
                    continue
                await wait_for_bmp180_cycle_signal(5, device_id=device_id)
                continue

            now = time.time()
            if now >= phase_until - 0.2:
                next_phase = "off" if phase == "on" else "on"
                duration = config["on_duration"] if next_phase == "on" else config["off_duration"]
                if await apply_bmp180_phase(db, mode, next_phase, config, duration, device_id=state_device_id):
                    continue
                await wait_for_bmp180_cycle_signal(5, device_id=device_id)
                continue

            sleep_for = max(1, min(5, phase_until - now))
            await wait_for_bmp180_cycle_signal(sleep_for, device_id=device_id)
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"【BMP180调度】❌ 调度器错误（设备 {device_id}）：{e}")
            import traceback
            traceback.print_exc()
            await wait_for_bmp180_cycle_signal(5, device_id=device_id)

    print(f"【BMP180调度】简单供电调度器已停止（设备 {device_id}）")


# ============ BH1750 调度器 ============
async def apply_bh1750_phase(db, mode_key: str, target_phase: str, config: dict, duration: Optional[int],
                              device_id: str = "D01"):
    """根据目标阶段发送开启/关闭命令，并写入数据库状态。"""
    command = "ONBH1750" if target_phase == "on" else "OFFBH1750"
    result = await send_command_ble_or_mqtt(command, device_id=device_id)
    if not result.get("success"):
        message = f"{'开启' if target_phase == 'on' else '关闭'}失败：{result.get('error', '未知错误')}"
        await db.set_sensor_state(
            "BH1750",
            phase="error",
            phase_message=message,
            phase_until=None,
            device_id=device_id
        )
        print(f"【BH1750调度】❌ {message}")
        return False

    phase_until = time.time() + duration if duration else None
    status_text = "供电中" if target_phase == "on" else "休眠中"
    await db.set_sensor_state(
        "BH1750",
        sensor_state=target_phase,
        via=result.get("via"),
        mode=mode_key,
        phase=target_phase,
        phase_message=f"{config['name']} · {status_text}",
        phase_until=phase_until,
        next_run_time=phase_until,
        device_id=device_id
    )
    label = "开启" if target_phase == "on" else "关闭"
    print(f"【BH1750调度】✓ {config['name']} {label}成功，下一次在 {('%.0f秒后' % duration) if duration else '持续运行'} 切换")
    return True


async def wait_for_bh1750_cycle_signal(timeout: float, device_id: str = "D01"):
    """在循环中等待调度唤醒或超时。"""
    if timeout <= 0:
        return
    device_id = (device_id or "D01").upper()
    event = bh1750_cycle_wakeups.setdefault(device_id, asyncio.Event())
    try:
        await asyncio.wait_for(event.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        pass
    else:
        event.clear()


def wake_bh1750_cycle(device_id: str = "D01"):
    """唤醒BH1750调度器。"""
    device_id = (device_id or "D01").upper()
    event = bh1750_cycle_wakeups.get(device_id)
    if event:
        event.set()


async def bh1750_cycle_manager(device_id: str):
    """简易供电调度器：根据模式在开/关之间循环。"""
    db = get_db_manager()
    device_id = (device_id or "D01").upper()
    print(f"【BH1750调度】简单供电调度器已启动（设备 {device_id}）")

    while True:
        try:
            record = await db.get_sensor_state("BH1750", device_id=device_id)
            if not record:
                await db.set_sensor_state(
                    "BH1750",
                    "on",
                    mode=DEFAULT_BH1750_MODE,
                    phase="pending",
                    phase_message="等待调度",
                    phase_until=None,
                    device_id=device_id
                )
                await asyncio.sleep(2)
                continue

            mode = record.get("mode") or DEFAULT_BH1750_MODE
            if mode not in MQ2_MODE_CONFIG:
                mode = DEFAULT_BH1750_MODE
                await db.set_sensor_state("BH1750", mode=mode, device_id=device_id)

            config = get_bh1750_mode_config(mode)
            phase = (record.get("phase") or "pending").lower()
            phase_until = record.get("phase_until")
            state_device_id = record.get("device_id") or device_id

            if phase == "manual":
                await db.set_sensor_state(
                    "BH1750",
                    sensor_state="off",
                    phase="manual",
                    phase_message=record.get("phase_message") or "手动关闭",
                    phase_until=None,
                    next_run_time=None,
                    device_id=state_device_id
                )
                await wait_for_bh1750_cycle_signal(5, device_id=device_id)
                continue

            if config.get("always_on"):
                if phase != "on" or record.get("sensor_state") != "on":
                    await apply_bh1750_phase(db, mode, "on", config, duration=None, device_id=state_device_id)
                    continue
                await wait_for_bh1750_cycle_signal(10, device_id=device_id)
                continue

            if phase not in ("on", "off") or not phase_until:
                if await apply_bh1750_phase(db, mode, "on", config, config["on_duration"], device_id=state_device_id):
                    continue
                await wait_for_bh1750_cycle_signal(5, device_id=device_id)
                continue

            now = time.time()
            if now >= phase_until - 0.2:
                next_phase = "off" if phase == "on" else "on"
                duration = config["on_duration"] if next_phase == "on" else config["off_duration"]
                if await apply_bh1750_phase(db, mode, next_phase, config, duration, device_id=state_device_id):
                    continue
                await wait_for_bh1750_cycle_signal(5, device_id=device_id)
                continue

            sleep_for = max(1, min(5, phase_until - now))
            await wait_for_bh1750_cycle_signal(sleep_for, device_id=device_id)
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"【BH1750调度】❌ 调度器错误（设备 {device_id}）：{e}")
            import traceback
            traceback.print_exc()
            await wait_for_bh1750_cycle_signal(5, device_id=device_id)

    print(f"【BH1750调度】简单供电调度器已停止（设备 {device_id}）")


@app.post("/api/mq2/switch", tags=["设备控制"])
async def switch_mq2(request: Request):
    """
    切换MQ2传感器开关。
    请求体JSON: {"action":"on"} 或 {"action":"off"}
    - on  -> 发送 "ONMQ2"
    - off -> 发送 "OFFMQ2"
    优先通过BLE发送；若BLE未连接或失败则通过MQTT发送到命令主题。
    """
    try:
        body = await request.json()
        action = (body.get("action") or "").strip().lower()
        if action not in ("on", "off"):
            return {"success": False, "error": "参数错误：action 仅支持 on/off"}

        device_id = (body.get("device_id") or "D01").upper()

        command = "ONMQ2" if action == "on" else "OFFMQ2"
        result = await send_command_ble_or_mqtt(command, device_id=device_id)
        db = get_db_manager()
        state_record = None

        if result.get("success"):
            try:
                if action == "off":
                    await db.set_sensor_state(
                        "MQ2",
                        "off",
                        result.get("via"),
                        phase="manual",
                        phase_message="手动关闭",
                        phase_until=None,
                        next_run_time=None,
                        device_id=device_id
                    )
                else:
                    await db.set_sensor_state(
                        "MQ2",
                        "on",
                        result.get("via"),
                        phase="pending",
                        phase_message="手动开启，等待调度",
                        phase_until=None,
                        device_id=device_id
                    )
            except Exception as e:
                print(f"【控制】保存MQ2状态失败：{e}")
            finally:
                state_record = await db.get_sensor_state("MQ2", device_id=device_id)
            wake_mq2_cycle(device_id)
            return {
                "success": True,
                "action": action,
                "command": command,
                "via": result.get("via"),
                "topic": result.get("topic"),
                "state": (state_record or {}).get("sensor_state", action),
                "updated_at": (state_record or {}).get("updated_at"),
                "last_via": (state_record or {}).get("last_via"),
                "device_id": device_id
            }
        else:
            state_record = await db.get_sensor_state("MQ2", device_id=device_id)
            return {
                "success": False,
                "action": action,
                "command": command,
                "error": result.get("error", "未知错误"),
                "via": result.get("via"),
                "state": (state_record or {}).get("sensor_state"),
                "updated_at": (state_record or {}).get("updated_at"),
                "last_via": (state_record or {}).get("last_via"),
                "device_id": device_id
            }
    except Exception as e:
        print(f"【API】切换MQ2失败：{e}")
        return {"success": False, "error": str(e)}


@app.get("/api/mq2/state", tags=["设备控制"])
async def get_mq2_state(device_id: str = "D01"):
    """
    获取MQ2传感器当前的开关状态与模式
    """
    try:
        device_id = (device_id or "D01").upper()
        db = get_db_manager()
        record = await db.get_sensor_state("MQ2", device_id=device_id)
        if record:
            mode = record.get("mode") or DEFAULT_MQ2_MODE
            config = get_mq2_mode_config(mode)
            phase_until = record.get("phase_until")
            next_switch_in_sec = None
            if phase_until:
                next_switch_in_sec = max(0, int(phase_until - time.time()))
            last_value = record.get("last_value")
            return {
                "success": True,
                "state": record.get("sensor_state", "on"),
                "mode": mode,
                "mode_name": config["name"],
                "mode_icon": config["icon"],
                "mode_on_sec": config.get("on_duration"),
                "mode_off_sec": config.get("off_duration"),
                "phase": record.get("phase"),
                "phase_message": record.get("phase_message"),
                "phase_until": phase_until,
                "next_switch_in_sec": next_switch_in_sec,
                "last_value": float(last_value) if last_value is not None else None,
                "updated_at": record.get("updated_at"),
                "last_via": record.get("last_via"),
                "device_id": record.get("device_id") or device_id
            }
        default_config = get_mq2_mode_config(DEFAULT_MQ2_MODE)
        return {
            "success": True,
            "state": "on",
            "mode": DEFAULT_MQ2_MODE,
            "mode_name": default_config["name"],
            "mode_icon": default_config["icon"],
            "mode_on_sec": default_config.get("on_duration"),
            "mode_off_sec": default_config.get("off_duration"),
            "phase": "on",
            "phase_message": "默认模式运行中",
            "phase_until": None,
            "next_switch_in_sec": None,
            "last_value": None,
            "updated_at": None,
            "last_via": None,
            "device_id": device_id
        }
    except Exception as e:
        print(f"【API】获取MQ2状态失败：{e}")
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


@app.post("/api/mq2/mode", tags=["设备控制"])
async def set_mq2_mode(request: Request):
    """
    设置MQ2运行模式：eco/balance/safe/always
    """
    try:
        body = await request.json()
        mode = (body.get("mode") or "").strip().lower()
        if mode not in MQ2_MODE_CONFIG:
            return {
                "success": False,
                "error": f"无效的模式：{mode}，可选：{', '.join(MQ2_MODE_CONFIG.keys())}"
            }
        device_id = (body.get("device_id") or "D01").upper()
        db = get_db_manager()
        await db.set_sensor_state(
            "MQ2",
            sensor_state=None,
            mode=mode,
            phase="pending",
            phase_message="模式切换中",
            phase_until=None,
            device_id=device_id
        )
        wake_mq2_cycle(device_id)
        config = get_mq2_mode_config(mode)
        return {
            "success": True,
            "mode": mode,
            "mode_name": config["name"],
            "mode_icon": config["icon"],
            "mode_on_sec": config.get("on_duration"),
            "mode_off_sec": config.get("off_duration"),
            "device_id": device_id
        }
    except Exception as e:
        print(f"【API】设置MQ2模式失败：{e}")
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


# ============ BMP180 API ============
@app.post("/api/bmp180/switch", tags=["设备控制"])
async def switch_bmp180(request: Request):
    """切换BMP180传感器开关。"""
    try:
        body = await request.json()
        action = (body.get("action") or "").strip().lower()
        if action not in ("on", "off"):
            return {"success": False, "error": "参数错误：action 仅支持 on/off"}

        device_id = (body.get("device_id") or "D01").upper()
        command = "ONBMP180" if action == "on" else "OFFBMP180"
        result = await send_command_ble_or_mqtt(command, device_id=device_id)
        db = get_db_manager()
        state_record = None

        if result.get("success"):
            try:
                if action == "off":
                    await db.set_sensor_state(
                        "BMP180",
                        "off",
                        result.get("via"),
                        phase="manual",
                        phase_message="手动关闭",
                        phase_until=None,
                        next_run_time=None,
                        device_id=device_id
                    )
                else:
                    await db.set_sensor_state(
                        "BMP180",
                        "on",
                        result.get("via"),
                        phase="pending",
                        phase_message="手动开启，等待调度",
                        phase_until=None,
                        device_id=device_id
                    )
            except Exception as e:
                print(f"【控制】保存BMP180状态失败：{e}")
            finally:
                state_record = await db.get_sensor_state("BMP180", device_id=device_id)
            wake_bmp180_cycle(device_id)
            return {
                "success": True,
                "action": action,
                "command": command,
                "via": result.get("via"),
                "topic": result.get("topic"),
                "state": (state_record or {}).get("sensor_state", action),
                "updated_at": (state_record or {}).get("updated_at"),
                "last_via": (state_record or {}).get("last_via"),
                "device_id": device_id
            }
        else:
            state_record = await db.get_sensor_state("BMP180", device_id=device_id)
            return {
                "success": False,
                "action": action,
                "command": command,
                "error": result.get("error", "未知错误"),
                "via": result.get("via"),
                "state": (state_record or {}).get("sensor_state"),
                "updated_at": (state_record or {}).get("updated_at"),
                "last_via": (state_record or {}).get("last_via"),
                "device_id": device_id
            }
    except Exception as e:
        print(f"【API】切换BMP180失败：{e}")
        return {"success": False, "error": str(e)}


@app.get("/api/bmp180/state", tags=["设备控制"])
async def get_bmp180_state(device_id: str = "D01"):
    """获取BMP180传感器当前的开关状态与模式"""
    try:
        device_id = (device_id or "D01").upper()
        db = get_db_manager()
        record = await db.get_sensor_state("BMP180", device_id=device_id)
        if record:
            mode = record.get("mode") or DEFAULT_BMP180_MODE
            config = get_bmp180_mode_config(mode)
            phase_until = record.get("phase_until")
            next_switch_in_sec = None
            if phase_until:
                next_switch_in_sec = max(0, int(phase_until - time.time()))
            last_value = record.get("last_value")
            return {
                "success": True,
                "state": record.get("sensor_state", "on"),
                "mode": mode,
                "mode_name": config["name"],
                "mode_icon": config["icon"],
                "mode_on_sec": config.get("on_duration"),
                "mode_off_sec": config.get("off_duration"),
                "phase": record.get("phase"),
                "phase_message": record.get("phase_message"),
                "phase_until": phase_until,
                "next_switch_in_sec": next_switch_in_sec,
                "last_value": float(last_value) if last_value is not None else None,
                "updated_at": record.get("updated_at"),
                "last_via": record.get("last_via"),
                "device_id": record.get("device_id") or device_id
            }
        default_config = get_bmp180_mode_config(DEFAULT_BMP180_MODE)
        return {
            "success": True,
            "state": "on",
            "mode": DEFAULT_BMP180_MODE,
            "mode_name": default_config["name"],
            "mode_icon": default_config["icon"],
            "mode_on_sec": default_config.get("on_duration"),
            "mode_off_sec": default_config.get("off_duration"),
            "phase": "on",
            "phase_message": "默认模式运行中",
            "phase_until": None,
            "next_switch_in_sec": None,
            "last_value": None,
            "updated_at": None,
            "last_via": None,
            "device_id": device_id
        }
    except Exception as e:
        print(f"【API】获取BMP180状态失败：{e}")
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


@app.post("/api/bmp180/mode", tags=["设备控制"])
async def set_bmp180_mode(request: Request):
    """设置BMP180运行模式：eco/balance/safe/always/dev"""
    try:
        body = await request.json()
        mode = (body.get("mode") or "").strip().lower()
        if mode not in MQ2_MODE_CONFIG:
            return {
                "success": False,
                "error": f"无效的模式：{mode}，可选：{', '.join(MQ2_MODE_CONFIG.keys())}"
            }
        device_id = (body.get("device_id") or "D01").upper()
        db = get_db_manager()
        await db.set_sensor_state(
            "BMP180",
            sensor_state=None,
            mode=mode,
            phase="pending",
            phase_message="模式切换中",
            phase_until=None,
            device_id=device_id
        )
        wake_bmp180_cycle(device_id)
        config = get_bmp180_mode_config(mode)
        return {
            "success": True,
            "mode": mode,
            "mode_name": config["name"],
            "mode_icon": config["icon"],
            "mode_on_sec": config.get("on_duration"),
            "mode_off_sec": config.get("off_duration"),
            "device_id": device_id
        }
    except Exception as e:
        print(f"【API】设置BMP180模式失败：{e}")
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


# ============ BH1750 API ============
@app.post("/api/bh1750/switch", tags=["设备控制"])
async def switch_bh1750(request: Request):
    """切换BH1750传感器开关。"""
    try:
        body = await request.json()
        action = (body.get("action") or "").strip().lower()
        if action not in ("on", "off"):
            return {"success": False, "error": "参数错误：action 仅支持 on/off"}

        device_id = (body.get("device_id") or "D01").upper()
        command = "ONBH1750" if action == "on" else "OFFBH1750"
        result = await send_command_ble_or_mqtt(command, device_id=device_id)
        db = get_db_manager()
        state_record = None

        if result.get("success"):
            try:
                if action == "off":
                    await db.set_sensor_state(
                        "BH1750",
                        "off",
                        result.get("via"),
                        phase="manual",
                        phase_message="手动关闭",
                        phase_until=None,
                        next_run_time=None,
                        device_id=device_id
                    )
                else:
                    await db.set_sensor_state(
                        "BH1750",
                        "on",
                        result.get("via"),
                        phase="pending",
                        phase_message="手动开启，等待调度",
                        phase_until=None,
                        device_id=device_id
                    )
            except Exception as e:
                print(f"【控制】保存BH1750状态失败：{e}")
            finally:
                state_record = await db.get_sensor_state("BH1750", device_id=device_id)
            wake_bh1750_cycle(device_id)
            return {
                "success": True,
                "action": action,
                "command": command,
                "via": result.get("via"),
                "topic": result.get("topic"),
                "state": (state_record or {}).get("sensor_state", action),
                "updated_at": (state_record or {}).get("updated_at"),
                "last_via": (state_record or {}).get("last_via"),
                "device_id": device_id
            }
        else:
            state_record = await db.get_sensor_state("BH1750", device_id=device_id)
            return {
                "success": False,
                "action": action,
                "command": command,
                "error": result.get("error", "未知错误"),
                "via": result.get("via"),
                "state": (state_record or {}).get("sensor_state"),
                "updated_at": (state_record or {}).get("updated_at"),
                "last_via": (state_record or {}).get("last_via"),
                "device_id": device_id
            }
    except Exception as e:
        print(f"【API】切换BH1750失败：{e}")
        return {"success": False, "error": str(e)}


@app.get("/api/bh1750/state", tags=["设备控制"])
async def get_bh1750_state(device_id: str = "D01"):
    """获取BH1750传感器当前的开关状态与模式"""
    try:
        device_id = (device_id or "D01").upper()
        db = get_db_manager()
        record = await db.get_sensor_state("BH1750", device_id=device_id)
        if record:
            mode = record.get("mode") or DEFAULT_BH1750_MODE
            config = get_bh1750_mode_config(mode)
            phase_until = record.get("phase_until")
            next_switch_in_sec = None
            if phase_until:
                next_switch_in_sec = max(0, int(phase_until - time.time()))
            last_value = record.get("last_value")
            return {
                "success": True,
                "state": record.get("sensor_state", "on"),
                "mode": mode,
                "mode_name": config["name"],
                "mode_icon": config["icon"],
                "mode_on_sec": config.get("on_duration"),
                "mode_off_sec": config.get("off_duration"),
                "phase": record.get("phase"),
                "phase_message": record.get("phase_message"),
                "phase_until": phase_until,
                "next_switch_in_sec": next_switch_in_sec,
                "last_value": float(last_value) if last_value is not None else None,
                "updated_at": record.get("updated_at"),
                "last_via": record.get("last_via"),
                "device_id": record.get("device_id") or device_id
            }
        default_config = get_bh1750_mode_config(DEFAULT_BH1750_MODE)
        return {
            "success": True,
            "state": "on",
            "mode": DEFAULT_BH1750_MODE,
            "mode_name": default_config["name"],
            "mode_icon": default_config["icon"],
            "mode_on_sec": default_config.get("on_duration"),
            "mode_off_sec": default_config.get("off_duration"),
            "phase": "on",
            "phase_message": "默认模式运行中",
            "phase_until": None,
            "next_switch_in_sec": None,
            "last_value": None,
            "updated_at": None,
            "last_via": None,
            "device_id": device_id
        }
    except Exception as e:
        print(f"【API】获取BH1750状态失败：{e}")
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


@app.post("/api/bh1750/mode", tags=["设备控制"])
async def set_bh1750_mode(request: Request):
    """设置BH1750运行模式：eco/balance/safe/always/dev"""
    try:
        body = await request.json()
        mode = (body.get("mode") or "").strip().lower()
        if mode not in MQ2_MODE_CONFIG:
            return {
                "success": False,
                "error": f"无效的模式：{mode}，可选：{', '.join(MQ2_MODE_CONFIG.keys())}"
            }
        device_id = (body.get("device_id") or "D01").upper()
        db = get_db_manager()
        await db.set_sensor_state(
            "BH1750",
            sensor_state=None,
            mode=mode,
            phase="pending",
            phase_message="模式切换中",
            phase_until=None,
            device_id=device_id
        )
        wake_bh1750_cycle(device_id)
        config = get_bh1750_mode_config(mode)
        return {
            "success": True,
            "mode": mode,
            "mode_name": config["name"],
            "mode_icon": config["icon"],
            "mode_on_sec": config.get("on_duration"),
            "mode_off_sec": config.get("off_duration"),
            "device_id": device_id
        }
    except Exception as e:
        print(f"【API】设置BH1750模式失败：{e}")
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


# ============ BLE API ============
@app.post("/api/ble/switch", tags=["设备控制"])
async def switch_ble(request: Request):
    """切换BLE蓝牙开关。"""
    try:
        body = await request.json()
        action = (body.get("action") or "").strip().lower()
        if action not in ("on", "off"):
            return {"success": False, "error": "参数错误：action 仅支持 on/off"}

        device_id = (body.get("device_id") or "D01").upper()
        command = "ONBLE" if action == "on" else "OFFBLE"
        result = await send_command_ble_or_mqtt(command, device_id=device_id)
        db = get_db_manager()

        if result.get("success"):
            try:
                await db.set_sensor_state(
                    "BLE",
                    "on" if action == "on" else "off",
                    result.get("via"),
                    device_id=device_id
                )
            except Exception as e:
                print(f"【控制】保存BLE状态失败：{e}")
            return {
                "success": True,
                "action": action,
                "command": command,
                "via": result.get("via"),
                "topic": result.get("topic"),
                "device_id": device_id
            }
        else:
            return {
                "success": False,
                "action": action,
                "command": command,
                "error": result.get("error", "未知错误"),
                "via": result.get("via"),
                "device_id": device_id
            }
    except Exception as e:
        print(f"【API】切换BLE失败：{e}")
        return {"success": False, "error": str(e)}


@app.get("/api/ble/state", tags=["设备控制"])
async def get_ble_state(device_id: str = "D01"):
    """获取BLE蓝牙状态"""
    try:
        device_id = (device_id or "D01").upper()
        db = get_db_manager()
        record = await db.get_sensor_state("BLE", device_id=device_id)
        if record:
            return {
                "success": True,
                "state": record.get("sensor_state", "on"),
                "updated_at": record.get("updated_at"),
                "last_via": record.get("last_via"),
                "device_id": record.get("device_id") or device_id
            }
        return {
            "success": True,
            "state": "on",
            "updated_at": None,
            "last_via": None,
            "device_id": device_id
        }
    except Exception as e:
        print(f"【API】获取BLE状态失败：{e}")
        return {"success": False, "error": str(e)}


# ============ OLED API ============
@app.post("/api/oled/switch", tags=["设备控制"])
async def switch_oled(request: Request):
    """切换OLED显示屏开关。"""
    try:
        body = await request.json()
        action = (body.get("action") or "").strip().lower()
        if action not in ("on", "off"):
            return {"success": False, "error": "参数错误：action 仅支持 on/off"}

        device_id = (body.get("device_id") or "D01").upper()
        command = "ONOLED" if action == "on" else "OFFOLED"
        result = await send_command_ble_or_mqtt(command, device_id=device_id)
        db = get_db_manager()

        if result.get("success"):
            try:
                await db.set_sensor_state(
                    "OLED",
                    "on" if action == "on" else "off",
                    result.get("via"),
                    device_id=device_id
                )
            except Exception as e:
                print(f"【控制】保存OLED状态失败：{e}")
            return {
                "success": True,
                "action": action,
                "command": command,
                "via": result.get("via"),
                "topic": result.get("topic"),
                "device_id": device_id
            }
        else:
            return {
                "success": False,
                "action": action,
                "command": command,
                "error": result.get("error", "未知错误"),
                "via": result.get("via"),
                "device_id": device_id
            }
    except Exception as e:
        print(f"【API】切换OLED失败：{e}")
        return {"success": False, "error": str(e)}


@app.get("/api/oled/state", tags=["设备控制"])
async def get_oled_state(device_id: str = "D01"):
    """获取OLED显示屏状态"""
    try:
        device_id = (device_id or "D01").upper()
        db = get_db_manager()
        record = await db.get_sensor_state("OLED", device_id=device_id)
        if record:
            return {
                "success": True,
                "state": record.get("sensor_state", "on"),
                "updated_at": record.get("updated_at"),
                "last_via": record.get("last_via"),
                "device_id": record.get("device_id") or device_id
            }
        return {
            "success": True,
            "state": "on",
            "updated_at": None,
            "last_via": None,
            "device_id": device_id
        }
    except Exception as e:
        print(f"【API】获取OLED状态失败：{e}")
        return {"success": False, "error": str(e)}


# 数据分析页面
@app.get("/analysis.html", tags=["数据分析页"])
async def analysis_page():
    analysis_file = WEB_DIR / "analysis.html"
    if not analysis_file.exists():
        return Response("未找到 web/analysis.html", status_code=404)
    return FileResponse(
        str(analysis_file),
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"}
    )


# API：获取历史数据
@app.get("/api/history", tags=["加载数据"])
async def get_history(limit: int = 1000, device_id: Optional[str] = None):
    """
    获取历史数据
    参数:
        limit: 获取的数据条数，默认1000条，传入-1表示全部数据（会自动使用聚合）
        device_id: 设备ID筛选（可选），如：D01, D02
    """
    try:
        db = get_db_manager()

        # 如果limit为-1，使用时间范围查询并自动聚合
        if limit == -1:
            stats = await db.get_statistics(device_id=device_id)
            if stats and stats['total_records']:
                total = int(stats['total_records'])
                print(f"【API】请求加载全部数据，共 {total} 条，将使用聚合模式")

                # 获取时间范围
                first_record = stats.get('first_record')
                last_record = stats.get('last_record')

                if first_record and last_record:
                    # 转换为时间戳
                    import datetime
                    if isinstance(first_record, datetime.datetime):
                        start_time = first_record.timestamp()
                    else:
                        start_time = float(first_record)

                    if isinstance(last_record, datetime.datetime):
                        end_time = last_record.timestamp()
                    else:
                        end_time = float(last_record)

                    # 使用聚合查询
                    time_span = end_time - start_time
                    # 根据数据密度动态调整目标点数
                    # 计算数据密度（条/秒）
                    data_density = total / time_span if time_span > 0 else 0

                    # 根据数据密度和目标点数计算间隔
                    # 如果数据密度高（>1条/秒），保留更多数据点（5-10%）
                    # 如果数据密度低（<1条/秒），保留较少数据点（但至少5000个点）
                    if data_density > 1:
                        # 高密度数据，保留5-10%
                        target_points = min(20000, max(10000, int(total * 0.08)))  # 保留8%的数据点，最少10000，最多20000
                    else:
                        # 低密度数据，根据时间跨度计算
                        target_points = min(15000, max(8000, int(total * 0.05)))  # 保留5%的数据点，最少8000，最多15000

                    # 计算精确的间隔（不强制向上取整）
                    interval = max(10, int(time_span / target_points))  # 最小10秒

                    # 将间隔调整为接近的合理值，但允许更小的间隔
                    # 使用更精细的间隔选择，不要过度向上取整
                    if interval <= 10:
                        interval = 10
                    elif interval <= 30:
                        interval = 30
                    elif interval <= 60:
                        interval = 60
                    elif interval <= 120:
                        interval = 120
                    elif interval <= 180:
                        interval = 180
                    elif interval <= 300:
                        interval = 300
                    elif interval <= 600:
                        interval = 600
                    elif interval <= 1200:
                        interval = 1200
                    elif interval <= 1800:
                        interval = 1800
                    elif interval <= 3600:
                        interval = 3600
                    else:
                        # 如果计算出的间隔太大，限制在3600秒（1小时）
                        interval = min(3600, interval)

                    print(
                        f"【API】数据密度：{data_density:.2f} 条/秒，目标点数：{target_points}，计算间隔：{int(time_span / target_points)}秒，实际间隔：{interval}秒")

                    print(f"【API】使用聚合模式，间隔：{interval}秒")
                    data = await db.get_aggregated_data(start_time, end_time, interval, device_id=device_id)

                    # 转换为前端需要的格式
                    readings = []
                    for row in data:
                        readings.append({
                            "type": "reading",
                            "ts": float(row['timestamp']),
                            "temp": float(row['temperature']) if row['temperature'] is not None else None,
                            "hum": float(row['humidity']) if row['humidity'] is not None else None,
                            "lux": float(row['brightness']) if row['brightness'] is not None else None,
                            "smoke": float(row['smoke_ppm']) if row['smoke_ppm'] is not None else None,
                            "pressure": float(row['pressure']) if row['pressure'] is not None else None,
                            "temp2": float(row['temp2']) if row['temp2'] is not None else None,
                            "rs_ro": float(row['rs_ro']) if row['rs_ro'] is not None else None,
                            "device_id": device_id,  # 添加设备ID（如果提供了筛选参数）
                            "_aggregated": True,
                            "_interval": interval,
                            "_original_count": int(row['data_count']) if row.get('data_count') else 0
                        })

                    print(f"【API】返回 {len(readings)} 条聚合数据（原始数据 {total} 条）")
                    return {
                        "success": True,
                        "data": readings,
                        "count": len(readings),
                        "aggregated": True,
                        "original_count": total,
                        "interval": interval
                    }
                else:
                    data = []
            else:
                data = []
        else:
            # 获取最近N条，需要先降序取N条，再升序排列
            data = await db.get_recent_data(limit, device_id=device_id)
            # 数据是[新->旧]，需要反转成[旧->新]
            data = list(reversed(data))

        # 转换为前端需要的格式
        readings = []
        for row in data:
            readings.append({
                "type": "reading",
                "ts": row['timestamp'],
                "temp": float(row['temperature']),
                "hum": float(row['humidity']),
                "lux": float(row['brightness']) if row['brightness'] is not None else None,
                "smoke": float(row['smoke_ppm']) if row['smoke_ppm'] is not None else None,
                "pressure": float(row['pressure']) if row['pressure'] is not None else None,
                "temp2": float(row['temp2']) if row.get('temp2') is not None else None,
                "rs_ro": float(row['rs_ro']) if row.get('rs_ro') is not None else None,
                "device_id": row.get('device_id') or device_id
            })

        print(f"【API】返回 {len(readings)} 条历史数据")
        return {"success": True, "data": readings, "count": len(readings)}
    except Exception as e:
        print(f"【API】获取历史数据失败：{e}")
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e), "data": []}


# API：按时间范围获取历史数据（智能聚合）
@app.get("/api/history/range", tags=["加载数据"])
async def get_history_by_range(start: float, end: float, aggregate: bool = None, interval: int = None,
                               device_id: Optional[str] = None):
    """
    按时间范围获取历史数据，自动根据数据量决定是否聚合
    参数:
        start: 起始时间戳（秒）
        end: 结束时间戳（秒）
        aggregate: 是否强制使用聚合（None=自动判断，True=强制聚合，False=强制不聚合）
        interval: 聚合间隔（秒），默认自动计算
        device_id: 设备ID筛选（可选），如：D01, D02
    """
    try:
        db = get_db_manager()
        print(f"【API】请求时间范围数据：{start} ~ {end}")

        # 先统计数据量
        data_count = await db.count_data_by_time_range(start, end, device_id=device_id)
        device_info = f" [设备: {device_id}]" if device_id else ""
        print(f"【API】时间范围内共有 {data_count} 条数据{device_info}")

        # 数据量阈值：超过5000条自动使用聚合
        AUTO_AGGREGATE_THRESHOLD = 5000
        use_aggregate = aggregate if aggregate is not None else (data_count > AUTO_AGGREGATE_THRESHOLD)

        if use_aggregate:
            # 计算合适的聚合间隔（目标：将数据聚合到约8000-20000个点，保留更多细节）
            if interval is None:
                time_span = end - start
                if data_count > 0:
                    # 根据数据密度动态调整目标点数
                    # 计算数据密度（条/秒）
                    data_density = data_count / time_span if time_span > 0 else 0

                    # 根据数据密度和目标点数计算间隔
                    # 如果数据密度高（>1条/秒），保留更多数据点（5-10%）
                    # 如果数据密度低（<1条/秒），保留较少数据点（但至少8000个点）
                    if data_density > 1:
                        # 高密度数据，保留5-10%
                        target_points = min(20000, max(10000, int(data_count * 0.08)))  # 保留8%的数据点，最少10000，最多20000
                    else:
                        # 低密度数据，根据时间跨度计算
                        target_points = min(15000, max(8000, int(data_count * 0.05)))  # 保留5%的数据点，最少8000，最多15000

                    # 计算精确的间隔（不强制向上取整）
                    interval = max(10, int(time_span / target_points))  # 最小10秒

                    # 将间隔调整为接近的合理值，但允许更小的间隔
                    # 使用更精细的间隔选择，不要过度向上取整
                    if interval <= 10:
                        interval = 10
                    elif interval <= 30:
                        interval = 30
                    elif interval <= 60:
                        interval = 60
                    elif interval <= 120:
                        interval = 120
                    elif interval <= 180:
                        interval = 180
                    elif interval <= 300:
                        interval = 300
                    elif interval <= 600:
                        interval = 600
                    elif interval <= 1200:
                        interval = 1200
                    elif interval <= 1800:
                        interval = 1800
                    elif interval <= 3600:
                        interval = 3600
                    else:
                        # 如果计算出的间隔太大，限制在3600秒（1小时）
                        interval = min(3600, interval)

                    print(
                        f"【API】数据密度：{data_density:.2f} 条/秒，目标点数：{target_points}，计算间隔：{int(time_span / target_points)}秒，实际间隔：{interval}秒")
                else:
                    interval = 300  # 默认5分钟

            print(f"【API】使用聚合模式，间隔：{interval}秒")
            data = await db.get_aggregated_data(start, end, interval, device_id=device_id)

            # 转换为前端需要的格式（使用平均值）
            readings = []
            for row in data:
                readings.append({
                    "type": "reading",
                    "ts": float(row['timestamp']),
                    "temp": float(row['temperature']) if row['temperature'] is not None else None,
                    "hum": float(row['humidity']) if row['humidity'] is not None else None,
                    "lux": float(row['brightness']) if row['brightness'] is not None else None,
                    "smoke": float(row['smoke_ppm']) if row['smoke_ppm'] is not None else None,
                    "pressure": float(row['pressure']) if row['pressure'] is not None else None,
                    "temp2": float(row['temp2']) if row['temp2'] is not None else None,
                    "rs_ro": float(row['rs_ro']) if row['rs_ro'] is not None else None,
                    "device_id": device_id,  # 添加设备ID（如果提供了筛选参数）
                    "_aggregated": True,  # 标记这是聚合数据
                    "_interval": interval,  # 聚合间隔
                    "_original_count": int(row['data_count']) if row.get('data_count') else 0  # 原始数据条数
                })

            print(f"【API】返回 {len(readings)} 条聚合数据（原始数据 {data_count} 条）")
            return {
                "success": True,
                "data": readings,
                "count": len(readings),
                "aggregated": True,
                "original_count": data_count,
                "interval": interval
            }
        else:
            # 不使用聚合，直接返回原始数据
            print(f"【API】使用原始数据模式")
            data = await db.get_data_by_time_range(start, end, device_id=device_id)

            # 转换为前端需要的格式
            readings = []
            for row in data:
                readings.append({
                    "type": "reading",
                    "ts": row['timestamp'],
                    "temp": float(row['temperature']),
                    "hum": float(row['humidity']),
                    "lux": float(row['brightness']) if row['brightness'] is not None else None,
                    "smoke": float(row['smoke_ppm']) if row['smoke_ppm'] is not None else None,
                    "pressure": float(row['pressure']) if row['pressure'] is not None else None,
                    "temp2": float(row['temp2']) if row.get('temp2') is not None else None,
                    "rs_ro": float(row['rs_ro']) if row.get('rs_ro') is not None else None,
                    "device_id": row.get('device_id')  # 添加设备ID
                })

            print(f"【API】返回 {len(readings)} 条原始数据")
            return {
                "success": True,
                "data": readings,
                "count": len(readings),
                "aggregated": False
            }
    except Exception as e:
        print(f"【API】获取时间范围数据失败：{e}")
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e), "data": []}


# API：AI 聊天代理（解决跨域问题）
@app.post("/api/ai/chat", tags=["AI API"])
async def ai_chat_proxy(request: Request):
    """
    AI 聊天代理端点，支持本地 LM Studio 和在线 DeepSeek API
    解决浏览器跨域限制问题
    """
    try:
        # 获取前端发送的请求体
        body = await request.json()
        model_name = body.get('model', '')

        print(f"【AI】收到聊天请求，消息数：{len(body.get('messages', []))}")
        print(f"【AI】请求参数：")
        print(f"  - model: {model_name}")
        print(f"  - temperature: {body.get('temperature')}")
        print(f"  - max_tokens: {body.get('max_tokens')}")
        print(f"  - stream: {body.get('stream')}")

        # 判断是在线模型还是本地模型
        is_online_model = model_name in DEEPSEEK_ONLINE_MODELS

        if is_online_model:
            # 使用 DeepSeek 在线 API
            print(f"【AI】使用在线模型：{model_name}")
            return await call_deepseek_online_api(body)
        else:
            # 使用本地 LM Studio
            print(f"【AI】使用本地模型：{model_name}")
            return await call_local_lm_studio(body)

    except Exception as e:
        print(f"【AI】请求处理失败：{e}")
        import traceback
        traceback.print_exc()
        return Response(
            content=json.dumps({
                "error": "请求处理失败",
                "message": str(e)
            }),
            status_code=500,
            media_type="application/json"
        )


# 调用 DeepSeek 在线 API
async def call_deepseek_online_api(body):
    """
    调用 DeepSeek 官方在线 API
    """
    try:
        # DeepSeek API 不支持 max_tokens: -1，需要修正
        if body.get('max_tokens') == -1:
            # 移除 max_tokens 参数，让 API 使用默认值
            body = body.copy()  # 创建副本，避免修改原始请求
            del body['max_tokens']
            print(f"【DeepSeek在线】已移除 max_tokens=-1 参数（DeepSeek API 不支持此值）")

        # 检查是否是流式请求
        is_stream = body.get('stream', False)

        # 打印请求参数（调试用）
        print(
            f"【DeepSeek在线】请求参数: model={body.get('model')}, temperature={body.get('temperature')}, stream={is_stream}")
        print(f"【DeepSeek在线】max_tokens={body.get('max_tokens', '未设置')}, 消息数={len(body.get('messages', []))}")

        # 准备请求头
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {DEEPSEEK_API_KEY}"
        }

        if is_stream:
            # 流式响应
            async def stream_response():
                timeout = httpx.Timeout(
                    connect=10.0,
                    read=300.0,
                    write=60.0,
                    pool=10.0
                )
                client = httpx.AsyncClient(timeout=timeout)
                chunk_count = 0
                try:
                    print(f"【DeepSeek在线】开始流式请求到: {DEEPSEEK_API_URL}")
                    async with client.stream(
                            "POST",
                            DEEPSEEK_API_URL,
                            json=body,
                            headers=headers
                    ) as response:
                        print(f"【DeepSeek在线】收到响应，状态码: {response.status_code}")

                        if response.status_code != 200:
                            error_body = await response.aread()
                            print(f"【DeepSeek在线】❌ 错误响应体: {error_body.decode('utf-8', errors='ignore')}")
                            yield f"data: {json.dumps({'error': f'DeepSeek API 返回错误 {response.status_code}'})}\n\n".encode(
                                'utf-8')
                        else:
                            # 🎯 使用 aiter_text() 而不是 aiter_bytes()，让 httpx 处理 UTF-8 边界
                            async for text_chunk in response.aiter_text():
                                chunk_count += 1
                                if chunk_count <= 5:
                                    # 🐛 打印前5个块的内容（用于调试）
                                    print(
                                        f"【DeepSeek在线】块 #{chunk_count} (长度={len(text_chunk)}字符): {text_chunk[:300]}")
                                # 转换回字节（保持与前端的兼容性）
                                yield text_chunk.encode('utf-8')
                            print(f"【DeepSeek在线】流式传输完成，共转发 {chunk_count} 个数据块")
                except httpx.ReadTimeout:
                    error_msg = "⏰ DeepSeek API 响应超时"
                    print(f"【DeepSeek在线】{error_msg}")
                    yield f"data: {json.dumps({'error': error_msg})}\n\n".encode('utf-8')
                except httpx.ConnectTimeout:
                    error_msg = "⏰ 连接 DeepSeek API 超时"
                    print(f"【DeepSeek在线】{error_msg}")
                    yield f"data: {json.dumps({'error': error_msg})}\n\n".encode('utf-8')
                except Exception as e:
                    print(f"【DeepSeek在线】流式传输错误：{e}")
                    import traceback
                    traceback.print_exc()
                    error_msg = f"data: {json.dumps({'error': str(e)})}\n\n"
                    yield error_msg.encode('utf-8')
                finally:
                    await client.aclose()
                    print(f"【DeepSeek在线】HTTP 客户端已关闭")

            return StreamingResponse(
                stream_response(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                }
            )
        else:
            # 非流式响应
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    DEEPSEEK_API_URL,
                    json=body,
                    headers=headers
                )
                return response.json()

    except httpx.ConnectError:
        print(f"【DeepSeek在线】无法连接到 DeepSeek API")
        return Response(
            content=json.dumps({
                "error": "DeepSeek API 连接失败",
                "message": "无法连接到 DeepSeek 服务器"
            }),
            status_code=503,
            media_type="application/json"
        )
    except httpx.TimeoutException:
        print("【DeepSeek在线】DeepSeek API 响应超时")
        return Response(
            content=json.dumps({
                "error": "DeepSeek API 超时",
                "message": "DeepSeek API 响应时间过长"
            }),
            status_code=504,
            media_type="application/json"
        )
    except Exception as e:
        print(f"【DeepSeek在线】请求失败：{e}")
        import traceback
        traceback.print_exc()
        return Response(
            content=json.dumps({
                "error": "DeepSeek API 调用失败",
                "message": str(e)
            }),
            status_code=500,
            media_type="application/json"
        )


# 调用本地 LM Studio
async def call_local_lm_studio(body):
    """
    调用本地 LM Studio
    """
    AI_SERVICE_URL = "http://localhost:1234/v1/chat/completions"

    try:

        # 检查是否是流式请求
        is_stream = body.get('stream', False)

        if is_stream:
            # 流式响应 - client 需要在整个流式传输期间保持打开
            async def stream_response():
                # 设置更长的超时时间：连接10秒，读取300秒（5分钟），写入60秒
                timeout = httpx.Timeout(
                    connect=10.0,  # 连接超时
                    read=300.0,  # 读取超时（包括模型推理时间）
                    write=60.0,  # 写入超时
                    pool=10.0  # 连接池超时
                )
                # 禁用代理，直连 localhost（避免代理干扰）
                client = httpx.AsyncClient(timeout=timeout, proxies={})
                chunk_count = 0
                try:
                    print(f"【AI】开始流式请求到: {AI_SERVICE_URL}")
                    print(f"【AI】提示：首次请求可能需要加载模型，请耐心等待...")
                    async with client.stream(
                            "POST",
                            AI_SERVICE_URL,
                            json=body,
                            headers={"Content-Type": "application/json"}
                    ) as response:
                        print(f"【AI】收到响应，状态码: {response.status_code}")

                        # 如果是错误状态码，读取错误详情
                        if response.status_code != 200:
                            error_body = await response.aread()
                            print(f"【AI】❌ 错误响应体: {error_body.decode('utf-8', errors='ignore')}")
                            yield f"data: {json.dumps({'error': f'LM Studio 返回错误 {response.status_code}'})}\n\n".encode(
                                'utf-8')
                        else:
                            # 🎯 使用 aiter_text() 而不是 aiter_bytes()，让 httpx 处理 UTF-8 边界
                            async for text_chunk in response.aiter_text():
                                chunk_count += 1
                                if chunk_count <= 3:  # 只打印前3个块
                                    print(f"【AI】转发数据块 #{chunk_count}，大小: {len(text_chunk)} 字符")
                                # 转换回字节（保持与前端的兼容性）
                                yield text_chunk.encode('utf-8')
                            print(f"【AI】流式传输完成，共转发 {chunk_count} 个数据块")
                except httpx.ReadTimeout:
                    error_msg = "⏰ LM Studio 响应超时。这通常发生在首次加载模型时，请等待1-2分钟后重试。"
                    print(f"【AI】{error_msg}")
                    yield f"data: {json.dumps({'error': error_msg})}\n\n".encode('utf-8')
                except httpx.ConnectTimeout:
                    error_msg = "⏰ 连接 LM Studio 超时。请检查服务是否正在运行。"
                    print(f"【AI】{error_msg}")
                    yield f"data: {json.dumps({'error': error_msg})}\n\n".encode('utf-8')
                except Exception as e:
                    print(f"【AI】流式传输错误：{e}")
                    import traceback
                    traceback.print_exc()
                    error_msg = f"data: {json.dumps({'error': str(e)})}\n\n"
                    yield error_msg.encode('utf-8')
                finally:
                    await client.aclose()
                    print(f"【AI】HTTP 客户端已关闭")

            return StreamingResponse(
                stream_response(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                }
            )
        else:
            # 非流式响应
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    AI_SERVICE_URL,
                    json=body,
                    headers={"Content-Type": "application/json"}
                )
                return response.json()

    except httpx.ConnectError:
        print(f"【AI】无法连接到 AI 服务：{AI_SERVICE_URL}")
        return Response(
            content=json.dumps({
                "error": "AI 服务连接失败",
                "message": f"无法连接到 {AI_SERVICE_URL}，请确保 LM Studio 正在运行"
            }),
            status_code=503,  # Service Unavailable
            media_type="application/json"
        )
    except httpx.TimeoutException:
        print("【AI】AI 服务响应超时")
        return Response(
            content=json.dumps({
                "error": "AI 服务超时",
                "message": "AI 服务响应时间过长，请稍后重试"
            }),
            status_code=504,  # Gateway Timeout
            media_type="application/json"
        )
    except Exception as e:
        print(f"【AI】代理请求失败：{e}")
        import traceback
        traceback.print_exc()
        return Response(
            content=json.dumps({
                "error": "代理失败",
                "message": str(e)
            }),
            status_code=500,  # Internal Server Error
            media_type="application/json"
        )


# API：AI 服务健康检查
@app.get("/api/ai/health", tags=["AI API"])
async def ai_health_check():
    """
    检查 AI 服务（LM Studio）是否在线
    轻量级健康检查，不会触发模型推理
    """
    AI_SERVICE_URL = "http://localhost:1234/v1/models"

    try:
        # 使用 /v1/models 端点进行健康检查（更轻量）
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.get(AI_SERVICE_URL)

            if response.status_code == 200:
                models_data = response.json()
                model_count = len(models_data.get('data', []))
                print(f"【AI健康检查】✅ LM Studio 在线，加载了 {model_count} 个模型")
                return {
                    "online": True,
                    "message": "LM Studio 在线",
                    "models_count": model_count
                }
            else:
                print(f"【AI健康检查】⚠️ LM Studio 响应异常: {response.status_code}")
                return Response(
                    content=json.dumps({
                        "online": False,
                        "message": f"LM Studio 响应异常: {response.status_code}"
                    }),
                    status_code=503,
                    media_type="application/json"
                )
    except httpx.ConnectError:
        print(f"【AI健康检查】❌ 无法连接到 LM Studio")
        return Response(
            content=json.dumps({
                "online": False,
                "message": "无法连接到 LM Studio，请确保服务正在运行"
            }),
            status_code=503,
            media_type="application/json"
        )
    except httpx.TimeoutException:
        print(f"【AI健康检查】❌ 连接 LM Studio 超时")
        return Response(
            content=json.dumps({
                "online": False,
                "message": "LM Studio 响应超时"
            }),
            status_code=504,
            media_type="application/json"
        )
    except Exception as e:
        print(f"【AI健康检查】❌ 检查失败: {e}")
        return Response(
            content=json.dumps({
                "online": False,
                "message": f"健康检查失败: {str(e)}"
            }),
            status_code=500,
            media_type="application/json"
        )


# API：获取连接状态
@app.get("/api/status", tags=["连接状态"])
async def get_connection_status():
    """
    获取后端各数据源的连接状态
    """
    global ble_connected, mqtt_connected, ble_or_mqtt_first

    # 根据 ble_or_mqtt_first 判断优先顺序
    if ble_or_mqtt_first == 0:
        # 蓝牙优先
        ble_priority = 1
        ble_desc = "本地蓝牙连接，优先数据源"
        mqtt_priority = 2
        mqtt_desc = "云端MQTT连接，备用数据源"
    else:
        # MQTT优先
        ble_priority = 2
        ble_desc = "本地蓝牙连接，备用数据源"
        mqtt_priority = 1
        mqtt_desc = "云端MQTT连接，优先数据源"

    return {
        "success": True,
        "priority_mode": ble_or_mqtt_first,  # 0=蓝牙优先, 1=MQTT优先
        "ble": {
            "connected": ble_connected,
            "name": "蓝牙设备 (BT27)",
            "priority": ble_priority,
            "description": ble_desc
        },
        "mqtt": {
            "connected": mqtt_connected,
            "name": "MQTT 服务器",
            "priority": mqtt_priority,
            "description": mqtt_desc
        }
    }


@app.get("/api/devices", tags=["连接状态"])
async def get_devices():
    """
    获取所有已配置设备及其在线状态
    基于设备最后消息时间判断：10秒内收到消息则在线，否则离线
    """
    global ble_connected, mqtt_connected, device_last_message_time

    devices = []
    current_time = time.time()

    for dev_id in get_managed_mq2_devices():
        has_ble = (dev_id == "D01")
        has_mqtt = True  # 所有 Dxx 都走 MQTT

        # 判断设备是否在线：基于最后消息时间
        last_message_time = device_last_message_time.get(dev_id)
        if last_message_time and (current_time - last_message_time) <= DEVICE_ONLINE_TIMEOUT:
            online = True
            # 判断通过哪些方式在线
            via_list = []
            if has_ble and ble_connected:
                via_list.append("BLE")
            if mqtt_connected:
                via_list.append("MQTT")
        else:
            online = False
            via_list = []

        # 从配置中获取设备名称，如果未配置则使用默认格式
        device_name = DEVICE_NAMES.get(dev_id, f"环境监测设备 {dev_id}")

        devices.append({
            "id": dev_id,
            "name": device_name,
            "online": online,
            "via": via_list,
            "has_ble": has_ble,
            "has_mqtt": has_mqtt,
            "description": "本地实验室多传感器监测节点"
        })

    return {
        "success": True,
        "devices": devices,
        "count": len(devices)
    }


# API：获取 AI 模型列表
@app.get("/api/ai/models", tags=["AI API"])
async def get_ai_models():
    """
    获取 LM Studio 中可用的模型列表
    """
    AI_MODELS_URL = "http://localhost:1234/v1/models"

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(AI_MODELS_URL)
            if response.status_code == 200:
                models_data = response.json()
                print(f"【AI】获取到 {len(models_data.get('data', []))} 个模型")
                return models_data
            else:
                return {"error": "无法获取模型列表", "data": []}
    except Exception as e:
        print(f"【AI】获取模型列表失败：{e}")
        return {"error": str(e), "data": []}


# API：获取警告数据
@app.get("/api/warnings", tags=["消息中心"])
async def get_warnings(limit: int = 100, warning_type: str = None, is_resolved: str = None, date: str = None,
                       device_id: str = None):
    """
    获取警告数据
    
    参数:
        limit: 返回的数据条数，默认100条
        warning_type: 警告类型筛选（T/H/B/S/P），可选
        is_resolved: 是否已恢复筛选（0=未恢复, 1=已恢复），可选
        date: 日期筛选（格式：YYYY-MM-DD），可选
        device_id: 设备ID筛选（如 D01、D02），可选
    """
    try:
        db = get_db_manager()

        # 转换 is_resolved 参数
        resolved_param = None
        if is_resolved is not None and is_resolved != '':
            try:
                resolved_param = int(is_resolved)
            except (ValueError, TypeError):
                resolved_param = None

        device_param = None
        if device_id:
            device_param = device_id.strip().upper() or None

        warnings = await db.get_warning_data(
            limit=limit,
            warning_type=warning_type,
            is_resolved=resolved_param,
            date=date,
            device_id=device_param
        )

        # 转换为前端需要的格式
        result = []
        for warning in warnings:
            result.append({
                "id": warning['id'],
                "warning_type": warning['warning_type'],
                "warning_message": warning['warning_message'],
                "warning_value": float(warning['warning_value']) if warning['warning_value'] is not None else None,
                "is_resolved": bool(warning['is_resolved']),
                "warning_start_time": warning['warning_start_time'],
                "warning_resolved_time": warning['warning_resolved_time'],
                "created_at": str(warning['created_at']),
                "device_id": warning.get('device_id') or "D01"
            })

        print(f"【API】返回 {len(result)} 条警告数据")
        return {
            "success": True,
            "data": result,
            "count": len(result)
        }
    except Exception as e:
        print(f"【API】获取警告数据失败：{e}")
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "error": str(e),
            "data": [],
            "count": 0
        }


# API：获取有警告数据的日期列表
@app.get("/api/warnings/dates", tags=["消息中心"])
async def get_warning_dates(device_id: str = None):
    """
    获取所有有警告数据的日期列表及每个日期的消息数量
    
    返回:
        包含日期和数量的字典列表，格式：[{"date": "YYYY-MM-DD", "count": 数量}, ...]
    """
    try:
        db = get_db_manager()
        device_param = None
        if device_id:
            device_param = device_id.strip().upper() or None
        dates = await db.get_warning_dates(device_param)

        print(f"【API】返回 {len(dates)} 个有数据的日期")
        return {
            "success": True,
            "data": dates,
            "count": len(dates)
        }
    except Exception as e:
        print(f"【API】获取警告日期列表失败：{e}")
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "error": str(e),
            "data": [],
            "count": 0
        }


# API：请求定位信息
@app.post("/api/location/query", tags=["定位信息"])
async def query_location(request: Request = None):
    """
    请求定位信息
    发送"LBS?"命令到MQTT主题，等待设备返回定位数据
    
    参数:
        device_id: 设备ID（可选），如：D01, D02。如果不提供，默认使用D01
    """
    global mqtt_client, mqtt_connected

    try:
        # 获取设备ID参数
        device_id = None
        if request:
            try:
                body = await request.json()
                device_id = body.get("device_id")
            except:
                pass

        # 如果没有提供设备ID，使用默认值D01
        if not device_id:
            device_id = "D01"

        # 规范化设备ID（转大写）
        device_id = device_id.strip().upper()

        # 检查MQTT连接状态
        if not mqtt_connected or not mqtt_client:
            return {
                "success": False,
                "error": "MQTT未连接",
                "message": "无法发送定位查询命令，MQTT连接未建立"
            }

        # 根据设备ID获取对应的命令主题
        target_topic = MQTT_CMD_TOPIC_MAP.get(device_id, MQTT_CMD_TOPIC)

        # 发送定位查询命令"LBS?"到定位命令主题
        # 注意：设备应该监听这个主题并返回定位数据到同一个主题
        command = "LBS?"
        try:
            # 发布命令到对应设备的定位命令主题
            result = mqtt_client.publish(target_topic, command, qos=1)

            if result.rc == mqtt.MQTT_ERR_SUCCESS:
                print(f"【定位】✓ 已发送定位查询命令 \"{command}\" 到主题 {target_topic} [设备: {device_id}]")
                return {
                    "success": True,
                    "message": "定位查询命令已发送",
                    "command": command,
                    "topic": target_topic,
                    "device_id": device_id,
                    "note": "定位数据将通过WebSocket实时推送"
                }
            else:
                print(f"【定位】❌ 发送定位查询命令失败，错误码: {result.rc}")
                return {
                    "success": False,
                    "error": "发送命令失败",
                    "message": f"MQTT发布失败，错误码: {result.rc}"
                }
        except Exception as e:
            print(f"【定位】❌ 发送定位查询命令异常：{e}")
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": "发送命令异常",
                "message": str(e)
            }

    except Exception as e:
        print(f"【API】定位查询失败：{e}")
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "error": "定位查询失败",
            "message": str(e)
        }


# WebSocket：实时推送
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    connections.add(ws)
    print(f"【WS】客户端已连接，当前连接数：{len(connections)}")
    try:
        await ws.send_text(json.dumps({"type": "hello", "msg": "connected"}))
        while True:
            await asyncio.sleep(60)  # 仅保活，不要求客户端发消息
    except WebSocketDisconnect:
        pass
    finally:
        connections.discard(ws)
        print(f"【WS】客户端已断开，当前连接数：{len(connections)}")


# ============ 启动 ============
if __name__ == "__main__":
    print("【服务】Uvicorn 启动中：http://localhost:8001")
    # 对所有IP监听
    uvicorn.run("server:app", host="0.0.0.0", port=8001, reload=False)
