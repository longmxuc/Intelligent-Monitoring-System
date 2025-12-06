# mqtt_message_sender.py
"""
MQTT消息发送模块
处理onmessage/offmessage命令，定期向设备发送状态消息
"""
import asyncio
import time
from datetime import datetime, timezone, timedelta
from typing import Dict, Optional, Set, Callable
import paho.mqtt.client as mqtt


class MqttMessageSender:
    """MQTT消息发送管理器"""
    
    def __init__(self, 
                 get_mqtt_client: Callable[[], Optional[mqtt.Client]],
                 get_mqtt_connected: Callable[[], bool],
                 get_connections: Callable[[], Set],
                 get_cmd_topic_map: Callable[[], Dict[str, str]],
                 get_main_loop: Callable[[], Optional[asyncio.AbstractEventLoop]]):
        """
        初始化消息发送管理器
        
        参数:
            get_mqtt_client: 获取MQTT客户端的函数
            get_mqtt_connected: 获取MQTT连接状态的函数
            get_connections: 获取WebSocket连接集合的函数
            get_cmd_topic_map: 获取命令主题映射的函数
            get_main_loop: 获取主事件循环的函数
        """
        self.get_mqtt_client = get_mqtt_client
        self.get_mqtt_connected = get_mqtt_connected
        self.get_connections = get_connections
        self.get_cmd_topic_map = get_cmd_topic_map
        self.get_main_loop = get_main_loop
        
        # 跟踪每个设备的消息发送状态
        self.message_send_tasks: Dict[str, Dict] = {}
        self.message_send_lock = asyncio.Lock()
        self.max_duration = 30  # 最大发送时长（秒）
    
    def _publish_message(self, device_id: str, message: str) -> bool:
        """向指定设备的 data_cmd 主题发布消息。"""
        mqtt_client = self.get_mqtt_client()
        mqtt_connected = self.get_mqtt_connected()

        if not (mqtt_connected and mqtt_client):
            print(f"【MQTT-消息发送】❌ MQTT未连接，无法发送消息（{device_id} -> {message}）")
            return False

        cmd_topic_map = self.get_cmd_topic_map()
        target_topic = cmd_topic_map.get(device_id)
        if not target_topic:
            print(f"【MQTT-消息发送】❌ 设备 {device_id} 没有对应的命令主题，无法发送 {message}")
            return False

        try:
            result = mqtt_client.publish(target_topic, message, qos=1)
            if result.rc == mqtt.MQTT_ERR_SUCCESS:
                print(f"【MQTT-消息发送】✓ 设备 {device_id} -> {target_topic}: {message}")
                return True
            else:
                print(f"【MQTT-消息发送】❌ 设备 {device_id} 发布失败，错误码: {result.rc} | 消息: {message}")
                return False
        except Exception as e:
            print(f"【MQTT-消息发送】设备 {device_id} 发送异常：{e} | 消息: {message}")
            return False

    async def _message_send_task(self, device_id: str):
        """
        为指定设备定期发送消息到data_cmd频道
        格式：ms:t_17:31:31,p_2
        t_后面是当前东八区时间（24小时制），p_后面是当前WebSocket连接数量
        """
        start_time = time.time()
        
        print(f"【MQTT-消息发送】开始为设备 {device_id} 发送消息")
        
        try:
            while True:
                # 检查是否超过最大时长
                elapsed = time.time() - start_time
                if elapsed >= self.max_duration:
                    print(f"【MQTT-消息发送】设备 {device_id} 发送超过 {self.max_duration} 秒，自动停止")
                    self._publish_message(device_id, "ms:timeout")
                    break
                
                # 检查是否仍然激活
                async with self.message_send_lock:
                    if device_id not in self.message_send_tasks or not self.message_send_tasks[device_id].get("active", False):
                        print(f"【MQTT-消息发送】设备 {device_id} 已停止发送")
                        break
                
                # 获取东八区时间（UTC+8）
                tz_beijing = timezone(timedelta(hours=8))
                now_beijing = datetime.now(tz_beijing)
                time_str = now_beijing.strftime("%H:%M:%S")
                
                # 获取WebSocket连接数
                connections = self.get_connections()
                ws_count = len(connections)
                
                # 构造消息：ms:t_17:31:31,p_2
                message = f"ms:t_{time_str},p_{ws_count}"
                self._publish_message(device_id, message)
                
                # 等待1秒
                await asyncio.sleep(1.0)
                
        except asyncio.CancelledError:
            print(f"【MQTT-消息发送】设备 {device_id} 发送任务被取消")
        except Exception as e:
            print(f"【MQTT-消息发送】设备 {device_id} 发送任务异常：{e}")
            import traceback
            traceback.print_exc()
        finally:
            # 清理状态（简单清理，避免死锁）
            print(f"【MQTT-消息发送】任务 finally 块开始，设备: {device_id}")
            try:
                async with self.message_send_lock:
                    print(f"【MQTT-消息发送】任务 finally 块获取锁成功，设备: {device_id}")
                    if device_id in self.message_send_tasks:
                        task_info = self.message_send_tasks[device_id]
                        current_task = task_info.get("task")
                        
                        # 简单清理：如果这是当前任务（已完成），就清理状态
                        if current_task is not None and current_task.done():
                            # 任务已完成或被取消，清理状态
                            task_info["active"] = False
                            task_info["task"] = None
                            print(f"【MQTT-消息发送】设备 {device_id} 发送任务已清理（finally块）")
                        elif current_task is None:
                            # 任务已经是 None，只清理active状态
                            if task_info.get("active", False):
                                task_info["active"] = False
                                print(f"【MQTT-消息发送】设备 {device_id} 发送任务已清理（任务为None）")
                        else:
                            # 任务仍在运行，可能是新任务，不清理
                            print(f"【MQTT-消息发送】设备 {device_id} 任务仍在运行，不清理（可能是新任务）")
            except Exception as e:
                print(f"【MQTT-消息发送】finally块异常: {e}")
                import traceback
                traceback.print_exc()
    
    async def start_sending(self, device_id: str):
        """
        启动指定设备的消息发送任务
        
        参数:
            device_id: 设备ID（如 "D01", "D02"）
        """
        if not device_id:
            print(f"【MQTT-消息发送】设备ID为空，无法启动")
            return
        
        # 先检查并取消旧任务（在锁外等待，避免死锁）
        old_task_to_cancel = None
        async with self.message_send_lock:
            print(f"【MQTT-消息发送】start_sending 获取锁成功，设备: {device_id}")
            # 如果已有任务在运行，先标记为取消
            if device_id in self.message_send_tasks:
                task_info = self.message_send_tasks[device_id]
                old_task = task_info.get("task")
                is_active = task_info.get("active", False)
                
                print(f"【MQTT-消息发送】设备 {device_id} 当前状态: active={is_active}, task={old_task}, task.done()={old_task.done() if old_task else 'N/A'}")
                
                if is_active and old_task and not old_task.done():
                    print(f"【MQTT-消息发送】设备 {device_id} 已有运行中的任务，准备取消...")
                    old_task_to_cancel = old_task
                    task_info["active"] = False  # 先标记为不活跃
                elif old_task and old_task.done():
                    # 旧任务已完成，清理状态
                    print(f"【MQTT-消息发送】设备 {device_id} 旧任务已完成，清理状态")
                    task_info["active"] = False
                    task_info["task"] = None
                elif old_task is None or not is_active:
                    # 任务已经被清理过了，直接继续创建新任务
                    print(f"【MQTT-消息发送】设备 {device_id} 任务已清理，准备创建新任务")
        
        # 在锁外等待旧任务完成（避免死锁）
        if old_task_to_cancel:
            print(f"【MQTT-消息发送】设备 {device_id} 正在取消旧任务（锁外等待）...")
            old_task_to_cancel.cancel()
            try:
                await old_task_to_cancel
            except asyncio.CancelledError:
                pass
            print(f"【MQTT-消息发送】设备 {device_id} 旧任务已取消")
        
        # 重新获取锁创建新任务
        async with self.message_send_lock:
            print(f"【MQTT-消息发送】准备创建新任务，设备: {device_id}")
            try:
                new_task = asyncio.create_task(self._message_send_task(device_id))
                self.message_send_tasks[device_id] = {
                    "active": True,
                    "task": new_task,
                    "start_time": time.time()
                }
                print(f"【MQTT-消息发送】✓ 已启动设备 {device_id} 的消息发送任务，任务ID: {id(new_task)}")
            except Exception as e:
                print(f"【MQTT-消息发送】❌ 创建任务失败: {e}")
                import traceback
                traceback.print_exc()
    
    async def stop_sending(self, device_id: str):
        """
        停止指定设备的消息发送任务
        
        参数:
            device_id: 设备ID（如 "D01", "D02"）
        """
        if not device_id:
            return
        
        print(f"【MQTT-消息发送】stop_sending 开始，设备: {device_id}")
        async with self.message_send_lock:
            print(f"【MQTT-消息发送】stop_sending 获取锁成功，设备: {device_id}")
            if device_id in self.message_send_tasks:
                task_info = self.message_send_tasks[device_id]
                if task_info.get("active", False):
                    task = task_info.get("task")
                    if task and not task.done():
                        print(f"【MQTT-消息发送】设备 {device_id} 正在取消任务...")
                        task.cancel()
                        # 不等待任务完成，让finally块自己清理
                        # 只标记为不活跃，让任务自己清理
                        task_info["active"] = False
                        print(f"【MQTT-消息发送】✓ 已标记设备 {device_id} 的任务为停止（任务将自行清理）")
                    else:
                        # 任务已完成或不存在
                        task_info["active"] = False
                        task_info["task"] = None
                        print(f"【MQTT-消息发送】✓ 已停止设备 {device_id} 的消息发送任务（任务已完成）")
                else:
                    print(f"【MQTT-消息发送】设备 {device_id} 任务未激活，无需停止")
            else:
                print(f"【MQTT-消息发送】设备 {device_id} 没有运行中的任务")
    
    async def cleanup(self):
        """清理所有消息发送任务"""
        async with self.message_send_lock:
            for device_id, task_info in list(self.message_send_tasks.items()):
                if task_info.get("active", False):
                    task = task_info.get("task")
                    if task and not task.done():
                        task.cancel()
                        try:
                            await task
                        except asyncio.CancelledError:
                            pass
            self.message_send_tasks.clear()
            print("【MQTT-消息发送】已清理所有消息发送任务")
    
    def handle_message(self, device_id: Optional[str], payload: str):
        """
        处理收到的MQTT消息，检查是否是onmessage或offmessage命令
        
        参数:
            device_id: 设备ID（如 "D01", "D02"）
            payload: 消息内容
        
        返回:
            bool: 如果消息被处理（是onmessage或offmessage），返回True；否则返回False
        """
        payload_normalized = payload.strip().lower()
        
        if payload_normalized == "onmessage":
            # 启动消息发送任务
            if device_id:
                print(f"【MQTT-消息发送】收到onmessage命令，设备: {device_id}")
                
                # 检查当前状态
                async def _check_and_start():
                    async with self.message_send_lock:
                        if device_id in self.message_send_tasks:
                            task_info = self.message_send_tasks[device_id]
                            print(f"【MQTT-消息发送】设备 {device_id} 当前状态: active={task_info.get('active', False)}, task={task_info.get('task')}")
                
                async def _start():
                    try:
                        print(f"【MQTT-消息发送】开始执行 start_sending，设备: {device_id}")
                        await _check_and_start()
                        await self.start_sending(device_id)
                        print(f"【MQTT-消息发送】start_sending 执行完成，设备: {device_id}")
                    except Exception as e:
                        print(f"【MQTT-消息发送】启动任务异常: {e}")
                        import traceback
                        traceback.print_exc()
                
                # 在事件循环中执行（MQTT回调在另一个线程，需要使用run_coroutine_threadsafe）
                main_loop = self.get_main_loop()
                print(f"【MQTT-消息发送】主事件循环状态: {main_loop is not None}, 运行中: {main_loop.is_running() if main_loop else False}")
                
                if main_loop and main_loop.is_running():
                    try:
                        print(f"【MQTT-消息发送】提交任务到事件循环，设备: {device_id}")
                        future = asyncio.run_coroutine_threadsafe(_start(), main_loop)
                        # 添加回调以捕获异常
                        def check_result(f):
                            try:
                                result = f.result(timeout=5)  # 等待最多5秒
                                print(f"【MQTT-消息发送】任务提交成功，设备: {device_id}")
                            except Exception as e:
                                print(f"【MQTT-消息发送】任务执行异常: {e}")
                                import traceback
                                traceback.print_exc()
                        future.add_done_callback(check_result)
                    except Exception as e:
                        print(f"【MQTT-消息发送】提交任务到事件循环失败: {e}")
                        import traceback
                        traceback.print_exc()
                else:
                    print(f"【MQTT-消息发送】警告：主事件循环未运行或未初始化，设备: {device_id}")
            else:
                print(f"【MQTT-消息发送】警告：设备ID为空，无法启动")
            return True
        
        elif payload_normalized == "offmessage":
            # 停止消息发送任务
            if device_id:
                print(f"【MQTT-消息发送】收到offmessage命令，设备: {device_id}")
                async def _stop():
                    try:
                        await self.stop_sending(device_id)
                    except Exception as e:
                        print(f"【MQTT-消息发送】停止任务异常: {e}")
                        import traceback
                        traceback.print_exc()
                
                # 在事件循环中执行（MQTT回调在另一个线程，需要使用run_coroutine_threadsafe）
                main_loop = self.get_main_loop()
                if main_loop and main_loop.is_running():
                    try:
                        future = asyncio.run_coroutine_threadsafe(_stop(), main_loop)
                        def check_result(f):
                            try:
                                f.result()
                            except Exception as e:
                                print(f"【MQTT-消息发送】停止任务执行异常: {e}")
                        future.add_done_callback(check_result)
                    except Exception as e:
                        print(f"【MQTT-消息发送】提交停止任务到事件循环失败: {e}")
                else:
                    print(f"【MQTT-消息发送】警告：主事件循环未运行或未初始化")
            return True
        
        return False

