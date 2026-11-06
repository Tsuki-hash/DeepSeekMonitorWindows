//! 采集来源重叠检测。
//!
//! 评审 P1：来源按「类型 + 规范路径」去重，但**默认主目录**与**单个工具数据库路径**
//! 会被当成两个不同来源（前者是 home 来源，后者是 tool 来源），各自拿到不同的
//! sourceId 后直接合并，物理上同一批日志就可能被统计两次。
//!
//! 刻意**不**按 sessionId 合并不同来源：不同用户的同名会话必须保持隔离，
//! 无法证明是同一数据库时只提示、不合并。
//!
//! 第十二轮：固定引擎不返回逐根执行回执，预审声明即使在 exit 0 后仍不能
//! 证明对应根成功读取。跨来源交集只产生质量提示，不抑制显式退路；完全相同
//! 的采集入口别名由调用方独立去重。部分重叠尚未精确去重。

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

// Lookup-only inputs that the pinned engine reads for OpenClaw.
static CODEX_LOOKUP_LAYOUTS: &[LayoutRoot] = &[
    LayoutRoot {
        relative: ".codex/sessions",
        kind: LayoutKind::Directory,
    },
    LayoutRoot {
        relative: ".codex/archived_sessions",
        kind: LayoutKind::Directory,
    },
    LayoutRoot {
        relative: ".config/tokscale/headless/codex",
        kind: LayoutKind::Directory,
    },
    LayoutRoot {
        relative: "Library/Application Support/tokscale/headless/codex",
        kind: LayoutKind::Directory,
    },
];

pub fn standard_layouts(tool: &str) -> &'static [LayoutRoot] {
    match tool {
        "opencode" => OPENCODE_LAYOUTS,
        "claude" => CLAUDE_LAYOUTS,
        "zcode" => ZCODE_LAYOUTS,
        "hermes" => HERMES_LAYOUTS,
        "openclaw" => OPENCLAW_LAYOUTS,
        "dsh" => DSH_LAYOUTS,
        "codex" => CODEX_LOOKUP_LAYOUTS,
        _ => &[],
    }
}

/// 复评 F01：`cc_mirror` 的 variant 配置文件位置（相对 home）。
pub const CC_MIRROR_DIR: &str = ".cc-mirror";

/// 复评 F01：从一个 variant.json 的**已解析文本**里取出 `configDir`。
///
/// 只做文本解析，不访问目标；调用方拿到文本后仍需按来源策略校验目标
///（`reject_link_target` / `probe_path`），不能因为配置里写了就当成合法根。
pub fn cc_mirror_config_dir(variant_json: &str) -> Result<Option<String>, String> {
    // Match the pinned engine's typed VariantFile. A wrong type in any known
    // field invalidates the variant; it must never become a default config root.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct VariantFile {
        name: Option<String>,
        provider: Option<String>,
        provider_id: Option<String>,
        config_dir: Option<String>,
    }
    let variant: VariantFile = serde_json::from_str(variant_json)
        .map_err(|_| "cc-mirror variant.json 格式不兼容".to_string())?;
    let _ = (variant.name, variant.provider, variant.provider_id);
    Ok(variant.config_dir.and_then(|raw| {
        let value = raw.trim();
        (!value.is_empty()).then(|| value.to_string())
    }))
}

/// Preserve the pinned engine's Path::join semantics exactly. In particular,
/// `~//...` must not be sanitized into a child of home while the engine reads a
/// drive-rooted/UNC target. The caller rejects unsafe declarations before IO.
pub fn cc_mirror_resolve_root(
    variant_json: &str,
    variant_dir: &std::path::Path,
    home: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let declared = cc_mirror_config_dir(variant_json)?;
    let resolved = match declared.as_deref() {
        None => variant_dir.join("config"),
        Some(raw) if raw.starts_with("~/") => home.join(&raw[2..]),
        Some(raw) => {
            let path = std::path::PathBuf::from(raw);
            if path.is_absolute() {
                path
            } else {
                variant_dir.join(path)
            }
        }
    };
    if !resolved.is_absolute() {
        return Err("cc-mirror configDir 无法解析为绝对路径".into());
    }
    Ok(resolved)
}

/// A validated physical declaration, not a per-root read receipt. Client scopes
/// remain distinct where mirror metadata can change the interpretation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanRoot {
    pub parser: String,
    pub client: String,
    pub identity: String,
    pub kind: LayoutKind,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PlanOverlap {
    pub covered_by: Option<String>,
    pub partial: bool,
}

/// A completed executable invocation does not acknowledge which individual
/// roots were adopted or read. These are preflight declarations, not read
/// receipts: even exact equality must preserve the explicit fallback source.
/// Only the separate identical-invocation key can suppress an alias today.
/// Root-level deduplication requires an engine protocol reporting each root.
pub fn compare_plans(candidate: &[ScanRoot], completed: &[(ScanRoot, String)]) -> PlanOverlap {
    let partial = candidate.iter().any(|entry| {
        completed.iter().any(|(root, _)| {
            // OpenClaw's Codex lookup and rollout lane can read the same file.
            // Cross-parser identity never proves coverage, but this known pair
            // must retain a possible-overlap warning across separate engine runs.
            let lookup_pair = matches!(
                (entry.parser.as_str(), root.parser.as_str()),
                ("codex", "openclaw") | ("openclaw", "codex")
            );
            if entry.parser != root.parser && !lookup_pair {
                return false;
            }
            match (root.kind, entry.kind) {
                (LayoutKind::File, LayoutKind::File) => root.identity == entry.identity,
                (LayoutKind::Directory, LayoutKind::File) => {
                    key_within(&root.identity, &entry.identity)
                }
                (LayoutKind::File, LayoutKind::Directory) => {
                    key_within(&entry.identity, &root.identity)
                }
                (LayoutKind::Directory, LayoutKind::Directory) => {
                    key_within(&root.identity, &entry.identity)
                        || key_within(&entry.identity, &root.identity)
                }
            }
        })
    });
    PlanOverlap {
        covered_by: None,
        partial,
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
            cc_mirror_config_dir(r#"{"configDir":"D:\\Mirror\\Proj"}"#).unwrap(),
            Some(r"D:\Mirror\Proj".to_string())
        );
        // 空/缺失/非法都不产生根。
        assert_eq!(
            cc_mirror_config_dir(r#"{"configDir":"   "}"#).unwrap(),
            None
        );
        assert_eq!(cc_mirror_config_dir(r#"{}"#).unwrap(), None);
        assert!(cc_mirror_config_dir("not json").is_err());
        assert!(cc_mirror_config_dir(r#"{"configDir":123}"#).is_err());
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

#[cfg(test)]
mod round11_tests {
    use super::*;
    fn scan(parser: &str, identity: &str, kind: LayoutKind) -> ScanRoot {
        ScanRoot {
            parser: parser.into(),
            client: parser.into(),
            identity: identity.into(),
            kind,
        }
    }

    #[test]
    fn r01_完整实际计划保留两home独有根并标记共享根风险() {
        let shared = scan("claude", r"d:\shared", LayoutKind::Directory);
        let first = vec![
            scan("claude", r"d:\h1\.claude\projects", LayoutKind::Directory),
            shared.clone(),
        ];
        let second = vec![
            scan("claude", r"d:\h2\.claude\projects", LayoutKind::Directory),
            shared,
        ];
        for (prior, candidate) in [(&first, &second), (&second, &first)] {
            let success: Vec<_> = prior
                .iter()
                .cloned()
                .map(|root| (root, "成功来源".into()))
                .collect();
            let result = compare_plans(candidate, &success);
            assert_eq!(result.covered_by, None, "20/30 独有根不能随共享 100 被丢弃");
            assert!(result.partial, "固定引擎不能切根时必须明确总量不可信");
        }
        assert_eq!(
            compare_plans(&second, &[]),
            PlanOverlap::default(),
            "失败来源不得登记覆盖"
        );
    }

    #[test]
    fn r01_一个claude宽根不能覆盖另一个home的独有数据库() {
        let prior = vec![(
            scan("claude", r"d:\shared", LayoutKind::Directory),
            "H1".into(),
        )];
        let candidate = vec![
            scan(
                "claude",
                r"d:\shared\home2\.claude\projects",
                LayoutKind::Directory,
            ),
            scan("opencode", r"d:\shared\home2\opencode.db", LayoutKind::File),
            scan("zcode", r"d:\shared\home2\db.sqlite", LayoutKind::File),
        ];
        let outcome = compare_plans(&candidate, &prior);
        assert!(outcome.covered_by.is_none());
        assert!(outcome.partial);
    }

    #[test]
    fn r12_预审根相同也不能当成逐根读取回执() {
        let root = scan("opencode", r"d:\logs\opencode.db", LayoutKind::File);
        let successful = vec![(root.clone(), "H1".into())];
        let result = compare_plans(std::slice::from_ref(&root), &successful);
        assert!(result.covered_by.is_none(), "exit 0 不得抑制显式退路");
        assert!(result.partial, "无法切根时仍需保留重复合计风险");
        assert_eq!(
            compare_plans(
                &[scan("zcode", &root.identity, LayoutKind::File)],
                &successful
            ),
            PlanOverlap::default()
        );
        let descendant = scan("opencode", r"d:\logs\opencode.db\child", LayoutKind::File);
        assert_eq!(
            compare_plans(&[descendant], &successful),
            PlanOverlap::default()
        );
        let directory = scan("opencode", r"d:\logs", LayoutKind::Directory);
        let partial = compare_plans(&[directory], &successful);
        assert!(partial.covered_by.is_none() && partial.partial);
        let mut mirror = root;
        mirror.client = "mirror-a".into();
        assert!(compare_plans(&[mirror], &successful).covered_by.is_none());
        assert_eq!(compare_plans(&[], &successful), PlanOverlap::default());
    }

    #[test]
    fn r03_typed镜像错误不能悄悄变成默认根() {
        for invalid in [
            r#"{"name":1}"#,
            r#"{"provider":{}}"#,
            r#"{"providerId":false}"#,
            r#"{"configDir":[]}"#,
            "[]",
            "null",
            "{",
        ] {
            assert!(cc_mirror_config_dir(invalid).is_err(), "{invalid}");
        }
        for valid in ["{}", r#"{"configDir":null}"#, r#"{"configDir":"  "}"#] {
            assert_eq!(cc_mirror_config_dir(valid).unwrap(), None);
        }
    }

    #[test]
    fn r03_镜像展开逐字采用上游join不清洗前导分隔符() {
        let home = std::env::temp_dir().join("dsm-mirror-home");
        let variant = home.join(".cc-mirror/v1");
        for rest in [
            "x",
            "/Windows/System32",
            "//server/share",
            r"\Windows",
            r"\\server\share",
            r"x\..\y",
        ] {
            let json = serde_json::json!({"configDir": format!("~/{rest}")}).to_string();
            assert_eq!(
                cc_mirror_resolve_root(&json, &variant, &home).unwrap(),
                home.join(rest)
            );
        }
        for raw in ["~", r"~\x", "relative/path"] {
            let json = serde_json::json!({"configDir": raw}).to_string();
            assert_eq!(
                cc_mirror_resolve_root(&json, &variant, &home).unwrap(),
                variant.join(raw)
            );
        }
        assert_eq!(
            cc_mirror_resolve_root("{}", &variant, &home).unwrap(),
            variant.join("config")
        );
    }

    #[cfg(windows)]
    #[test]
    fn r03_危险mirror声明必须在目标访问前拒绝() {
        let home = std::path::Path::new(r"C:\Users\Alice");
        for raw in [
            "~//Windows/System32",
            "~///server/share",
            r"~/\\server\share",
        ] {
            let json = serde_json::json!({"configDir": raw}).to_string();
            let target = cc_mirror_resolve_root(&json, &home.join(".cc-mirror/v1"), home).unwrap();
            assert!(crate::local_sources::check_link_chain(
                &target,
                crate::local_sources::SourceOrigin::Native
            )
            .is_err());
        }
    }

    #[test]
    fn r01_openclaw与codex查找lane交集只提示不互相覆盖() {
        let root = scan(
            "codex",
            r"d:\agents\a\agent\codex-home\sessions",
            LayoutKind::Directory,
        );
        let candidate = scan("openclaw", r"d:\agents", LayoutKind::Directory);
        let result = compare_plans(&[candidate], &[(root, "lookup".into())]);
        assert!(result.covered_by.is_none() && result.partial);
        assert_eq!(standard_layouts("codex").len(), 4);
    }
}
