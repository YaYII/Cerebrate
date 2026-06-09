"""Cerebrate 配置管理 — 支持 .env 文件加载"""
import os
from pathlib import Path
from dataclasses import dataclass, field


def _load_dotenv():
    """加载 .env 文件到 os.environ (不覆盖已有环境变量)"""
    candidates = [
        Path(os.path.dirname(os.path.abspath(__file__))) / ".env",
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
        os.environ.get("CEREBRATE_ROOT", os.path.dirname(os.path.abspath(__file__)))
    ))

    # 记忆存储路径
    memory_root: Path = field(
        default_factory=lambda: Path(os.environ.get(
            "CEREBRATE_MEMORY_ROOT",
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "memory"),
        ))
    )
    personal_path: Path = field(init=False)
    swarm_path: Path = field(init=False)
    knowledge_path: Path = field(init=False)
    evolution_path: Path = field(init=False)
    agents_path: Path = field(init=False)
    events_path: Path = field(init=False)
    docstore_path: Path = field(init=False)

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

    # ChromaDB 向量数据库配置 (v5)
    chroma_path: Path = field(init=False)
    embedding_model: str = field(
        default_factory=lambda: os.environ.get("CEREBRATE_EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5")
    )
    embedding_device: str = field(
        default_factory=lambda: os.environ.get("CEREBRATE_EMBEDDING_DEVICE", "cpu")
    )
    embedding_hash_dim: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_HASH_EMBEDDING_DIM", "1024"))
    )
    embedding_allow_download: bool = field(
        default_factory=lambda: os.environ.get("CEREBRATE_EMBEDDING_ALLOW_DOWNLOAD", "false").lower() == "true"
    )
    embedding_max_length: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_EMBEDDING_MAX_LENGTH", "8192"))
    )
    embedding_summary_chars: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_EMBEDDING_SUMMARY_CHARS", "1000"))
    )
    use_chroma: bool = field(
        default_factory=lambda: os.environ.get("CEREBRATE_USE_CHROMA", "true").lower() == "true"
    )

    # 分块配置
    chunk_enabled: bool = field(
        default_factory=lambda: os.environ.get("CEREBRATE_CHUNK_ENABLED", "true").lower() == "true"
    )
    chunk_max_chars: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_CHUNK_MAX_CHARS", "8000"))
    )
    chunk_overlap_chars: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_CHUNK_OVERLAP_CHARS", "100"))
    )
    chunk_min_chars: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_CHUNK_MIN_CHARS", "200"))
    )

    # ReRanker 配置
    reranker_enabled: bool = field(
        default_factory=lambda: os.environ.get("CEREBRATE_RERANKER_ENABLED", "true").lower() == "true"
    )
    reranker_model: str = field(
        default_factory=lambda: os.environ.get("CEREBRATE_RERANKER_MODEL", "BAAI/bge-reranker-v2-m3")
    )
    reranker_top_k: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_RERANKER_TOP_K", "10"))
    )

    # 查询重写配置
    query_rewrite_enabled: bool = field(
        default_factory=lambda: os.environ.get("CEREBRATE_QUERY_REWRITE_ENABLED", "true").lower() == "true"
    )
    query_rewrite_max_variations: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_QUERY_REWRITE_MAX_VARIATIONS", "3"))
    )

    # 上下文扩展配置
    context_expand_enabled: bool = field(
        default_factory=lambda: os.environ.get("CEREBRATE_CONTEXT_EXPAND_ENABLED", "true").lower() == "true"
    )
    context_expand_chars: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_CONTEXT_EXPAND_CHARS", "1500"))
    )

    # 相关性过滤配置
    relevance_filter_enabled: bool = field(
        default_factory=lambda: os.environ.get("CEREBRATE_RELEVANCE_FILTER_ENABLED", "true").lower() == "true"
    )

    # 记忆最小长度（token 数）
    memory_min_tokens: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_MEMORY_MIN_TOKENS", "500"))
    )

    # PostgreSQL 元数据层配置
    database_url: str = field(
        default_factory=lambda: os.environ.get("CEREBRATE_DATABASE_URL", "")
    )
    pg_host: str = field(
        default_factory=lambda: os.environ.get("CEREBRATE_PG_HOST", "127.0.0.1")
    )
    pg_port: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_PG_PORT", "5432"))
    )
    pg_db: str = field(
        default_factory=lambda: os.environ.get("CEREBRATE_PG_DB", "cerebrate")
    )
    pg_user: str = field(
        default_factory=lambda: os.environ.get("CEREBRATE_PG_USER", "cerebrate")
    )
    pg_password: str = field(
        default_factory=lambda: os.environ.get("CEREBRATE_PG_PASSWORD", "")
    )

    # HTTP Brain Server
    server_host: str = field(default_factory=lambda: os.environ.get("CEREBRATE_SERVER_HOST", "127.0.0.1"))
    server_port: int = field(default_factory=lambda: int(os.environ.get("CEREBRATE_SERVER_PORT", "8765")))
    server_url: str = field(default_factory=lambda: os.environ.get("CEREBRATE_SERVER_URL", ""))
    server_token: str = field(default_factory=lambda: os.environ.get("CEREBRATE_SERVER_TOKEN", ""))

    def __post_init__(self):
        self.personal_path = self.memory_root / "personal"
        self.swarm_path = self.memory_root / "swarm"
        self.knowledge_path = self.memory_root / "knowledge"
        self.evolution_path = self.memory_root / "evolution"
        self.agents_path = self.memory_root / "agents"
        self.events_path = self.memory_root / "events"
        self.chroma_path = self.memory_root / "chroma_data"
        self.docstore_path = self.memory_root / "docstore"


config = CerebrateConfig()
