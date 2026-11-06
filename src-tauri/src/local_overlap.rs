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

/// 统一成小写、反斜杠、去尾斜杠，便于比较前缀。
fn normalize(path: &str) -> String {
    let value = path
        .replace("\\\\?\\UNC\\", "\\\\")
        .trim_start_matches("\\\\?\\")
        .replace('/', "\\");
    let trimmed = value.trim_end_matches('\\').to_lowercase();
    // 保留 `\\wsl$\...` 与 `\\wsl.localhost\...` 两种写法都可比对：
    // 这里不做等价改写，交给调用方用 `home_key` 统一。
    trimmed
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
