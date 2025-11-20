"""
数据库管理模块（异步版）
负责MySQL连接池管理和数据持久化操作
"""

import aiomysql
from typing import Optional
from contextlib import asynccontextmanager
import time
import platform
from secrets_manager import SECRETS


def _detect_db_config() -> dict:
    """
    根据当前操作系统选择对应的数据库配置。

    在 secrets.txt 中支持以下键：
        - macOS:  DB_ADDR_MAC / DB_PASSWORD_MAC
        - Windows: DB_ADDR_WIN / DB_PASSWORD_WIN
        - Linux: DB_ADDR_LINUX / DB_PASSWORD_LINUX
    """
    system = platform.system()
    if system == "Darwin":
        host = SECRETS.get("DB_ADDR_MAC", "localhost")
        password = SECRETS.get("DB_PASSWORD_MAC", "")
        label = "macOS"
    elif system == "Windows":
        host = SECRETS.get("DB_ADDR_WIN", "localhost")
        password = SECRETS.get("DB_PASSWORD_WIN", "")
        label = "Windows"
    else:
        # 默认按 Linux 处理
        host = SECRETS.get("DB_ADDR_LINUX", "localhost")
        password = SECRETS.get("DB_PASSWORD_LINUX", "")
        label = "Linux/Other"

    if not password:
        print(f"【警告】当前系统({label})未在密钥文件中配置对应的数据库密码，数据库功能可能无法正常使用。")

    return {
        "host": host,
        "port": 3306,
        "user": "root",
        "password": password,
        "database": "sensor_data",
    }


database_info = _detect_db_config()

UNSET = object()

class DatabaseManager:
    """数据库管理器"""

    def __init__(self, host, port, user, password, database):
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.database = database
        self.pool = None

    async def init_pool(self, minsize=1, maxsize=10):
        """初始化连接池"""
        try:
            self.pool = await aiomysql.create_pool(
                host=self.host,
                port=self.port,
                user=self.user,
                password=self.password,
                db=self.database,
                minsize=minsize,
                maxsize=maxsize,
                autocommit=True,
                charset='utf8mb4'
            )
            print(f"【数据库】连接池初始化成功：{self.host}:{self.port}/{self.database}")
            return True
        except Exception as e:
            print(f"【数据库】连接池初始化失败：{e}")
            return False

    async def close_pool(self):
        """关闭连接池"""
        if self.pool:
            self.pool.close()
            await self.pool.wait_closed()
            print("【数据库】连接池已关闭")


    """
    一个异步上下文管理器（async context manager），
    负责从连接池（self.pool）里拿出一个数据库连接，
    在 async with 语句中安全使用，并自动归还。
    """
    @asynccontextmanager
    async def get_connection(self):
        """获取数据库连接（上下文管理器）"""
        if not self.pool:
            raise Exception("数据库连接池未初始化")

        async with self.pool.acquire() as conn:
            yield conn

    async def insert_sensor_data(self, temp: float, hum: float, lux: Optional[float] = None,
                                 smoke: Optional[float] = None, timestamp: Optional[float] = None,
                                 rs_ro: Optional[float] = None, temp2: Optional[float] = None,
                                 pressure: Optional[float] = None):
        """
        插入传感器数据
        
        参数:
            temp: 温度（摄氏度）
            hum: 湿度（百分比）
            lux: 亮度（勒克斯），可选
            smoke: 烟雾浓度（PPM），可选
            timestamp: 时间戳，如果为None则使用当前时间
            rs_ro: Rs/Ro传感器电阻比值，可选
            temp2: 二号温度传感器（摄氏度），可选
            pressure: 气压（hPa），可选
        """
        if timestamp is None:
            timestamp = time.time()

        try:
            async with self.get_connection() as conn:
                async with conn.cursor() as cursor:
                    sql = """
                          INSERT INTO sensor_readings (timestamp, temperature, humidity, brightness, smoke_ppm,
                                                       rs_ro, temp2, pressure)
                          VALUES (FROM_UNIXTIME(%s), %s, %s, %s, %s, %s, %s, %s) \
                          """
                    await cursor.execute(sql, (timestamp, temp, hum, lux, smoke, rs_ro, temp2, pressure))
                    return True
        except Exception as e:
            print(f"【数据库】插入数据失败：{e}")
            return False

    async def get_recent_data(self, limit=100):
        """
        获取最近的传感器数据
        
        参数:
            limit: 返回的数据条数
        
        返回:
            数据列表，每条数据包含 id, timestamp, temperature, humidity, brightness, smoke_ppm
        """
        try:
            async with self.get_connection() as conn:
                async with conn.cursor(aiomysql.DictCursor) as cursor:
                    sql = """
                          SELECT id,
                                 UNIX_TIMESTAMP(timestamp) as timestamp,
                           temperature, 
                           humidity, 
                           brightness,
                           smoke_ppm,
                           pressure,
                           temp2,
                           rs_ro,
                           created_at
                          FROM sensor_readings
                          ORDER BY id DESC
                              LIMIT %s \
                          """
                    await cursor.execute(sql, (limit,))
                    result = await cursor.fetchall()
                    return result
        except Exception as e:
            print(f"【数据库】查询数据失败：{e}")
            return []

    async def get_data_by_time_range(self, start_time: float, end_time: float):
        """
        获取指定时间范围内的传感器数据
        
        参数:
            start_time: 起始时间戳
            end_time: 结束时间戳
        
        返回:
            数据列表
        """
        try:
            async with self.get_connection() as conn:
                async with conn.cursor(aiomysql.DictCursor) as cursor:
                    sql = """
                          SELECT id,
                                 UNIX_TIMESTAMP(timestamp) as timestamp,
                           temperature, 
                           humidity, 
                           brightness,
                           smoke_ppm,
                           pressure,
                           temp2,
                           rs_ro,
                           created_at
                          FROM sensor_readings
                          WHERE timestamp BETWEEN FROM_UNIXTIME(%s)
                            AND FROM_UNIXTIME(%s)
                          ORDER BY timestamp ASC \
                          """
                    await cursor.execute(sql, (start_time, end_time))
                    result = await cursor.fetchall()
                    return result
        except Exception as e:
            print(f"【数据库】查询时间范围数据失败：{e}")
            return []

    async def get_statistics(self):
        """
        获取数据库统计信息
        
        返回:
            包含统计信息的字典
        """
        try:
            async with self.get_connection() as conn:
                async with conn.cursor(aiomysql.DictCursor) as cursor:
                    sql = """
                          SELECT COUNT(*)         as total_records,
                                 MIN(temperature) as min_temp,
                                 MAX(temperature) as max_temp,
                                 AVG(temperature) as avg_temp,
                                 MIN(humidity)    as min_hum,
                                 MAX(humidity)    as max_hum,
                                 AVG(humidity)    as avg_hum,
                                 MIN(brightness)  as min_lux,
                                 MAX(brightness)  as max_lux,
                                 AVG(brightness)  as avg_lux,
                                 MIN(smoke_ppm)   as min_smoke,
                                 MAX(smoke_ppm)   as max_smoke,
                                 AVG(smoke_ppm)   as avg_smoke,
                                 MIN(pressure)    as min_pressure,
                                 MAX(pressure)    as max_pressure,
                                 AVG(pressure)    as avg_pressure,
                                 MIN(timestamp)   as first_record,
                                 MAX(timestamp)   as last_record
                          FROM sensor_readings \
                          """
                    await cursor.execute(sql)
                    result = await cursor.fetchone()
                    return result
        except Exception as e:
            print(f"【数据库】获取统计信息失败：{e}")
            return None

    async def get_aggregated_data(self, start_time: float, end_time: float, interval_seconds: int = 300):
        """
        获取指定时间范围内的聚合数据（按时间间隔聚合）
        
        参数:
            start_time: 起始时间戳（秒）
            end_time: 结束时间戳（秒）
            interval_seconds: 聚合间隔（秒），默认300秒（5分钟）
        
        返回:
            聚合后的数据列表，每个时间间隔包含平均值、最大值、最小值
        """
        try:
            async with self.get_connection() as conn:
                async with conn.cursor(aiomysql.DictCursor) as cursor:
                    # 使用MySQL的时间函数进行聚合
                    # 将时间戳按间隔分组，计算每组的平均值、最大值、最小值
                    # 使用子查询来避免 only_full_group_by 错误
                    sql = """
                          SELECT 
                                 time_bucket as timestamp,
                                 AVG(temperature) as temperature,
                                 MIN(temperature) as min_temp,
                                 MAX(temperature) as max_temp,
                                 AVG(humidity) as humidity,
                                 MIN(humidity) as min_hum,
                                 MAX(humidity) as max_hum,
                                 AVG(brightness) as brightness,
                                 MIN(brightness) as min_lux,
                                 MAX(brightness) as max_lux,
                                 AVG(smoke_ppm) as smoke_ppm,
                                 MIN(smoke_ppm) as min_smoke,
                                 MAX(smoke_ppm) as max_smoke,
                                 AVG(pressure) as pressure,
                                 MIN(pressure) as min_pressure,
                                 MAX(pressure) as max_pressure,
                                 AVG(temp2) as temp2,
                                 MIN(temp2) as min_temp2,
                                 MAX(temp2) as max_temp2,
                                 AVG(rs_ro) as rs_ro,
                                 MIN(rs_ro) as min_rs_ro,
                                 MAX(rs_ro) as max_rs_ro,
                                 COUNT(*) as data_count
                          FROM (
                              SELECT 
                                     UNIX_TIMESTAMP(
                                         FROM_UNIXTIME(
                                             FLOOR(UNIX_TIMESTAMP(timestamp) / %s) * %s
                                         )
                                     ) as time_bucket,
                                     temperature,
                                     humidity,
                                     brightness,
                                     smoke_ppm,
                                     pressure,
                                     temp2,
                                     rs_ro
                              FROM sensor_readings
                              WHERE timestamp BETWEEN FROM_UNIXTIME(%s) AND FROM_UNIXTIME(%s)
                          ) as grouped_data
                          GROUP BY time_bucket
                          ORDER BY time_bucket ASC
                          """
                    await cursor.execute(sql, (interval_seconds, interval_seconds, start_time, end_time))
                    result = await cursor.fetchall()
                    return result
        except Exception as e:
            print(f"【数据库】查询聚合数据失败：{e}")
            return []

    async def count_data_by_time_range(self, start_time: float, end_time: float):
        """
        统计指定时间范围内的数据条数
        
        参数:
            start_time: 起始时间戳（秒）
            end_time: 结束时间戳（秒）
        
        返回:
            数据条数
        """
        try:
            async with self.get_connection() as conn:
                async with conn.cursor(aiomysql.DictCursor) as cursor:
                    sql = """
                          SELECT COUNT(*) as count
                          FROM sensor_readings
                          WHERE timestamp BETWEEN FROM_UNIXTIME(%s) AND FROM_UNIXTIME(%s)
                          """
                    await cursor.execute(sql, (start_time, end_time))
                    result = await cursor.fetchone()
                    return result['count'] if result else 0
        except Exception as e:
            print(f"【数据库】统计数据条数失败：{e}")
            return 0

    async def insert_warning_data(self, warning_type: str, warning_message: str,
                                  warning_value: Optional[float] = None,
                                  warning_start_time: Optional[float] = None):
        """
        插入警告数据
        
        参数:
            warning_type: 警告类型（T=温度, H=湿度, B=亮度, S=ppm, P=大气压）
            warning_message: 警告消息（原始消息）
            warning_value: 异常值（如果是异常数据）
            warning_start_time: 异常开始时间戳，如果为None则使用当前时间
        """
        if warning_start_time is None:
            warning_start_time = time.time()

        try:
            async with self.get_connection() as conn:
                async with conn.cursor() as cursor:
                    sql = """
                          INSERT INTO warning_data (warning_type, warning_message, warning_value,
                                                     is_resolved, warning_start_time)
                          VALUES (%s, %s, %s, 0, FROM_UNIXTIME(%s))
                          """
                    await cursor.execute(sql, (warning_type, warning_message, warning_value, warning_start_time))
                    return True
        except Exception as e:
            print(f"【数据库】插入警告数据失败：{e}")
            return False

    async def resolve_warning(self, warning_type: str, warning_resolved_time: Optional[float] = None):
        """
        标记警告为已恢复（更新恢复时间）
        
        参数:
            warning_type: 警告类型（T=温度, H=湿度, B=亮度, S=ppm, P=大气压）
            warning_resolved_time: 恢复时间戳，如果为None则使用当前时间
        """
        if warning_resolved_time is None:
            warning_resolved_time = time.time()

        try:
            async with self.get_connection() as conn:
                async with conn.cursor() as cursor:
                    # 更新该类型最新的未恢复警告为已恢复
                    sql = """
                          UPDATE warning_data
                          SET is_resolved = 1, warning_resolved_time = FROM_UNIXTIME(%s)
                          WHERE warning_type = %s 
                            AND is_resolved = 0
                          ORDER BY warning_start_time DESC
                          LIMIT 1
                          """
                    await cursor.execute(sql, (warning_resolved_time, warning_type))
                    affected_rows = cursor.rowcount
                    if affected_rows > 0:
                        print(f"【数据库】已标记警告类型 {warning_type} 为已恢复")
                        return True
                    else:
                        print(f"【数据库】未找到未恢复的警告类型 {warning_type}")
                        return False
        except Exception as e:
            print(f"【数据库】更新警告恢复状态失败：{e}")
            return False

    async def get_warning_data(self, limit: int = 100, warning_type: Optional[str] = None,
                               is_resolved: Optional[int] = None, date: Optional[str] = None):
        """
        获取警告数据
        
        参数:
            limit: 返回的数据条数
            warning_type: 警告类型筛选（可选）
            is_resolved: 是否已恢复筛选（0=未恢复, 1=已恢复, None=全部）
            date: 日期筛选（格式：YYYY-MM-DD），可选
        
        返回:
            警告数据列表
        """
        try:
            async with self.get_connection() as conn:
                async with conn.cursor(aiomysql.DictCursor) as cursor:
                    # 构建SQL查询
                    where_conditions = []
                    params = []

                    if warning_type:
                        where_conditions.append("warning_type = %s")
                        params.append(warning_type)

                    if is_resolved is not None:
                        where_conditions.append("is_resolved = %s")
                        params.append(is_resolved)

                    if date:
                        # 按日期筛选，匹配当天的所有数据
                        where_conditions.append("DATE(warning_start_time) = %s")
                        params.append(date)

                    where_clause = " WHERE " + " AND ".join(where_conditions) if where_conditions else ""
                    params.append(limit)

                    sql = f"""
                          SELECT id,
                                 warning_type,
                                 warning_message,
                                 warning_value,
                                 is_resolved,
                                 UNIX_TIMESTAMP(warning_start_time) as warning_start_time,
                                 UNIX_TIMESTAMP(warning_resolved_time) as warning_resolved_time,
                                 created_at
                          FROM warning_data
                          {where_clause}
                          ORDER BY warning_start_time DESC
                          LIMIT %s
                          """
                    await cursor.execute(sql, params)
                    result = await cursor.fetchall()
                    return result
        except Exception as e:
            print(f"【数据库】查询警告数据失败：{e}")
            return []

    async def get_warning_dates(self):
        """
        获取所有有警告数据的日期列表及每个日期的消息数量
        
        返回:
            包含日期和数量的字典列表，格式：[{"date": "YYYY-MM-DD", "count": 数量}, ...]
        """
        try:
            async with self.get_connection() as conn:
                async with conn.cursor(aiomysql.DictCursor) as cursor:
                    sql = """
                          SELECT DATE(warning_start_time) as date, COUNT(*) as count
                          FROM warning_data
                          GROUP BY DATE(warning_start_time)
                          ORDER BY date DESC
                          """
                    await cursor.execute(sql)
                    result = await cursor.fetchall()
                    # 转换为字典列表
                    dates = []
                    for row in result:
                        if row['date']:
                            dates.append({
                                'date': row['date'].strftime('%Y-%m-%d'),
                                'count': row['count']
                            })
                    return dates
        except Exception as e:
            print(f"【数据库】查询警告日期列表失败：{e}")
            return []

    async def get_unresolved_warning_types(self):
        """
        获取所有未恢复的警告类型列表
        
        返回:
            未恢复的警告类型集合，例如：{'T', 'H', 'B'}
        """
        try:
            async with self.get_connection() as conn:
                async with conn.cursor(aiomysql.DictCursor) as cursor:
                    sql = """
                          SELECT DISTINCT warning_type
                          FROM warning_data
                          WHERE is_resolved = 0
                          """
                    await cursor.execute(sql)
                    result = await cursor.fetchall()
                    # 转换为集合
                    warning_types = set()
                    for row in result:
                        if row['warning_type']:
                            warning_types.add(row['warning_type'])
                    return warning_types
        except Exception as e:
            print(f"【数据库】查询未恢复警告类型失败：{e}")
            return set()

    async def ensure_sensor_state_table(self):
        """确保传感器状态表存在"""
        try:
            async with self.get_connection() as conn:
                async with conn.cursor() as cursor:
                    # 先检查表是否存在
                    sql_check = "SHOW TABLES LIKE 'sensor_states'"
                    await cursor.execute(sql_check)
                    table_exists = await cursor.fetchone()

                    # 更稳的建表语句：所有标识符都加反引号，PRIMARY KEY 单独写一行
                    create_sql = """
                        CREATE TABLE IF NOT EXISTS `sensor_states` (
                            `sensor_name` VARCHAR(64) NOT NULL COMMENT '传感器名称（如：MQ2）',
                            `sensor_state` ENUM('on','off') NOT NULL DEFAULT 'on' COMMENT '传感器状态：on=开启, off=关闭',
                            `last_via` VARCHAR(16) DEFAULT NULL COMMENT '最近一次操作来源：BLE/MQTT',
                            `mode` VARCHAR(16) DEFAULT 'balance' COMMENT '运行模式：eco=节能, balance=平衡, safe=安全, always=持续供电, dev=开发测试',
                            `next_run_time` DATETIME DEFAULT NULL COMMENT '下次检测时间',
                            `last_value` DECIMAL(10,2) DEFAULT NULL COMMENT '最近一次检测值',
                            `phase` VARCHAR(16) DEFAULT 'idle' COMMENT '当前阶段：idle/warming/sampling/cooling/error',
                            `phase_message` VARCHAR(128) DEFAULT NULL COMMENT '阶段提示',
                            `phase_until` DATETIME DEFAULT NULL COMMENT '阶段预计结束时间',
                            `samples_collected` INT DEFAULT NULL COMMENT '已采集条数',
                            `samples_target` INT DEFAULT NULL COMMENT '计划采集条数',
                            `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP COMMENT '最近一次更新时间',
                            PRIMARY KEY (`sensor_name`)
                        ) ENGINE=InnoDB
                          DEFAULT CHARSET=utf8mb4
                          COMMENT='传感器状态表';
                    """
                    if not table_exists:
                        await cursor.execute(create_sql)

                    # 如果表已存在，再检查缺失字段（兼容旧表结构）
                    if table_exists:
                        await cursor.execute("DESCRIBE `sensor_states`")
                        existing_columns = {row[0] for row in await cursor.fetchall()}

                        if 'mode' not in existing_columns:
                            try:
                                sql_add_mode = """
                                    ALTER TABLE `sensor_states`
                                    ADD COLUMN `mode` VARCHAR(16) DEFAULT 'balance'
                                        COMMENT '运行模式：eco=节能, balance=平衡, safe=安全, always=持续供电, dev=开发测试'
                                """
                                await cursor.execute(sql_add_mode)
                                print("【数据库】✓ 已添加字段：mode")
                            except Exception as e:
                                print(f"【数据库】添加mode字段失败：{e}")

                        if 'next_run_time' not in existing_columns:
                            try:
                                sql_add_next = """
                                    ALTER TABLE `sensor_states`
                                    ADD COLUMN `next_run_time` DATETIME DEFAULT NULL
                                        COMMENT '下次检测时间'
                                """
                                await cursor.execute(sql_add_next)
                                print("【数据库】✓ 已添加字段：next_run_time")
                            except Exception as e:
                                print(f"【数据库】添加next_run_time字段失败：{e}")

                        if 'last_value' not in existing_columns:
                            try:
                                sql_add_value = """
                                    ALTER TABLE `sensor_states`
                                    ADD COLUMN `last_value` DECIMAL(10,2) DEFAULT NULL
                                        COMMENT '最近一次检测值'
                                """
                                await cursor.execute(sql_add_value)
                                print("【数据库】✓ 已添加字段：last_value")
                            except Exception as e:
                                print(f"【数据库】添加last_value字段失败：{e}")

                        if 'phase' not in existing_columns:
                            try:
                                sql_add_phase = """
                                    ALTER TABLE `sensor_states`
                                    ADD COLUMN `phase` VARCHAR(16) DEFAULT 'idle'
                                        COMMENT '当前阶段：idle/warming/sampling/cooling/error'
                                """
                                await cursor.execute(sql_add_phase)
                                print("【数据库】✓ 已添加字段：phase")
                            except Exception as e:
                                print(f"【数据库】添加phase字段失败：{e}")

                        if 'phase_message' not in existing_columns:
                            try:
                                sql_add_phase_message = """
                                    ALTER TABLE `sensor_states`
                                    ADD COLUMN `phase_message` VARCHAR(128) DEFAULT NULL
                                        COMMENT '阶段提示'
                                """
                                await cursor.execute(sql_add_phase_message)
                                print("【数据库】✓ 已添加字段：phase_message")
                            except Exception as e:
                                print(f"【数据库】添加phase_message字段失败：{e}")

                        if 'phase_until' not in existing_columns:
                            try:
                                sql_add_phase_until = """
                                    ALTER TABLE `sensor_states`
                                    ADD COLUMN `phase_until` DATETIME DEFAULT NULL
                                        COMMENT '阶段预计结束时间'
                                """
                                await cursor.execute(sql_add_phase_until)
                                print("【数据库】✓ 已添加字段：phase_until")
                            except Exception as e:
                                print(f"【数据库】添加phase_until字段失败：{e}")

                        if 'samples_collected' not in existing_columns:
                            try:
                                sql_add_samples_collected = """
                                    ALTER TABLE `sensor_states`
                                    ADD COLUMN `samples_collected` INT DEFAULT NULL
                                        COMMENT '已采集条数'
                                """
                                await cursor.execute(sql_add_samples_collected)
                                print("【数据库】✓ 已添加字段：samples_collected")
                            except Exception as e:
                                print(f"【数据库】添加samples_collected字段失败：{e}")

                        if 'samples_target' not in existing_columns:
                            try:
                                sql_add_samples_target = """
                                    ALTER TABLE `sensor_states`
                                    ADD COLUMN `samples_target` INT DEFAULT NULL
                                        COMMENT '计划采集条数'
                                """
                                await cursor.execute(sql_add_samples_target)
                                print("【数据库】✓ 已添加字段：samples_target")
                            except Exception as e:
                                print(f"【数据库】添加samples_target字段失败：{e}")
        except Exception as e:
            print(f"【数据库】创建传感器状态表失败：{e}")
            import traceback
            traceback.print_exc()

    async def ensure_warning_table(self):
        """确保警告数据表存在"""
        try:
            async with self.get_connection() as conn:
                async with conn.cursor() as cursor:
                    await cursor.execute("SHOW TABLES LIKE 'warning_data'")
                    table_exists = await cursor.fetchone()

                    sql = """
                          CREATE TABLE IF NOT EXISTS warning_data (
                              id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                              warning_type VARCHAR(10) NOT NULL COMMENT '警告类型：T(温度), H(湿度), B(亮度), S(ppm), P(大气压)',
                              warning_message VARCHAR(100) NOT NULL COMMENT '警告消息（原始消息）',
                              warning_value DECIMAL(10, 2) DEFAULT NULL COMMENT '异常值（如果是异常数据）',
                              is_resolved TINYINT DEFAULT 0 COMMENT '是否已恢复：0=未恢复, 1=已恢复',
                              warning_start_time DATETIME NOT NULL COMMENT '异常开始时间',
                              warning_resolved_time DATETIME DEFAULT NULL COMMENT '恢复正常时间',
                              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '记录创建时间',
                              INDEX idx_warning_type (warning_type),
                              INDEX idx_warning_start_time (warning_start_time),
                              INDEX idx_is_resolved (is_resolved),
                              INDEX idx_created_at (created_at)
                          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                          COMMENT='警告数据表，存储传感器异常警告信息'
                          """
                    if not table_exists:
                        await cursor.execute(sql)
        except Exception as e:
            print(f"【数据库】创建警告数据表失败：{e}")

    async def ensure_sensor_readings_table(self):
        """确保传感器数据表存在"""
        try:
            async with self.get_connection() as conn:
                async with conn.cursor() as cursor:
                    await cursor.execute("SHOW TABLES LIKE 'sensor_readings'")
                    table_exists = await cursor.fetchone()

                    sql = """
                          CREATE TABLE IF NOT EXISTS sensor_readings (
                              id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
                              timestamp DATETIME NOT NULL COMMENT '数据采集时间',
                              temperature DECIMAL(5, 2) NOT NULL COMMENT '温度（摄氏度）',
                              humidity DECIMAL(5, 2) NOT NULL COMMENT '湿度（百分比）',
                              brightness DECIMAL(7, 2) NULL DEFAULT NULL COMMENT '亮度（勒克斯）',
                              smoke_ppm DECIMAL(7, 2) NULL DEFAULT NULL COMMENT '烟雾浓度（PPM）',
                              rs_ro DECIMAL(10, 2) NULL DEFAULT NULL COMMENT 'Rs/Ro传感器电阻比值',
                              temp2 DECIMAL(5, 2) NULL DEFAULT NULL COMMENT '二号温度传感器(°C)',
                              pressure DECIMAL(7, 2) NULL DEFAULT NULL COMMENT '气压(hPa)',
                              created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP COMMENT '记录创建时间',
                              PRIMARY KEY (id) USING BTREE,
                              INDEX idx_timestamp(timestamp) USING BTREE COMMENT '时间戳索引',
                              INDEX idx_created_at(created_at) USING BTREE COMMENT '创建时间索引'
                          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                          COMMENT='传感器数据表'
                          """
                    if not table_exists:
                        await cursor.execute(sql)
        except Exception as e:
            print(f"【数据库】创建传感器数据表失败：{e}")

    async def set_sensor_state(self, sensor_name: str, sensor_state: str = None, via: str = UNSET,
                               mode: str = UNSET, next_run_time: float = UNSET, last_value: float = UNSET,
                               phase: str = UNSET, phase_message: str = UNSET, phase_until: float = UNSET,
                               samples_collected: int = UNSET, samples_target: int = UNSET):
        """保存传感器状态"""
        sensor_name = sensor_name.upper()
        normalized_state = sensor_state.lower() if sensor_state else None
        try:
            await self.ensure_sensor_state_table()
            async with self.get_connection() as conn:
                async with conn.cursor() as cursor:
                    # 检查字段是否存在（普通cursor返回tuple，用row[0]）
                    await cursor.execute("DESCRIBE `sensor_states`")
                    columns = {row[0] for row in await cursor.fetchall()}

                    # 检查记录是否存在，便于在未提供状态时保持原值
                    await cursor.execute("SELECT sensor_state FROM `sensor_states` WHERE `sensor_name` = %s LIMIT 1",
                                         (sensor_name,))
                    existing_row = await cursor.fetchone()
                    record_exists = existing_row is not None

                    if normalized_state is None:
                        if record_exists and existing_row[0] is not None:
                            normalized_state = existing_row[0]
                        else:
                            normalized_state = 'on'

                    columns_clause = ["`sensor_name`", "`sensor_state`"]
                    values_clause = ["%s", "%s"]
                    sql_values = [sensor_name, normalized_state]
                    alias = "new_state"

                    def alias_ref(column: str) -> str:
                        return f"{alias}.`{column}`"

                    updates_clause = [f"`sensor_state` = {alias_ref('sensor_state')}"]

                    if via is not UNSET:
                        columns_clause.append("`last_via`")
                        values_clause.append("%s")
                        sql_values.append(via)
                        updates_clause.append(f"`last_via` = {alias_ref('last_via')}")

                    if mode is not UNSET and 'mode' in columns:
                        columns_clause.append("`mode`")
                        values_clause.append("%s")
                        sql_values.append(mode)
                        updates_clause.append(f"`mode` = {alias_ref('mode')}")

                    if next_run_time is not UNSET and 'next_run_time' in columns:
                        columns_clause.append("`next_run_time`")
                        values_clause.append("FROM_UNIXTIME(%s)")
                        sql_values.append(next_run_time)
                        updates_clause.append(f"`next_run_time` = {alias_ref('next_run_time')}")

                    if last_value is not UNSET and 'last_value' in columns:
                        columns_clause.append("`last_value`")
                        values_clause.append("%s")
                        sql_values.append(last_value)
                        updates_clause.append(f"`last_value` = {alias_ref('last_value')}")

                    if phase is not UNSET and 'phase' in columns:
                        columns_clause.append("`phase`")
                        values_clause.append("%s")
                        sql_values.append(phase)
                        updates_clause.append(f"`phase` = {alias_ref('phase')}")

                    if phase_message is not UNSET and 'phase_message' in columns:
                        columns_clause.append("`phase_message`")
                        values_clause.append("%s")
                        sql_values.append(phase_message)
                        updates_clause.append(f"`phase_message` = {alias_ref('phase_message')}")

                    if phase_until is not UNSET and 'phase_until' in columns:
                        columns_clause.append("`phase_until`")
                        values_clause.append("FROM_UNIXTIME(%s)")
                        sql_values.append(phase_until)
                        updates_clause.append(f"`phase_until` = {alias_ref('phase_until')}")

                    if samples_collected is not UNSET and 'samples_collected' in columns:
                        columns_clause.append("`samples_collected`")
                        values_clause.append("%s")
                        sql_values.append(samples_collected)
                        updates_clause.append(f"`samples_collected` = {alias_ref('samples_collected')}")

                    if samples_target is not UNSET and 'samples_target' in columns:
                        columns_clause.append("`samples_target`")
                        values_clause.append("%s")
                        sql_values.append(samples_target)
                        updates_clause.append(f"`samples_target` = {alias_ref('samples_target')}")

                    updates_clause.append("`updated_at` = CURRENT_TIMESTAMP")

                    sql = f"""
                          INSERT INTO `sensor_states` ({', '.join(columns_clause)})
                          VALUES ({', '.join(values_clause)}) AS {alias}
                          ON DUPLICATE KEY UPDATE
                              {', '.join(updates_clause)}
                          """
                    await cursor.execute(sql, sql_values)
                    return True
        except Exception as e:
            print(f"【数据库】保存传感器状态失败：{e}")
            import traceback
            traceback.print_exc()
            return False

    async def get_sensor_state(self, sensor_name: str):
        """获取传感器状态"""
        sensor_name = sensor_name.upper()
        try:
            await self.ensure_sensor_state_table()
            async with self.get_connection() as conn:
                async with conn.cursor(aiomysql.DictCursor) as cursor:
                    # 先检查字段是否存在（DictCursor返回dict，需要用key取值）
                    await cursor.execute("DESCRIBE `sensor_states`")
                    rows = await cursor.fetchall()
                    columns = {row["Field"] for row in rows}

                    # 构建SELECT字段列表（确保字段存在且加反引号）
                    select_fields = []
                    if 'sensor_state' in columns:
                        select_fields.append("`sensor_state`")
                    if 'last_via' in columns:
                        select_fields.append("`last_via`")
                    if 'mode' in columns:
                        select_fields.append("`mode`")
                    if 'next_run_time' in columns:
                        select_fields.append("UNIX_TIMESTAMP(`next_run_time`) AS `next_run_time`")
                    if 'last_value' in columns:
                        select_fields.append("`last_value`")
                    if 'phase' in columns:
                        select_fields.append("`phase`")
                    if 'phase_message' in columns:
                        select_fields.append("`phase_message`")
                    if 'phase_until' in columns:
                        select_fields.append("UNIX_TIMESTAMP(`phase_until`) AS `phase_until`")
                    if 'samples_collected' in columns:
                        select_fields.append("`samples_collected`")
                    if 'samples_target' in columns:
                        select_fields.append("`samples_target`")
                    if 'updated_at' in columns:
                        select_fields.append("UNIX_TIMESTAMP(`updated_at`) AS `updated_at`")
                    
                    # 如果没有任何字段，至少查询基本字段
                    if not select_fields:
                        select_fields = ["`sensor_state`", "`last_via`"]

                    sql = f"""
                          SELECT {', '.join(select_fields)}
                          FROM `sensor_states`
                          WHERE `sensor_name` = %s
                          """
                    await cursor.execute(sql, (sensor_name,))
                    result = await cursor.fetchone()

                    # 如果字段不存在，设置默认值
                    if result:
                        if 'mode' not in result:
                            result['mode'] = 'balance'
                        if 'next_run_time' not in result:
                            result['next_run_time'] = None
                        if 'last_value' not in result:
                            result['last_value'] = None
                        if 'phase' not in result:
                            result['phase'] = 'idle'
                        if 'phase_message' not in result:
                            result['phase_message'] = None
                        if 'phase_until' not in result:
                            result['phase_until'] = None
                        if 'samples_collected' not in result:
                            result['samples_collected'] = None
                        if 'samples_target' not in result:
                            result['samples_target'] = None

                    return result
        except Exception as e:
            print(f"【数据库】获取传感器状态失败：{e}")
            import traceback
            traceback.print_exc()
            return None


# 全局数据库管理器实例
db_manager = None

def get_db_manager(host=database_info.get("host"), port=database_info.get("port"), user=database_info.get("user"),
                   password=database_info.get("password"), database=database_info.get("database")) -> DatabaseManager:
    """获取全局数据库管理器实例"""
    global db_manager
    if db_manager is None:
        db_manager = DatabaseManager(host, port, user, password, database)
    return db_manager
