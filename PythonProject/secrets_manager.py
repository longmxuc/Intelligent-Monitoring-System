"""
密钥管理工具
负责从项目根目录的 secrets.txt 文件中加载敏感配置。
"""

from pathlib import Path

# 项目根目录（与 server.py/db_manager.py 同级）
PROJECT_DIR = Path(__file__).parent
SECRETS_FILE = PROJECT_DIR / "secrets.txt"


def load_secrets(file_path: Path = SECRETS_FILE) -> dict:
    """
    从文本文件加载敏感配置。

    文件格式：每行使用 KEY=VALUE，支持以 # 开头的注释行和空行。
    """
    secrets: dict = {}
    try:
        with file_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip()
                if key:
                    secrets[key] = value
    except FileNotFoundError:
        print(f"【警告】未找到密钥文件：{file_path}，请创建该文件并写入 MQTT_USERNAME/MQTT_PASSWORD/DEEPSEEK_API_KEY/DB_PASSWORD/AMAP_WEB_KEY 等配置。")
    except Exception as e:
        print(f"【警告】读取密钥文件失败：{e}，请检查 {file_path} 的内容格式。")
    return secrets


# 全局密钥字典
SECRETS = load_secrets()
