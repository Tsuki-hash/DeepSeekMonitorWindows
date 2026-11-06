//! 采集来源重叠检测。
//!
//! 评审 P1：来源按「类型 + 规范路径」去重，但**默认主目录**与**单个工具数据库路径**
//! 会被当成两个不同来源（前者是 home 来源，后者是 tool 来源），各自拿到不同的
//! sourceId 后直接合并，物理上同一批日志就可能被统计两次。
//!
//! 刻意**不**按 sessionId 合并不同来源：不同用户的同名会话必须保持隔离，
//! 无法证明是同一数据库时只提示、不合并。
//!
//! 复评 R02：覆盖判定只承认**本轮成功读取的实际入口**。静态的「先算 overlaps、
//! 循环最先跳过」已删除 —— covering home 本轮失败/被拒时，用户单独配置的
//! 单工具来源必须照常采集（它是可用的退路，不能被预先扼杀）。

/// 布局根的种类：目录根按后代包含判重；**精确文件**根只与自身相等判重。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayoutKind {
    Directory,
    File,
}

/// 每款工具在用户主目录下的标准布局（相对路径，正斜杠分隔）。
///
/// 复评 R02：必须是**实际被固定引擎读取的入口**，不能用父目录冒充覆盖 ——
/// ZCode 的默认扫描是 `.zcode/projects` 下的 JSONL 加上精确的
/// `.zcode/cli/db/db.sqlite`；`.zcode` 下其他自定义库不在默认扫描范围内。
/// DSH 的真实默认根是 `.dsh/sessions`，OpenClaw 是 `.openclaw/agents`。
///
/// 复评 F01：固定引擎在 `--home` 模式下**仍然**加入若干内建额外根（`--home`
/// 只禁用环境变量根）。这些根同样会实际读取数据，必须进入同一份扫描计划，
/// 否则 home 与单工具来源会在这些位置上重复统计或漏掉：
/// - Claude：`.claude/transcripts`，以及 `.cc-mirror/*/variant.json` 的
///   `configDir`（动态、可能指向 home 之外，见 `discover_cc_mirror_roots`）；
/// - Hermes：`AppData/Local/hermes`（`state.db` / `profiles`）；
/// - OpenClaw 旧名入口：`.clawdbot/agents`、`.moltbot/agents`、`.moldbot/agents`。
#[derive(Debug, Clone, Copy)]
pub struct LayoutRoot {
    pub relative: &'static str,
    pub kind: LayoutKind,
}

static OPENCODE_LAYOUTS: &[LayoutRoot] = &[LayoutRoot {
    relative: ".local/share/opencode",
    kind: LayoutKind::Directory,
}];
static CLAUDE_LAYOUTS: &[LayoutRoot] = &[
    LayoutRoot {
        relative: ".claude/projects",
        kind: LayoutKind::Directory,
    },
    // 复评 F01：内建 transcripts 根。
    LayoutRoot {
        relative: ".claude/transcripts",
        kind: LayoutKind::Directory,
    },
];
static ZCODE_LAYOUTS: &[LayoutRoot] = &[
    LayoutRoot {
        relative: ".zcode/projects",
        kind: LayoutKind::Directory,
    },
    LayoutRoot {
        relative: ".zcode/cli/db/db.sqlite",
        kind: LayoutKind::File,
    },
];
static HERMES_LAYOUTS: &[LayoutRoot] = &[
    LayoutRoot {
        relative: ".hermes",
        kind: LayoutKind::Directory,
    },
    // 复评 F01：内建 AppData 根（state.db / profiles）。
    LayoutRoot {
        relative: "AppData/Local/hermes",
        kind: LayoutKind::Directory,
    },
];
static OPENCLAW_LAYOUTS: &[LayoutRoot] = &[
    LayoutRoot {
        relative: ".openclaw/agents",
        kind: LayoutKind::Directory,
    },
    // 复评 F01：固定上游同样读取的三个旧名入口。
    LayoutRoot {
        relative: ".clawdbot/agents",
        kind: LayoutKind::Directory,
    },
    LayoutRoot {
        relative: ".moltbot/agents",
        kind: LayoutKind::Directory,
    },
    LayoutRoot {
        relative: ".moldbot/agents",
        kind: LayoutKind::Directory,
    },
];
static DSH_LAYOUTS: &[LayoutRoot] = &[LayoutRoot {
    relative: ".dsh/sessions",
    kind: LayoutKind::Directory,
}];

pub fn standard_layouts(tool: &str) -> &'static [LayoutRoot] {
    match tool {
        "opencode" => OPENCODE_LAYOUTS,
        "claude" => CLAUDE_LAYOUTS,
        "zcode" => ZCODE_LAYOUTS,
        "hermes" => HERMES_LAYOUTS,
        "openclaw" => OPENCLAW_LAYOUTS,
        "dsh" => DSH_LAYOUTS,
        _ => &[],
    }
}

/// 复评 F01：`cc_mirror` 的 variant 配置文件位置（相对 home）。
pub const CC_MIRROR_DIR: &str = ".cc-mirror";

/// 复评 F01：从一个 variant.json 的**已解析文本**里取出 `configDir`。
///
/// 只做文本解析，不访问目标；调用方拿到文本后仍需按来源策略校验目标
///（`reject_link_target` / `probe_path`），不能因为配置里写了就当成合法根。
pub fn cc_mirror_config_dir(variant_json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(variant_json).ok()?;
    let raw = value.get("configDir")?.as_str()?.trim();
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

/// 来源身份归一化（复评 T04）。
///
/// 原实现把**整条路径**转小写，有两个后果：
/// 1. WSL 的 Linux 部分被强制小写 —— `home/Alice` 与 `home/alice` 是两个不同目录
///    （WSL 大小写敏感），却被当成同一来源，被判 duplicate 跳过 → **漏采**；
/// 2. `\\wsl$` 与 `\\wsl.localhost` 没有统一 —— 同一物理来源经两个别名配置
///    会被当成两个来源 → **重复计数**。
///
/// 现在的规则：UNC 前缀还原、正斜杠统一、去尾斜杠；
/// WSL 服务器别名统一为 `wsl.localhost`，发行版名小写（Windows 侧大小写不敏感），
/// **Linux 尾段保留原样**；非 WSL 路径整体小写（Windows 文件系统大小写不敏感）。
fn normalize(path: &str) -> String {
    const WSL_DOLLAR: &str = r"\\wsl$\";
    const WSL_LOCALHOST: &str = r"\\wsl.localhost\";
    let value = path
        .replace(r"\\?\UNC\", r"\\")
        .trim_start_matches(r"\\?\")
        .replace('/', "\\");
    let trimmed = value.trim_end_matches('\\');
    let lower = trimmed.to_lowercase();
    let server_skip = if lower.starts_with(WSL_LOCALHOST) {
        Some(WSL_LOCALHOST.len())
    } else if lower.starts_with(WSL_DOLLAR) {
        Some(WSL_DOLLAR.len())
    } else {
        None
    };
    if let Some(skip) = server_skip {
        // 前缀是纯 ASCII，按字节切分与按字符切分等价。
        let rest = &trimmed[skip..];
        let (distro, tail) = match rest.find('\\') {
            Some(index) => (&rest[..index], &rest[index..]),
            None => (rest, ""),
        };
        return format!("{WSL_LOCALHOST}{}{tail}", distro.to_lowercase());
    }
    lower
}

/// `candidate` 是否落在 `root` 之内（按路径分量比较，不做子串匹配）。
pub fn is_within(root: &str, candidate: &str) -> bool {
    let root = normalize(root);
    let candidate = normalize(candidate);
    if root.is_empty() || candidate.is_empty() {
        return false;
    }
    candidate == root
        || candidate
            .strip_prefix(&root)
            .is_some_and(|rest| rest.starts_with('\\'))
}

/// 复评 Q05：判断两个 `home_key` 归一化键是否存在包含关系。
///
/// `home_key` 对 WSL 输出 `wsl:{distro}:{tail 正斜杠}`，对普通路径输出
/// 小写反斜杠形式，所以包含检查要按各自分隔符做**分量级**前缀匹配，
/// 不能用子串（`D:\Users\AB` 不得命中 `D:\Users\A`）。
pub fn key_within(root_key: &str, candidate_key: &str) -> bool {
    if root_key.is_empty() || candidate_key.is_empty() {
        return false;
    }
    if root_key == candidate_key {
        return true;
    }
    let separator = if root_key.starts_with("wsl:") {
        '/'
    } else {
        '\\'
    };
    candidate_key
        .strip_prefix(root_key)
        .is_some_and(|rest| rest.starts_with(separator))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 路径分量比较_不做子串匹配() {
        assert!(is_within(r"D:\Users\A", r"D:\Users\A\.claude\projects"));
        assert!(is_within(r"D:\Users\A", r"d:/users/a/.claude/projects"));
        assert!(is_within(r"D:\Users\A\", r"D:\Users\A"));
        assert!(
            !is_within(r"D:\Users\A", r"D:\Users\AB\.claude\projects"),
            "同前缀的不同目录不能被当成子目录"
        );
        assert!(!is_within("", r"D:\Users\A"));
    }

    #[test]
    fn wsl别名统一但linux大小写保留() {
        // 复评 T04：`\\wsl$` 与 `\\wsl.localhost` 是同一服务器的两个别名，
        // 必须归一化成同一身份，否则同一来源会被当成两个 → 重复计数。
        assert_eq!(
            normalize(r"\\wsl$\Ubuntu\home\user\.claude\projects"),
            normalize(r"\\wsl.localhost\Ubuntu\home\user\.claude\projects")
        );
        // WSL 文件系统大小写敏感：home/Alice 与 home/alice 是**两个不同目录**，
        // 不得因整路径小写而被当成同一来源 → 否则被判 duplicate 跳过、漏采。
        assert_ne!(
            normalize(r"\\wsl.localhost\Ubuntu\home\Alice\.claude\projects"),
            normalize(r"\\wsl.localhost\Ubuntu\home\alice\.claude\projects")
        );
        // 发行版名大小写不敏感（Windows 侧）。
        assert_eq!(
            normalize(r"\\wsl.localhost\Ubuntu\home\user"),
            normalize(r"\\wsl.localhost\ubuntu\home\user")
        );
        // 非 WSL 路径保持 Windows 大小写不敏感。
        assert_eq!(
            normalize(r"D:\Users\A\.claude\projects"),
            normalize(r"d:\users\a\.claude\projects")
        );
        // 扩展 UNC 前缀还原后同样参与别名统一。
        assert_eq!(
            normalize(r"\\?\UNC\wsl$\Ubuntu\home\user"),
            normalize(r"\\wsl.localhost\Ubuntu\home\user")
        );
    }

    // ---------- 复评 R02：布局根必须是实际被读取的入口 ----------

    #[test]
    fn r02_标准布局目录根覆盖其后代_精确文件根只等于自身() {
        // ZCode 目录根：.zcode/projects 下的内容被 home 覆盖。
        assert!(is_within(
            r"D:\Users\A\.zcode\projects",
            r"D:\Users\A\.zcode\projects\2026-11"
        ));
        // 精确数据库根：只有同一路径才算重复。
        assert!(is_within(
            r"D:\Users\A\.zcode\cli\db\db.sqlite",
            r"D:\Users\A\.zcode\cli\db\db.sqlite"
        ));
        assert!(
            !is_within(
                r"D:\Users\A\.zcode\cli\db\db.sqlite",
                r"D:\Users\A\.zcode\custom.sqlite"
            ),
            "自定义库不在精确根内，不得被抑制"
        );
    }

    #[test]
    fn r02_窄化后的布局根不再把父目录当覆盖范围() {
        // 复评 R02 触发一：`.zcode/custom.sqlite`、`.dsh/custom-logs`、
        // `.openclaw/custom-logs` 都必须照常采集。
        let cases: &[(&str, &str, bool)] = &[
            ("zcode", r"D:\U\.zcode\custom.sqlite", false),
            ("zcode", r"D:\U\.zcode\projects\s.jsonl", true),
            ("zcode", r"D:\U\.zcode\cli\db\db.sqlite", true),
            ("dsh", r"D:\U\.dsh\custom-logs", false),
            ("dsh", r"D:\U\.dsh\sessions\x", true),
            ("openclaw", r"D:\U\.openclaw\custom-logs", false),
            ("openclaw", r"D:\U\.openclaw\agents\y", true),
        ];
        for (tool, candidate, expected) in cases {
            let hit = standard_layouts(tool).iter().any(|root| {
                let layout_root = format!("{}\\{}", normalize(r"D:\U"), normalize(root.relative));
                is_within(&layout_root, candidate)
            });
            assert_eq!(hit, *expected, "tool={tool} candidate={candidate}");
        }
    }

    #[test]
    fn r02_未知工具没有布局根() {
        assert!(standard_layouts("unknown").is_empty());
    }

    // ---------- 第七轮复评 F01：扫描计划必须覆盖引擎的内建额外根 ----------

    #[test]
    fn f01_内建额外根进入标准布局() {
        // 复评 F01：`--home` 只禁用环境变量根，引擎仍会读这些内建根；
        // 若它们不在计划里，home 与单工具来源会在同一位置重复统计。
        let claude = standard_layouts("claude");
        assert!(
            claude
                .iter()
                .any(|root| root.relative == ".claude/transcripts"),
            "Claude 内建 transcripts 根必须在扫描计划里"
        );
        let hermes = standard_layouts("hermes");
        assert!(
            hermes
                .iter()
                .any(|root| root.relative == "AppData/Local/hermes"),
            "Hermes 内建 AppData 根必须在扫描计划里"
        );
        let openclaw = standard_layouts("openclaw");
        for legacy in [".clawdbot/agents", ".moltbot/agents", ".moldbot/agents"] {
            assert!(
                openclaw.iter().any(|root| root.relative == legacy),
                "OpenClaw 旧名入口 {legacy} 必须在扫描计划里"
            );
        }
    }

    #[test]
    fn f01_cc_mirror配置只解析文本_不访问目标() {
        assert_eq!(
            cc_mirror_config_dir(r#"{"configDir":"D:\\Mirror\\Proj"}"#),
            Some(r"D:\Mirror\Proj".to_string())
        );
        // 空/缺失/非法都不产生根。
        assert_eq!(cc_mirror_config_dir(r#"{"configDir":"   "}"#), None);
        assert_eq!(cc_mirror_config_dir(r#"{}"#), None);
        assert_eq!(cc_mirror_config_dir("not json"), None);
        assert_eq!(cc_mirror_config_dir(r#"{"configDir":123}"#), None);
    }

    #[test]
    fn f01_内建根同样参与后代覆盖判定() {
        // home 的 transcripts 根被覆盖时，指向它的工具来源应判重。
        let layout_root = format!(
            "{}\\{}",
            normalize(r"D:\U"),
            normalize(".claude/transcripts")
        );
        assert!(is_within(&layout_root, r"D:\U\.claude\transcripts\s.jsonl"));
        // 而 home 下的自定义目录不在任何内建根内，必须照常采集。
        assert!(!is_within(&layout_root, r"D:\U\custom\s2.jsonl"));
    }
}

#[test]
fn 归一化键的分量级包含检查() {
    use crate::local_sources::home_key;
    // 复评 Q05：junction 把工具标准目录映射到别处后，只有 canonical 布局根
    // 才能证明同源；键比较必须分量级，不能用子串。
    assert!(key_within(
        &home_key(r"D:\Users\A"),
        &home_key(r"D:\Users\A\.claude\projects")
    ));
    assert!(key_within(
        &home_key(r"D:\Users\A"),
        &home_key(r"D:\Users\A")
    ));
    // 同前缀不同目录不得命中。
    assert!(!key_within(
        &home_key(r"D:\Users\A"),
        &home_key(r"D:\Users\AB\.claude\projects")
    ));
    // WSL 键用正斜杠 tail，同样分量级。
    assert!(key_within(
        &home_key(r"\wsl.localhost\Ubuntu\home\user"),
        &home_key(r"\wsl.localhost\Ubuntu\home\user\.claude\projects")
    ));
    assert!(!key_within(
        &home_key(r"\wsl.localhost\Ubuntu\home\user"),
        &home_key(r"\wsl.localhost\Ubuntu\home\userx\.claude\projects")
    ));
    // 交叉分隔符不得命中。
    assert!(!key_within(
        &home_key(r"D:\Users\A"),
        &home_key(r"\wsl.localhost\Ubuntu\home\user")
    ));
}
