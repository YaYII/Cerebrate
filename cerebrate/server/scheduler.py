"""脑虫后台调度器 v5 — 自动进化 + 原始记忆清理 + 自动经验提取

三个独立后台线程：
  - evolve_loop:  每 30 分钟检查进化窗口 (21:00-09:00)，自动触发进化
  - cleanup_loop: 每天检查一次，清理超过保留期的 OriginLog 原始记忆（先备份再删除）
  - extract_loop: 每 10 分钟扫描未处理的 usage 记录，自动提取经验教训（冷路径兜底）

服务启动时通过 start_scheduler() 初始化。
"""

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger("cerebrate.scheduler")


class CerebrateScheduler:
    """脑虫后台任务调度器。

    在 BrainAPI 初始化后调用 start() 启动三个守护线程。
    """

    def __init__(self, api, check_interval_minutes: int = 30,
                 extract_interval_minutes: int = 10):
        self._api = api  # BrainAPI 实例
        self._check_interval = check_interval_minutes * 60  # 秒
        self._extract_interval = extract_interval_minutes * 60  # 秒
        self._evolve_thread: Optional[threading.Thread] = None
        self._cleanup_thread: Optional[threading.Thread] = None
        self._extract_thread: Optional[threading.Thread] = None
        self._running = False
        self._stop_event = threading.Event()

    def start(self):
        """启动后台调度器（守护线程）。"""
        if self._running:
            return
        self._running = True
        self._stop_event.clear()

        self._evolve_thread = threading.Thread(
            target=self._evolve_loop, daemon=True, name="cerebrate-evolve")
        self._cleanup_thread = threading.Thread(
            target=self._cleanup_loop, daemon=True, name="cerebrate-cleanup")

        self._evolve_thread.start()
        self._cleanup_thread.start()

        self._extract_thread = threading.Thread(
            target=self._extract_loop, daemon=True, name="cerebrate-extract")
        self._extract_thread.start()

        logger.info("脑虫调度器已启动 (进化检查间隔=%dmin, 经验提取间隔=%dmin, 清理间隔=24h)",
                     self._check_interval // 60, self._extract_interval // 60)

    def stop(self):
        """停止后台调度器。"""
        self._stop_event.set()
        self._running = False
        logger.info("脑虫调度器已停止")

    # ── 进化调度 ─────────────────────────────────────────

    def _in_evolution_window(self) -> bool:
        """当前时间是否在进化窗口内 (21:00-09:00)。"""
        hour = datetime.now(timezone.utc).hour
        return hour >= 21 or hour < 9

    def _evolve_loop(self):
        """进化调度主循环：每 N 分钟检查一次。"""
        while not self._stop_event.is_set():
            try:
                if self._in_evolution_window():
                    result = self._api.evolve(force=False)
                    skipped = result.get("skipped", False)
                    if not skipped:
                        actions = result.get("actions", [])
                        if actions:
                            logger.info("自动进化完成: %s", "; ".join(actions))
                        else:
                            logger.debug("自动进化: 无变更")
                    else:
                        logger.debug("自动进化跳过: %s", result.get("reason", ""))
                else:
                    logger.debug("进化窗口未开放，跳过检查")
            except Exception as e:
                logger.error("自动进化异常: %s", e)

            # 每 check_interval 秒检查一次
            self._stop_event.wait(self._check_interval)

    # ── 清理调度 ─────────────────────────────────────────

    def _cleanup_loop(self):
        """原始记忆清理主循环：每天检查一次。"""
        # 首次启动延迟 60 秒，避免与服务初始化冲突
        self._stop_event.wait(60)

        while not self._stop_event.is_set():
            try:
                result = self._api.cleanup_expired_origins(days=365)
                deleted = result.get("deleted", 0)
                if deleted > 0:
                    logger.info("原始记忆清理完成: 过期=%d 备份=%d 删除=%d 文件=%s",
                                result.get("total_expired", 0),
                                result.get("backed_up", 0),
                                deleted,
                                result.get("backup_file", ""))
                else:
                    logger.debug("原始记忆清理: 无过期记录")
            except Exception as e:
                logger.error("原始记忆清理异常: %s", e)

            # 每 24 小时检查一次
            self._stop_event.wait(24 * 3600)

    # ── 自动经验提取调度 ─────────────────────────────

    def _extract_loop(self):
        """自动经验提取冷路径：每 N 分钟扫描未处理的 usage，兜底提取经验。"""
        # 首次启动延迟 30 秒，等服务完全就绪
        self._stop_event.wait(30)

        while not self._stop_event.is_set():
            try:
                result = self._api.process_pending_usages(limit=20)
                if result.get("processed", 0) > 0:
                    logger.info("自动经验提取冷路径: 处理了 %d 条 usage",
                                result["processed"])
                elif result.get("errors", 0) > 0:
                    logger.debug("自动经验提取冷路径: %d 条错误",
                                 result["errors"])
            except Exception as e:
                logger.error("自动经验提取冷路径异常: %s", e)

            # 每 extract_interval 秒检查一次
            self._stop_event.wait(self._extract_interval)


# ── 模块级便捷函数 ──────────────────────────────────────

_scheduler: Optional[CerebrateScheduler] = None


def start_scheduler(api) -> CerebrateScheduler:
    """启动全局调度器（幂等）。"""
    global _scheduler
    if _scheduler is not None and _scheduler._running:
        return _scheduler
    _scheduler = CerebrateScheduler(api)
    _scheduler.start()
    return _scheduler


def stop_scheduler():
    """停止全局调度器。"""
    global _scheduler
    if _scheduler is not None:
        _scheduler.stop()
        _scheduler = None
