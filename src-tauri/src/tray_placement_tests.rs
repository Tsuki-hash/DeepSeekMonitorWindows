//! R17 唤窗几何回归。只检查生产共用的计算函数，不替代 Windows 原生验收。
//! 本轮只新增测试文本，未运行。

use super::{main_window_geometry, MainWindowPlacement};
use crate::window_pos::WorkArea;

fn assert_inside(area: WorkArea, (width, height, x, y): (u32, u32, i32, i32)) {
    assert!(width > 0 && height > 0);
    assert!(x >= area.x && y >= area.y);
    assert!(x + width as i32 <= area.right());
    assert!(y + height as i32 <= area.bottom());
}

#[test]
fn r17_拔掉大屏后托盘回退先缩尺寸再定位() {
    let area = WorkArea {
        x: 0,
        y: 0,
        width: 500,
        height: 400,
    };
    let geometry = main_window_geometry(
        area,
        1440,
        1520,
        1.0,
        MainWindowPlacement::NearTray(490.0, 410.0),
    );
    assert_eq!(geometry, (476, 376, 12, 12));
    assert_inside(area, geometry);
}

#[test]
fn r17_无位置记录时保留正常尺寸与托盘贴边() {
    let area = WorkArea {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };
    let geometry = main_window_geometry(
        area,
        356,
        600,
        1.0,
        MainWindowPlacement::NearTray(1800.0, 1020.0),
    );
    assert_eq!(geometry, (356, 600, 1552, 428));
    assert_inside(area, geometry);
}

#[test]
fn r17_记录恢复与托盘回退共用目标屏_dpi_尺寸边界() {
    let area = WorkArea {
        x: 40,
        y: 60,
        width: 1000,
        height: 720,
    };
    for (scale, margin) in [(1.0, 12), (1.25, 15), (1.5, 18), (2.0, 24)] {
        for placement in [
            MainWindowPlacement::SavedPosition(1000, 700),
            MainWindowPlacement::NearTray(1020.0, 800.0),
        ] {
            let geometry = main_window_geometry(area, 1440, 1520, scale, placement);
            assert_eq!(geometry.0, 1000 - 2 * margin);
            assert_eq!(geometry.1, 720 - 2 * margin);
            assert_inside(area, geometry);
        }
    }
}

#[test]
fn r17_四边任务栏按工作区而非显示器全屏定位() {
    // 工作区原点不是 (0,0)，模拟任务栏或多屏偏移；锚点在区外的任务栏中。
    let area = WorkArea {
        x: 100,
        y: 80,
        width: 1280,
        height: 720,
    };
    for (anchor_x, anchor_y, expected_x, expected_y) in [
        (740.0, 820.0, 562, 488),
        (740.0, 20.0, 562, 92),
        (20.0, 440.0, 112, 290),
        (1420.0, 440.0, 1012, 290),
    ] {
        let geometry = main_window_geometry(
            area,
            356,
            300,
            1.0,
            MainWindowPlacement::NearTray(anchor_x, anchor_y),
        );
        assert_eq!(geometry, (356, 300, expected_x, expected_y));
        assert_inside(area, geometry);
    }
}

#[test]
fn r17_负坐标工作区及已失效托盘锚点仍约束完整矩形() {
    let area = WorkArea {
        x: -1280,
        y: -80,
        width: 1280,
        height: 720,
    };
    for anchor in [(-1240.0, 660.0), (5000.0, -2000.0)] {
        let geometry = main_window_geometry(
            area,
            1440,
            1520,
            1.5,
            MainWindowPlacement::NearTray(anchor.0, anchor.1),
        );
        assert_eq!((geometry.0, geometry.1), (1244, 684));
        assert_inside(area, geometry);
    }
}

#[test]
fn r17_有效记录保持用户位置_只在完整矩形越界时夹回() {
    let area = WorkArea {
        x: -1024,
        y: -768,
        width: 1024,
        height: 768,
    };
    let geometry = main_window_geometry(
        area,
        356,
        600,
        1.25,
        MainWindowPlacement::SavedPosition(-900, -650),
    );
    assert_eq!(geometry, (356, 600, -900, -650));
    assert_inside(area, geometry);
    let clamped = main_window_geometry(
        area,
        356,
        600,
        1.25,
        MainWindowPlacement::SavedPosition(-10, -10),
    );
    assert_eq!(clamped, (356, 600, -356, -600));
    assert_inside(area, clamped);
}

#[test]
fn r17_跨屏_dpi_调整后的实际尺寸再次受相同边界约束() {
    let area = WorkArea {
        x: 0,
        y: 0,
        width: 800,
        height: 600,
    };
    let placement = MainWindowPlacement::NearTray(780.0, 620.0);
    let before_move = main_window_geometry(area, 640, 480, 2.0, placement);
    assert_eq!(before_move, (640, 480, 136, 96));
    // 合成原生跨屏后返回更大的 outer_size，不把第一次计划尺寸当成实际尺寸。
    let after_move = main_window_geometry(area, 1280, 960, 2.0, placement);
    assert_eq!(after_move, (752, 552, 24, 24));
    assert_inside(area, after_move);
}
