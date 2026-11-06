//! 采集来源重叠检测。
//!
//! 评审 P1：来源按「类型 + 规范路径」去重，但**默认主目录**与**单个工具数据库路径**
//! 会被当成两个不同来源（前者是 home 来源，后者是 tool 来源），各自拿到不同的
//! sourceId 后直接合并，物理上同一批日志就可能被统计两次。
//!
//! 这里只做纯判断：给定主目录来源与单工具路径来源，找出「单工具路径落在某个主目录
//! 的标准布局内」的组合。采集器据此跳过该来源并给出可解释的状态，而不是静默翻倍。
//!
//! 刻意**不**按 sessionId 合并不同来源：不同用户的同名会话必须保持隔离，
//! 无法证明是同一数据库时只提示、不合并。

/// 每款工具在用户主目录下的标准布局（相对路径，正斜杠分隔）。
pub fn standard_layout(tool: &str) -> Option<&'static str> {
    match tool {
        "opencode" => Some(".local/share/opencode"),
        "claude" => Some(".claude/projects"),
        "zcode" => Some(".zcode"),
        "hermes" => Some(".hermes"),
        "openclaw" => Some(".openclaw"),
        "dsh" => Some(".dsh"),
        _ => None,
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

/// 主目录来源的描述：用于判断单工具路径是否已被它覆盖。
#[derive(Debug, Clone)]
pub struct HomeRoot {
    pub id: String,
    pub path: String,
}

/// 单工具路径来源。
#[derive(Debug, Clone)]
pub struct ToolRoot {
    pub id: String,
    pub tool: String,
    pub path: String,
}

/// 找出「单工具路径已被某个主目录来源的标准布局覆盖」的组合。
///
/// 返回 `(tool_id, home_id)`：调用方把 tool 来源标为 `duplicate` 并说明原因。
///
/// **只按标准布局判重**（复评 F03）：主目录来源的引擎只扫描 `standard_layout`
/// 那一个位置，home 下的其他自定义目录并不在它的覆盖范围内。若把「在 home 下」
/// 一律当成重复，用户配置的自定义日志目录会被静默跳过、导致漏采。
pub fn overlapping_tools(homes: &[HomeRoot], tools: &[ToolRoot]) -> Vec<(String, String)> {
    let mut found = Vec::new();
    for tool in tools {
        let Some(layout) = standard_layout(&tool.tool) else {
            continue;
        };
        for home in homes {
            // 唯一判据：单工具路径落在该主目录的**标准布局**内。
            let layout_root = format!("{}\\{}", normalize(&home.path), normalize(layout));
            if is_within(&layout_root, &tool.path) {
                found.push((tool.id.clone(), home.id.clone()));
                break;
            }
        }
    }
    found
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
    fn 默认主目录与同一单库被识别为重叠() {
        let homes = vec![HomeRoot {
            id: "home-1".into(),
            path: r"D:\Users\A".into(),
        }];
        let tools = vec![ToolRoot {
            id: "tool-1".into(),
            tool: "opencode".into(),
            path: r"D:\Users\A\.local\share\opencode\opencode.db".into(),
        }];
        let overlap = overlapping_tools(&homes, &tools);
        assert_eq!(overlap.len(), 1);
        assert_eq!(overlap[0], ("tool-1".into(), "home-1".into()));
    }

    #[test]
    fn 不同主目录或不同用户的同名会话不合并() {
        let homes = vec![HomeRoot {
            id: "home-a".into(),
            path: r"D:\Users\A".into(),
        }];
        let tools = vec![ToolRoot {
            id: "tool-b".into(),
            tool: "claude".into(),
            path: r"D:\Users\B\.claude\projects".into(),
        }];
        assert!(overlapping_tools(&homes, &tools).is_empty());
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

    #[test]
    fn wsl大小写不同的两个目录不互相覆盖() {
        // 复评 T04 回归（误去重 → 漏采）：两个真实不同的 WSL 目录
        // 不能因为整路径小写而被判 duplicate。
        let homes = vec![HomeRoot {
            id: "home-1".into(),
            path: r"\\wsl.localhost\Ubuntu\home\Alice".into(),
        }];
        let tools = vec![ToolRoot {
            id: "tool-alice".into(),
            tool: "claude".into(),
            path: r"\\wsl.localhost\Ubuntu\home\Alice\.claude\projects".into(),
        }];
        // Alice 的标准布局应被 home 覆盖（正常判重）。
        assert_eq!(overlapping_tools(&homes, &tools).len(), 1);
        let other = vec![ToolRoot {
            id: "tool-lower".into(),
            tool: "claude".into(),
            path: r"\\wsl.localhost\Ubuntu\home\alice\.claude\projects".into(),
        }];
        // alice（小写）是另一个目录：不得被 Alice 的 home 覆盖。
        assert!(
            overlapping_tools(&homes, &other).is_empty(),
            "不同大小写的 WSL 目录必须照常采集"
        );
    }

    #[test]
    fn home_下的非标准自定义目录不能被当成重复_否则漏采() {
        // 复评 F03 回归：主目录引擎只扫 .claude/projects，不扫 custom/claude-logs。
        let homes = vec![HomeRoot {
            id: "home-1".into(),
            path: r"D:\Users\A".into(),
        }];
        let custom = vec![ToolRoot {
            id: "tool-custom".into(),
            tool: "claude".into(),
            path: r"D:\Users\A\custom\claude-logs".into(),
        }];
        assert!(
            overlapping_tools(&homes, &custom).is_empty(),
            "非标准位置的自定义目录必须照常采集，不能被跳过"
        );
        // 而标准布局下的同一目录仍应判为重复。
        let standard = vec![ToolRoot {
            id: "tool-standard".into(),
            tool: "claude".into(),
            path: r"D:\Users\A\.claude\projects".into(),
        }];
        assert_eq!(overlapping_tools(&homes, &standard).len(), 1);
    }

    #[test]
    fn 目录别名与复制日志只提示不静默合并() {
        // 复制到别处的日志不在任何主目录布局内：不能判定为重复。
        let homes = vec![HomeRoot {
            id: "home-1".into(),
            path: r"D:\Users\A".into(),
        }];
        let tools = vec![ToolRoot {
            id: "tool-copy".into(),
            tool: "claude".into(),
            path: r"D:\Backups\A-claude-projects".into(),
        }];
        assert!(overlapping_tools(&homes, &tools).is_empty());
    }

    #[test]
    fn 未适配的工具路径不参与判定() {
        let homes = vec![HomeRoot {
            id: "home-1".into(),
            path: r"D:\Users\A".into(),
        }];
        let tools = vec![ToolRoot {
            id: "tool-x".into(),
            tool: "unknown".into(),
            path: r"D:\Users\A\unknown\db".into(),
        }];
        assert!(overlapping_tools(&homes, &tools).is_empty());
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
