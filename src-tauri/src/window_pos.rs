//! 面板相对托盘的定位计算。
//!
//! 纯几何：给定工作区、面板尺寸、边距与托盘锚点，算出应贴在哪条任务栏边。
//! 不依赖 Tauri 类型，便于单测四边任务栏。

/// 工作区矩形（物理像素）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl WorkArea {
    pub fn right(&self) -> i32 {
        self.x + self.width
    }

    pub fn bottom(&self) -> i32 {
        self.y + self.height
    }
}

/// 托盘所在的任务栏边。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskbarEdge {
    Bottom,
    Top,
    Left,
    Right,
}

/// 判断锚点更靠近工作区哪一条边（托盘通常贴着任务栏）。
pub fn nearest_edge(area: WorkArea, anchor_x: f64, anchor_y: f64) -> TaskbarEdge {
    let left = (anchor_x - area.x as f64).abs();
    let right = (area.right() as f64 - anchor_x).abs();
    let top = (anchor_y - area.y as f64).abs();
    let bottom = (area.bottom() as f64 - anchor_y).abs();

    let mut edge = TaskbarEdge::Bottom;
    let mut best = bottom;
    if top < best {
        edge = TaskbarEdge::Top;
        best = top;
    }
    if left < best {
        edge = TaskbarEdge::Left;
        best = left;
    }
    if right < best {
        edge = TaskbarEdge::Right;
    }
    edge
}

/// 面板左上角：贴在托盘所在边，并在平行方向上向托盘锚点靠拢。
pub fn panel_origin(
    area: WorkArea,
    panel_width: i32,
    panel_height: i32,
    margin: i32,
    anchor_x: f64,
    anchor_y: f64,
) -> (i32, i32) {
    let edge = nearest_edge(area, anchor_x, anchor_y);
    let max_x = area.right() - panel_width - margin;
    let max_y = area.bottom() - panel_height - margin;

    let (x, y) = match edge {
        TaskbarEdge::Bottom => {
            let x = (anchor_x as i32) - panel_width / 2;
            (x, max_y)
        }
        TaskbarEdge::Top => {
            let x = (anchor_x as i32) - panel_width / 2;
            (x, area.y + margin)
        }
        TaskbarEdge::Left => {
            let y = (anchor_y as i32) - panel_height / 2;
            (area.x + margin, y)
        }
        TaskbarEdge::Right => {
            let y = (anchor_y as i32) - panel_height / 2;
            (max_x, y)
        }
    };

    (
        x.clamp(area.x, max_x.max(area.x)),
        y.clamp(area.y, max_y.max(area.y)),
    )
}

/// 第五轮复评 N03：把窗口**完整矩形**约束进工作区。
///
/// 扩大尺寸（set_panel_mode）与托盘位置恢复都只保证过左上角 —— 右下角
/// 展开或分辨率/拔屏后恢复时，右/下边界可能超出工作区，右侧与底部控件
/// 不可见。窗口本身大于工作区时贴靠工作区左上角（宁可小于最小尺寸，
/// 不可整块不可见）。
pub fn clamp_origin_into_area(
    area: WorkArea,
    panel_width: i32,
    panel_height: i32,
    x: i32,
    y: i32,
) -> (i32, i32) {
    let mut x = x.max(area.x);
    let mut y = y.max(area.y);
    if x + panel_width > area.right() {
        x = (area.right() - panel_width).max(area.x);
    }
    if y + panel_height > area.bottom() {
        y = (area.bottom() - panel_height).max(area.y);
    }
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area() -> WorkArea {
        WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        }
    }

    #[test]
    fn 底部任务栏_面板在右下靠托盘() {
        // 锚点靠近右缘：水平居中会越界，应夹到工作区内
        let (x, y) = panel_origin(area(), 356, 600, 12, 1800.0, 1020.0);
        assert_eq!(y, 1040 - 600 - 12);
        assert_eq!(x, 1920 - 356 - 12, "靠右托盘：面板右缘贴工作区右缘内侧");
    }

    #[test]
    fn 底部任务栏_靠中部托盘_水平居中() {
        let (x, y) = panel_origin(area(), 356, 600, 12, 960.0, 1020.0);
        assert_eq!(y, 1040 - 600 - 12);
        assert_eq!(x, 960 - 356 / 2);
    }

    #[test]
    fn 顶部任务栏_面板贴上边() {
        let (x, y) = panel_origin(area(), 356, 600, 12, 900.0, 20.0);
        assert_eq!(y, 12);
        assert_eq!(x, 900 - 356 / 2);
    }

    #[test]
    fn 右侧任务栏_面板贴右边() {
        let (x, y) = panel_origin(area(), 356, 600, 12, 1900.0, 500.0);
        assert_eq!(x, 1920 - 356 - 12);
        assert_eq!(y, 500 - 600 / 2);
    }

    #[test]
    fn 左侧任务栏_面板贴左边() {
        let (x, y) = panel_origin(area(), 356, 600, 12, 20.0, 500.0);
        assert_eq!(x, 12);
        assert_eq!(y, 500 - 600 / 2);
    }

    #[test]
    fn 锚点居中时不越出工作区() {
        let (x, y) = panel_origin(area(), 356, 600, 12, 10.0, 10.0);
        assert!(x >= 0 && y >= 0);
        assert!(x + 356 <= 1920);
        assert!(y + 600 <= 1040);
    }

    // ---------- 第五轮复评 N03：完整矩形约束 ----------

    #[test]
    fn n03_右下角展开_完整矩形夹回工作区() {
        // 评审示例：1920×1040 工作区，窗口停在 (1552,428)，展开为 720×760 ——
        // 只调尺寸右/下边界会超出 352/148px；夹回后必须完整可见。
        let (x, y) = clamp_origin_into_area(area(), 720, 760, 1552, 428);
        assert_eq!(x, 1920 - 720);
        assert_eq!(y, 1040 - 760);
    }

    #[test]
    fn n03_窗口大于工作区_贴靠左上角() {
        let small = WorkArea {
            x: 100,
            y: 100,
            width: 500,
            height: 400,
        };
        let (x, y) = clamp_origin_into_area(small, 720, 760, 300, 300);
        assert_eq!((x, y), (100, 100));
    }

    #[test]
    fn n03_矩形已在工作区内_位置不动() {
        let (x, y) = clamp_origin_into_area(area(), 356, 600, 10, 10);
        assert_eq!((x, y), (10, 10));
    }

    #[test]
    fn n03_左上角越界先夹入_再验完整矩形() {
        // 恢复记录的左上角本身在屏幕外（负坐标屏拔掉后）：先夹入，
        // 再保证右/下不越界。
        let (x, y) = clamp_origin_into_area(area(), 356, 600, -800, -500);
        assert_eq!((x, y), (0, 0));
    }
}
