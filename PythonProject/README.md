# STM32 智能环境监测系统 Beta 3

基于 **FastAPI + WebSocket + MQTT + BLE + MySQL** 的实时环境感知平台，整合多源传感器数据、远程设备控制、异常预警、地图定位以及 AI 辅助分析，为实验室、机房或宿舍场景提供“端云一体”的数据采集与可视化能力。  
> 👉 在线体验地址：https://znhj.iepose.cn

## 功能亮点
- **多通道采集**：优先使用蓝牙（Bleak）直连，自动回落到 MQTT（EMQX）云端数据，保证链路连续性。
- **实时可视化**：`web/index.html` 提供 PWA 化的仪表板（深浅色、移动端适配、极简加载页、打点地图、消息中心、MQ2 模式指示等）。
- **历史分析**：`web/analysis.html` 通过 Chart.js/自研工具完成区间筛选、时间轴自适配、指标对比与异常分层展示。
- **告警闭环**：`warning_data` 表记录所有异常；`AUTO_RECOVERY` 逻辑监控连续包恢复；前端消息中心支持按日期筛选。
- **设备调度**：针对 MQ2 传感器提供 `eco/balance/safe/always/dev` 等供电模式，REST API + Web 操作双通道控制。
- **AI 助手**：对接 DeepSeek 模型，支持在线/离线模型切换、健康检查端点、流式应答与多轮上下文。
- **可扩展脚本**：内置数据库连通性诊断、传感器状态持久化、自愈逻辑，便于本地/云端部署，为后期开发鸿蒙版本做准备。

## 系统架构
```
┌────────────┐   BLE (Bleak)          ┌────────────┐
│ 传感器节点 │ ───────────────┐       │  MQTT Broker │  (TLS/CA)
└────────────┘                │       └────────────┘
                              ▼
                    ┌──────────────────┐
                    │  server.py (FastAPI)
                    │  • MQTT 消费 & 命令下发
                    │  • BLE 客户端 & 设备调度
                    │  • WebSocket 推送
                    │  • REST API & AI 代理
                    │  • MySQL 持久化
                    └──────────────────┘
                              │
                ┌─────────────┴─────────────┐
                │                           │
        ┌──────────────┐           ┌────────────────┐
        │ MySQL (sensor│           │ Web 前端 (PWA) │
        │ _readings /  │◀─Axios───▶│ index / analysis│
        │ warning_data)│   API     │+ common.js      │
        └──────────────┘           └────────────────┘
```

## 主要目录结构

后期可能还会再改变项目结构不便于更新README，但是这些是最重要的。

> 如果你要运行本项目，你需要在目录下创建 secrets.txt 在当中配置API密钥等。后面讲结构。

```
.
├── server.py               # FastAPI 入口 + 业务逻辑
├── db_manager.py           # MySQL 连接池 & 表管理 & 数据访问
├── secrets_manager.py      # 解析 secrets.txt 为字典传给 server.py
├── requirements.txt        # Python 依赖列表
├── secrets.txt             # 存放API密钥
├── web/                    # 前端静态资源
│   ├── index.html          # 实时数据页面
│   ├── analysis.html       # 历史分析页面
│   ├── continued.html      # 极简加载/过渡页
│   ├── changelog-data.js   # 项目的更新日志存放于此
│   ├── common.js           # 共享逻辑（主题、图表、时间轴等）
│   └── common-styles.css   # 统一样式
└── resource/               # Manifest、PWA 图标、品牌素材
```

## 环境要求
- Python 3.8+（建议使用虚拟环境）
- MySQL 8.0（或兼容版本）
- MQTT Broker（默认 EMQX TLS 8883）
- 可选：支持 BLE 的操作系统（Windows 需额外事件循环策略）
- 可选：DeepSeek API Key（启用在线 AI 模型）

## 快速开始
1. **获取代码并安装依赖**
   ```bash
   git clone <repo-url>
   cd PythonProject
   python -m venv .venv && source .venv/bin/activate  # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```
2. **编写secrets.txt文件**
   - 在项目根目录下创建`secrets.txt` 填入以下配置：
     ```text
     # MQTT 账号配置
     MQTT_USERNAME=
     MQTT_PASSWORD=
     
     # DeepSeek API Key
     DEEPSEEK_API_KEY=
     
     # 数据库 （根据你的系统填写）
     DB_ADDR_MAC=
     DB_PASSWORD_MAC=
     DB_ADDR_WIN=
     DB_PASSWORD_WIN=
     DB_ADDR_LINUX=
     DB_PASSWORD_LINUX=
     
     # 高德地图 Web JS API Key
     AMAP_WEB_KEY=
     ```
3. **配置数据库**
   - 在 MySQL 中创建 `sensor_data` 数据库：  
     ```sql
     CREATE DATABASE sensor_data CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
     ```
   - 确认 `db_manager.py` 与 `secrets.txt` 的地址密码是否完整。
   - 首次运行时 `DatabaseManager.ensure_*` 会自动创建 `sensor_readings`、`warning_data`、`sensor_states` 等表。
4. **配置数据源**
   - 在 `server.py` 修改以下核心常量：
     - `MQTT_BROKER / MQTT_PORT / MQTT_TOPIC / MQTT_CMD_TOPIC`
     - `BLE_DEVICES`：名称与 MAC 地址映射
5. **启动服务**
   ```bash
   python server.py
   # 或开发模式
   uvicorn server:app --host 0.0.0.0 --port 8001 --reload
   ```
   访问 `http://localhost:8001` 查看实时看板，`http://localhost:8001/analysis.html` 查看历史分析。
6. **验证链路**
   - 浏览器控制台的 WebSocket 日志 & 指标卡片状态。
   - `GET http://localhost:8001/api/status` 返回 BLE/MQTT/数据库等健康信息。

## 关键配置项
| 文件 | 位置 | 说明 |
| --- | --- | --- |
| `server.py` | `MQTT_*` 常量 | MQTT Broker 地址、端口、主题、证书路径、鉴权 |
| `server.py` | `BLE_DEVICES` | 蓝牙传感器别名 → MAC 地址映射 |
| `server.py` | `DEEPSEEK_API_KEY` / `DEEPSEEK_ONLINE_MODELS` | AI 助手模型配置 |
| `db_manager.py` | `database_info` | MySQL 连接配置 |
| `web/index.html` | 高德地图脚本 | 绑定高德 Key |
| `resource/manifest.json` | `short_name` / `start_url` 等 | 调整 PWA 名称与图标 |

## API 与前端入口
- 页面
  - `GET /`：实时看板（含连接状态、MQ2 模式、地图、报警卡片、AI 面板入口）
  - `GET /analysis.html`：历史趋势分析（时间区间、传感器子图、统计摘要）
  - `GET /continued.html`：全屏过渡/占位页
- 数据/控制接口（节选）
  - `GET /api/history?limit=100`：最近记录
  - `GET /api/history/range?start=unix&end=unix`：按时间范围查询
  - `GET /api/warnings`、`GET /api/warnings/dates`：警告列表 & 日历
  - `POST /api/mq2/switch`、`GET /api/mq2/state`、`POST /api/mq2/mode`：MQ2 供电控制
  - `POST /api/location/query`：触发定位命令并返回解析结果
  - `POST /api/ai/chat`、`GET /api/ai/models`、`GET /api/ai/health`：AI 助手接口
  - `GET /api/status`：BLE/MQTT/数据库/AI 状态探针
  - `WebSocket /ws`：实时推送最新指标、警告与系统广播

## 数据库说明
- `sensor_readings`：温湿度、亮度、烟雾浓度、Rs/Ro、二号温度、气压等核心数据。
- `warning_data`：异常类型、告警消息、异常值、恢复时间与索引。
- `sensor_states`：MQ2 等设备的模式、供电周期、下一次运行计划、采样进度。
- 所有表使用 `utf8mb4`，并在 `db_manager.DatabaseManager` 中提供 `ensure_*` 方法自动创建/迁移字段。

> 如在构建或部署过程中遇到问题，欢迎提交 Issue 或 PR。祝使用顺利！

<br><br><br><br><br>
=======================================<h4>以下为更新日志<h4/>=======================================<br><br><br><br><br>


<!-- CHANGELOG_START -->
## 更新日志
> 以下内容由 `node scripts/update_readme_changelog.mjs` 自动生成，数据来源 `web/changelog-data.js`。

### Beta 3.11.18 · 2025.11.18
- 添加了AI助手的对话终止功能，判断如果正在对话则显示终止按钮。
- 修改了大气压警告消息阈值。
- 制作PCB Version 2.1。

### Beta 3.11.16 · 2025.11.16
- 修复了一些前端页面的排版问题。

### Beta 3.11.15 · 2025.11.15
- 添加了切换省电模式以及开关传感器需要验证密码的功能。

### Beta 3.11.12 · 2025.11.12 ⭐
- 添加了MOSFET与MQ2与GND之间，使用GPIO OUTPUT即可单独控制MQ2传感器的地线是否导通，STM32使用中断回调控制MOSFET是否导通。
- 添加了省电控制功能选项。
- 添加了省电控制中心，用于显示可用于省电的模块。
- 添加了烟雾传感器控制窗口，现在有五种不同的智能控制模式(开发者模式隐藏于菜单中，为30秒开10秒关)。
- 添加了后端与STM32控制MOSFET是否导通的通信API，智能选择蓝牙或者MQTT通信。
- 修复了明明数据还是异常状态，后端却自动恢复的BUG，原因是后端异常消息数据阈值与单片机阈值不一样。
- 修改了STM32上的4GDTU串口发送实时数据的频率，现在是5秒一包。
- 从现在开始将大大延长续航时间，默认使用省电模式。
- 从Beta 3开始项目于Github/Gitee开源。

### Beta 2.11.11 · 2025.11.11
- 修复了当亮度为0时，前端不显示当前异常数据的BUG。
- 修复了iOS Safari浏览器显示快捷回复Grid异常肥大的BUG，优化滚动监听和位置更新逻辑。
- 修改了STM32警告消息温度和亮度的阈值，现在是15<温度<27，5<亮度<2000。

### Beta 2.11.10 · 2025.11.10
- 添加了重要更新的标识。
- 添加了当用户发送消息给AI，自动拖动的最底部的功能。
- 修复了当BT27被物理移除时，MQTT卡入循环导致无法更新数据的BUG。
- 修复超小屏手机的主页卡片对不齐问题。

### Beta 2.11.9 · 2025.11.9
- 开始HarmonyOS原生APP开发。

### Beta 2.11.8 · 2025.11.8
- 添加了功能按钮的流光溢彩呼吸效果，现在功能按钮更为醒目。
- 添加了异常消息自动恢复的功能，现在后端收到超过3个正常数据包在合理阈值内，就会自动标记为安全，不用等待STM32回复了。
- 添加了手机端AI数据的预设问题按钮，预设问题都收纳于此。
- 屏蔽了来自MQTT的第一条消息，通常是MQTT Broker暂存的温湿度信息，这条数据在服务器调试的时候会反复存入数据库。
- 修改了STM32警告消息湿度和亮度的阈值，现在是30<湿度<75，0.5<亮度<2000。
- 修复了加载一次数据弹两次不一样弹窗的BUG。

### Beta 2.11.7 · 2025.11.7
- 添加了炫酷的AI标识。
- 复用了后端API，现在AI助手也能看到消息中心了。
- 增强了AI数据分析助手的数据输入，提供更全面的统计信息、时间序列数据和警告数据，提升分析质量。
- 修复了某些情况下图表对象可能已创建，但data尚未初始化导致被加载默认100条数据的逻辑Try到了而报错的BUG。
- 移除了自动加载开屏动画，因为无法找到部分Android设备动画闪烁的原因，现在为一个彩蛋 : )

### Beta 2.11.6 · 2025.11.6
- 添加了关于项目，使用帮助移动至关于项目。
- 添加了更新日志功能，现在可以实时查看开发进度。
- 添加了消息中心的日期筛选功能，现在可以根据日期筛选消息。
- 添加了点击消息中心之外即可关闭消息中心的功能。
- 修改了STM32警告消息温度和亮度的阈值，现在是15<温度<30，1<亮度<2000。
- 修改了消息通知的红色圆角样式，现在看起来更协调。
- 移除了消息中心的自动刷新功能，不会再自动拉到顶端了。

### Beta 2.11.5 · 2025.11.5 ⭐
- 添加了前端定位功能的支持，调用高德地图API。
- 添加了消息中心页面，现在可以实时接收来自STM32串口发送的异常数据，智能判断通过蓝牙串口或者MQTT串口发送数据，并记录保存在数据库。目前异常数据阈值是100<亮度<2000，-10<温度<25，40<湿度<70，PPM<50，1000<大气压<1020，解除异常状态后，单片机会再次通过串口发送信息确认安全。
- 融合了开屏动画，仅首次进入浏览器展示，或者等待数十秒，目前是40秒。
- 修改了加载数据的逻辑，现在加载数据会根据数据量大小动态调整加载间隔，加载大量数据不再卡顿。

### Beta 1.11.4 · 2025.11.4
- 本次无软件更新
- 制作PCB Version 1.0。

> ……其余 12 条请查看在线网站`https://znhj.iepose.cn`-功能-关于项目 或者 `web/changelog-data.js`
<!-- CHANGELOG_END -->
