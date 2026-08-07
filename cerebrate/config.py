"""Cerebrate 配置管理 — 支持 .env 文件加载."""
import os
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path


def _load_dotenv():
    """加载 .env 文件到 os.environ (不覆盖已有环境变量)."""
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
    """
    全局配置（dataclass），集中管理路径/模型/服务端口等运行参数。.

    字段支持从环境变量或 .env 文件覆盖（如 CEREBRATE_MEMORY_ROOT / CEREBRATE_CHROMA_PATH），
    并提供 ensure_dirs 等方法在启动时准备目录结构。
    """

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
    logs_path: Path = field(init=False)
    docstore_path: Path = field(init=False)

    # 项目上下文
    current_project_id: str = field(
        default_factory=lambda: os.environ.get("CEREBRATE_PROJECT_ID", "")
    )

    # LLM 配置
    llm_provider: str = field(default_factory=lambda: os.environ.get("CEREBRATE_LLM_PROVIDER", "anthropic"))
    llm_model: str = field(default_factory=lambda: os.environ.get("CEREBRATE_LLM_MODEL", "claude-sonnet-4-6"))
    # LLM 调用超时（秒）：防网络挂起占满 HTTP worker 线程导致服务假死（v5.2.1 修复）
    llm_timeout_seconds: float = field(
        default_factory=lambda: float(os.environ.get("CEREBRATE_LLM_TIMEOUT", "60"))
    )

    # 免疫系统配置
    immune_enabled: bool = field(default_factory=lambda: os.environ.get("CEREBRATE_IMMUNE_ENABLED", "true").lower() == "true")
    immune_threshold: float = field(default_factory=lambda: float(os.environ.get("CEREBRATE_IMMUNE_THRESHOLD", "0.7")))

    # 进化配置
    evolution_interval_hours: int = field(default_factory=lambda: int(os.environ.get("CEREBRATE_EVOLUTION_INTERVAL", "24")))
    decay_half_life_days: float = field(default_factory=lambda: float(os.environ.get("CEREBRATE_DECAY_HALF_LIFE", "30")))

    # 蒸馏窗口（v5.1.1，用户要求：仅在本地 0:00-1:00 低谷期运行，其他时间禁止蒸馏省钱）
    evolution_window_enabled: bool = field(
        default_factory=lambda: os.environ.get("CEREBRATE_EVOLUTION_WINDOW_ENABLED", "true").lower() == "true"
    )
    evolution_window_start_hour: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_EVOLUTION_WINDOW_START_HOUR", "0"))
    )
    evolution_window_end_hour: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_EVOLUTION_WINDOW_END_HOUR", "1"))
    )
    # 本地时区偏移（Asia/Macau UTC+8，全年无夏令时 → 固定 +8）
    evolution_window_tz_offset_hours: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_EVOLUTION_WINDOW_TZ_OFFSET", "8"))
    )

    # 原始记忆归档保留（防删策略）：<=0 = 永不删除（默认，符合「任何记忆都有原始归档，防止被删除」）
    origin_retention_days: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_ORIGIN_RETENTION_DAYS", "0"))
    )

    # 虫群配置
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

    # 结构化字段增强（Phase 4）：
    # title_compress_enabled: LLM 语义压缩标题（写路径增加一次 LLM 调用，默认关闭）
    # structured_enrich_enabled: LLM 提取 facts/concepts（写路径增加一次 LLM 调用，默认关闭）
    # 规则提取（observation_type/concepts/facts/token_estimate）始终生效，不受此开关影响
    title_compress_enabled: bool = field(
        default_factory=lambda: os.environ.get("CEREBRATE_TITLE_COMPRESS_ENABLED", "false").lower() == "true"
    )
    structured_enrich_enabled: bool = field(
        default_factory=lambda: os.environ.get("CEREBRATE_STRUCTURED_ENRICH_ENABLED", "false").lower() == "true"
    )

    # 记忆最小长度（token 数）
    memory_min_tokens: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_MEMORY_MIN_TOKENS", "500"))
    )

    # ── 并发/性能配置（阶段 1 扩展）──
    db_semaphore: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_DB_SEMAPHORE", "16"))
    )
    http_max_threads: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_HTTP_MAX_THREADS", "64"))
    )
    embedding_query_cache_size: int = field(
        default_factory=lambda: int(os.environ.get("CEREBRATE_EMBEDDING_QUERY_CACHE", "512"))
    )

    # FTS5 全文索引（Phase 3）：默认开启；SQLite 失败时自动降级为向量检索
    fulltext_enabled: bool = field(
        default_factory=lambda: os.environ.get("CEREBRATE_FULLTEXT_ENABLED", "true").lower() == "true"
    )

    # HTTP Brain Server
    server_host: str = field(default_factory=lambda: os.environ.get("CEREBRATE_SERVER_HOST", "127.0.0.1"))
    server_port: int = field(default_factory=lambda: int(os.environ.get("CEREBRATE_SERVER_PORT", "8765")))
    server_token: str = field(default_factory=lambda: os.environ.get("CEREBRATE_SERVER_TOKEN", ""))

    def __post_init__(self):
        self.personal_path = self.memory_root / "personal"
        self.swarm_path = self.memory_root / "swarm"
        self.knowledge_path = self.memory_root / "knowledge"
        self.evolution_path = self.memory_root / "evolution"
        self.agents_path = self.memory_root / "agents"
        self.events_path = self.memory_root / "events"
        self.logs_path = self.memory_root / "logs"
        self.auth_path = self.memory_root / "auth"
        self.chroma_path = self.memory_root / "chroma_data"
        self.docstore_path = self.memory_root / "docstore"
        self.profile_path = self.memory_root / "profiles"
        self.code_repos_path = self.memory_root / "code_repos"

    # 业务画像（数据世界）
    profile_llm_enabled: bool = field(
        default_factory=lambda: os.environ.get(
            "CEREBRATE_PROFILE_LLM_ENABLED", "false").lower() in (
                "1", "true", "yes", "on"))

    # 代码同步（本地代码 → 脑虫服务器代码仓）
    code_sync_max_bytes: int = field(
        default_factory=lambda: int(os.environ.get(
            "CEREBRATE_CODE_SYNC_MAX_BYTES", "209715200")))  # 200MB

    # 画像一致性校验周期（小时）
    profile_verify_interval_hours: int = field(
        default_factory=lambda: int(os.environ.get(
            "CEREBRATE_PROFILE_VERIFY_INTERVAL_HOURS", "6")))


config = CerebrateConfig()


def in_evolution_window(now: datetime | None = None) -> bool:
    """
    判断当前时间是否在蒸馏窗口内（本地时区，默认 Asia/Macau UTC+8）。.

    v5.1.1 用户要求：蒸馏仅在每天 0:00-1:00（低谷 API 费用时段）运行，
    其他时间禁止蒸馏。scheduler 自动调度与 evolution.evolve(force=False)
    均以此函数为准；force=True（管理员显式）保留逃生门。

    Args:
        now: 可注入时间（测试用）；缺省取当前 UTC 时间换算本地时区。

    Returns:
        window 关闭（evolution_window_enabled=False）→ True（逃生门）
        本地小时在 [start_hour, end_hour) 内 → True
        否则 → False

    """
    if not config.evolution_window_enabled:
        return True
    local = (now or datetime.now(UTC)) + timedelta(
        hours=config.evolution_window_tz_offset_hours)
    start = config.evolution_window_start_hour % 24
    end = config.evolution_window_end_hour % 24
    if start == end:
        return False
    if start < end:
        return start <= local.hour < end
    # 跨天窗口（如 22:00-02:00）
    return local.hour >= start or local.hour < end
