"""Cerebrate 配置管理 — 支持 .env 文件加载"""
import os
from pathlib import Path
from dataclasses import dataclass, field


def _load_dotenv():
    """加载 .env 文件到 os.environ (不覆盖已有环境变量)"""
    candidates = [
        Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))) / ".env",
        Path.cwd() / ".env",
    ]
    for env_file in candidates:
        if not env_file.exists():
            continue
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key not in os.environ:
                    os.environ[key] = val


_load_dotenv()


@dataclass
class CerebrateConfig:
    # 项目根目录
    project_root: Path = field(default_factory=lambda: Path(
        os.environ.get("CEREBRATE_ROOT", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ))

    # 记忆存储路径
    memory_root: Path = field(
        default_factory=lambda: Path(os.environ.get(
            "CEREBRATE_MEMORY_ROOT",
            os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "memory"),
        ))
    )
    personal_path: Path = field(init=False)
    swarm_path: Path = field(init=False)
    knowledge_path: Path = field(init=False)
    evolution_path: Path = field(init=False)
    agents_path: Path = field(init=False)
    queue_path: Path = field(init=False)
    archive_path: Path = field(init=False)
    seeds_path: Path = field(init=False)
    usage_path: Path = field(init=False)

    # 项目上下文
    current_project_id: str = field(
        default_factory=lambda: os.environ.get("CEREBRATE_PROJECT_ID", "")
    )
    current_project_name: str = field(
        default_factory=lambda: os.environ.get("CEREBRATE_PROJECT_NAME", "")
    )

    # LLM 配置
    llm_provider: str = field(default_factory=lambda: os.environ.get("CEREBRATE_LLM_PROVIDER", "anthropic"))
    llm_model: str = field(default_factory=lambda: os.environ.get("CEREBRATE_LLM_MODEL", "claude-sonnet-4-6"))

    # 免疫系统配置
    immune_enabled: bool = field(default_factory=lambda: os.environ.get("CEREBRATE_IMMUNE_ENABLED", "true").lower() == "true")
    immune_threshold: float = field(default_factory=lambda: float(os.environ.get("CEREBRATE_IMMUNE_THRESHOLD", "0.7")))

    # 进化配置
    evolution_enabled: bool = field(default_factory=lambda: os.environ.get("CEREBRATE_EVOLUTION_ENABLED", "true").lower() == "true")
    evolution_interval_hours: int = field(default_factory=lambda: int(os.environ.get("CEREBRATE_EVOLUTION_INTERVAL", "24")))
    decay_half_life_days: float = field(default_factory=lambda: float(os.environ.get("CEREBRATE_DECAY_HALF_LIFE", "30")))

    # 虫群配置
    swarm_enabled: bool = field(default_factory=lambda: os.environ.get("CEREBRATE_SWARM_ENABLED", "true").lower() == "true")
    default_language: str = field(default_factory=lambda: os.environ.get("CEREBRATE_LANGUAGE", "简体中文"))

    # 语义搜索配置
    semantic_index_path: Path = field(init=False)

    # ChromaDB 向量数据库配置 (v4.0)
    chroma_path: Path = field(init=False)
    embedding_model: str = field(
        default_factory=lambda: os.environ.get("CEREBRATE_EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5")
    )
    embedding_device: str = field(
        default_factory=lambda: os.environ.get("CEREBRATE_EMBEDDING_DEVICE", "cpu")
    )
    embedding_hash_dim: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_HASH_EMBEDDING_DIM", "384"))
    )
    embedding_allow_download: bool = field(
        default_factory=lambda: os.environ.get("CEREBRATE_EMBEDDING_ALLOW_DOWNLOAD", "false").lower() == "true"
    )
    use_chroma: bool = field(
        default_factory=lambda: os.environ.get("CEREBRATE_USE_CHROMA", "true").lower() == "true"
    )

    def __post_init__(self):
        self.personal_path = self.memory_root / "personal"
        self.swarm_path = self.memory_root / "swarm"
        self.knowledge_path = self.memory_root / "knowledge"
        self.evolution_path = self.memory_root / "evolution"
        self.agents_path = self.memory_root / "agents"
        self.queue_path = self.memory_root / ".queue"
        self.archive_path = self.memory_root / ".archived"
        self.seeds_path = self.memory_root / "seeds"
        self.usage_path = self.memory_root / "usage"
        self.semantic_index_path = self.memory_root / "_semantic_index.json"
        self.chroma_path = self.memory_root / "chroma_data"


config = CerebrateConfig()
