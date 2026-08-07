"""
Skill 结构化资产 — SKILL.md frontmatter 解析与校验（借鉴 TencentDB Agent Memory）。.

腾讯的 Skill 资产不是一段 Prompt：它有版本、资源文件、触发边界、
执行步骤和验证规则，统一用 SKILL.md（frontmatter + body）表达。
本模块为 Cerebrate 的 verified_skill 提供同款结构化能力：
  - 解析 `---` 围栏的 YAML frontmatter（name/description/version/...）
  - 校验必填字段与长度（对齐腾讯 skill-format 的契约）
  - 解析失败返回 None → 调用方按普通记忆处理（零破坏，兼容旧行为）
"""

import re

NAME_MAX = 64
DESCRIPTION_MAX = 1024
BODY_MAX = 50_000
NAME_REGEX = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def parse_skill_markdown(raw: str) -> dict | None:
    r"""
    从 SKILL.md 文本解析结构化 Skill 字段。.

    输入须以 `---\\n` 开头并有闭合围栏；否则返回 None（普通记忆）。
    解析出的字段：
      name / description / version / category / trigger / validation /
      resources / body（frontmatter 后的正文）
    """
    if not raw or not raw.startswith("---\n"):
        return None

    # 找闭合围栏：`\n---` 后跟换行或 EOF
    close = -1
    end_of_close = -1
    i = 4
    while i < len(raw) - 3:
        if raw[i] == "\n" and raw[i + 1:i + 4] == "---":
            after = raw[i + 4:i + 5]
            if after in ("", "\n"):
                close = i + 1
                end_of_close = i + 4 + (1 if after == "\n" else 0)
                break
        i += 1
    if close == -1:
        return None

    yaml_text = raw[4:close]
    fields: dict[str, str] = {}
    for line in yaml_text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if key and value:
            # 简单 YAML 子集：去掉引号
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            fields[key] = value

    name = fields.get("name", "")
    description = fields.get("description", "")
    if not name or not description:
        return None

    body = raw[end_of_close:]
    if body.startswith("\n"):
        body = body[1:]
    body = body.strip()

    return {
        "name": name,
        "description": description,
        "version": fields.get("version", "1.0"),
        "category": fields.get("category", ""),
        "trigger": fields.get("trigger", ""),
        "validation": fields.get("validation", ""),
        "resources": fields.get("resources", ""),
        "body": body[:BODY_MAX],
    }


def validate_skill_fields(skill: dict) -> tuple[bool, list[str]]:
    """校验 Skill 结构化字段（对齐腾讯 skill-format 契约）。."""
    issues: list[str] = []
    name = skill.get("name", "")
    description = skill.get("description", "")
    if not name or not NAME_REGEX.match(name):
        issues.append(f"name must match {NAME_REGEX.pattern} (got {name!r})")
    if not description:
        issues.append("description is required")
    if len(name) > NAME_MAX:
        issues.append(f"name exceeds {NAME_MAX} chars")
    if len(description) > DESCRIPTION_MAX:
        issues.append(f"description exceeds {DESCRIPTION_MAX} chars")
    return (len(issues) == 0, issues)
