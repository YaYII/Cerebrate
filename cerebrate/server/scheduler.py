"""脑虫后台调度器 v5 — 自动进化 + 原始记忆清理 + 自动经验提取

四个独立后台线程：
  - evolve_loop:  每 30 分钟检查蒸馏窗口（默认本地 0:00-1:00，低谷期），自动触发进化
  - cleanup_loop: 每天检查一次，清理超过保留期的 OriginLog 原始记忆（先备份再删除）
  - extract_loop: 每 10 分钟扫描未处理的 usage 记录，自动提取经验教训（冷路径兜底）
  - verify_loop:  每 N 小时校验业务画像 vs 代码仓一致性，漂移告警（实事求是）

服务启动时通过 start_scheduler() 初始化。
"""

import logging
import threading
import time
from typing import Optional

logger = logging.getLogger("cerebrate.scheduler")


class CerebrateScheduler:
    """脑虫后台任务调度器。

    在 BrainAPI 初始化后调用 start() 启动三个守护线程。
    """

    def __init__(self, api, check_interval_minutes: int = 30,
                 extract_interval_minutes: int = 10,
                 verify_interval_hours: int = 0):
        self._api = api  # BrainAPI 实例
        self._check_interval = check_interval_minutes * 60  # 秒
        self._extract_interval = extract_interval_minutes * 60  # 秒
        if verify_interval_hours <= 0:
            from cerebrate.config import config
            verify_interval_hours = config.profile_verify_interval_hours
        self._verify_interval = verify_interval_hours * 3600  # 秒
        self._evolve_thread: Optional[threading.Thread] = None
        self._cleanup_thread: Optional[threading.Thread] = None
        self._extract_thread: Optional[threading.Thread] = None
        self._verify_thread: Optional[threading.Thread] = None
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

        self._verify_thread = threading.Thread(
            target=self._verify_loop, daemon=True, name="cerebrate-verify")
        self._verify_thread.start()

        logger.info("脑虫调度器已启动 (进化=%dmin, 经验提取=%dmin, 清理=24h, 画像校验=%dh)",
                     self._check_interval // 60, self._extract_interval // 60,
                     self._verify_interval // 3600)
        try:
            from cerebrate.brain.logger import get_logger
            get_logger().info("system", "scheduler_start",
                              "脑虫调度器已启动",
                              details={"evolve_interval_min": self._check_interval // 60,
                                       "extract_interval_min": self._extract_interval // 60})
        except Exception:
            pass

    def stop(self):
        """停止后台调度器。"""
        self._stop_event.set()
        self._running = False
        logger.info("脑虫调度器已停止")

    # ── 进化调度 ─────────────────────────────────────────

    def _in_evolution_window(self) -> bool:
        """当前时间是否在蒸馏窗口内（统一判断，本地时区 0:00-1:00 默认）。"""
        from cerebrate.config import in_evolution_window
        return in_evolution_window()

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
        """原始记忆清理主循环：每天检查一次（保留策略可配置，默认永久保留不清理）。"""
        # 首次启动延迟 60 秒，避免与服务初始化冲突
        self._stop_event.wait(60)

        while not self._stop_event.is_set():
            try:
                from cerebrate.config import config
                result = self._api.cleanup_expired_origins(
                    days=config.origin_retention_days)
                deleted = result.get("deleted", 0)
                if result.get("skipped"):
                    logger.debug("原始记忆清理: %s",
                                 result.get("message", "已跳过（永久保留策略）"))
                elif deleted > 0:
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

    # ── 画像一致性校验调度 ─────────────────────────────

    def _verify_loop(self):
        """画像 vs 代码仓一致性校验：每 N 小时跑一次，漂移记日志+事件告警。"""
        # 首次启动延迟 120 秒，等服务与代码仓就绪
        self._stop_event.wait(120)
        while not self._stop_event.is_set():
            try:
                self._run_verify_all()
            except Exception as e:
                logger.error("画像一致性校验异常: %s", e)
            self._stop_event.wait(self._verify_interval)

    def _run_verify_all(self) -> dict:
        """校验所有有画像的项目，返回汇总（漂移项目进 events + 日志告警）。"""
        from cerebrate.tools.project_profile import ProfileStore
        store = ProfileStore(self._api.mm)
        projects = store.list_projects()
        summary = {"checked": 0, "ok": 0, "drift": 0, "details": []}
        for pid in projects:
            try:
                v = store.verify(pid)
            except Exception as e:
                logger.error("校验 %s 异常: %s", pid, e)
                continue
            summary["checked"] += 1
            if v.get("ok"):
                summary["ok"] += 1
            else:
                summary["drift"] += 1
                reason = v.get("reason", "drift")
                issues = v.get("issues", [])
                summary["details"].append({
                    "project_id": pid, "reason": reason,
                    "issue_count": v.get("issue_count", len(issues)),
                    "sample": issues[:3],
                })
                logger.warning("画像漂移 [%s]: %s %s",
                               pid, reason, issues[:2])
                try:
                    self._api.events.append(
                        "profile_drift", source_agent="brain-server",
                        payload={"project_id": pid, "reason": reason,
                                 "issue_count": v.get("issue_count", 0)})
                except Exception:
                    pass
        if summary["checked"]:
            logger.info("画像一致性校验完成: checked=%d ok=%d drift=%d",
                        summary["checked"], summary["ok"], summary["drift"])
        return summary


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
