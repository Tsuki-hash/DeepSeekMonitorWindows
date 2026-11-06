//! R19 最小化恢复决策回归；只用替身，不创建原生窗口。本轮未执行。

use super::{
    apply_main_window_intent, can_persist_main_window_position, MainWindowActions,
    MainWindowIntent, MainWindowVisibility, RestorePlacement,
};
use std::cell::{Cell, RefCell};

struct FakeWindow {
    state: Cell<MainWindowVisibility>,
    calls: RefCell<Vec<&'static str>>,
    fail: Option<&'static str>,
    query_count: Cell<usize>,
    fail_query: Option<usize>,
    keep_minimized: bool,
    keep_hidden: bool,
}

impl FakeWindow {
    fn new(visible: bool, minimized: bool) -> Self {
        Self {
            state: Cell::new(MainWindowVisibility { visible, minimized }),
            calls: RefCell::new(Vec::new()),
            fail: None,
            query_count: Cell::new(0),
            fail_query: None,
            keep_minimized: false,
            keep_hidden: false,
        }
    }

    fn record(&self, action: &'static str) -> Result<(), String> {
        self.calls.borrow_mut().push(action);
        if self.fail == Some(action) {
            Err(format!("{action} failed"))
        } else {
            Ok(())
        }
    }

    fn calls(&self) -> Vec<&'static str> {
        self.calls.borrow().clone()
    }
}

impl MainWindowActions for FakeWindow {
    fn visibility(&self) -> Result<MainWindowVisibility, String> {
        self.record("state")?;
        let count = self.query_count.get() + 1;
        self.query_count.set(count);
        if self.fail_query == Some(count) {
            return Err("state query failed".into());
        }
        Ok(self.state.get())
    }

    fn unminimize(&self) -> Result<(), String> {
        self.record("unminimize")?;
        if !self.keep_minimized {
            self.state.set(MainWindowVisibility {
                minimized: false,
                ..self.state.get()
            });
        }
        Ok(())
    }

    fn position(&self, placement: RestorePlacement) -> Result<(), String> {
        assert!(!self.state.get().minimized, "不能使用 iconic 外框");
        self.record(match placement {
            RestorePlacement::Saved => "position_saved",
            RestorePlacement::Current => "position_current",
        })
    }

    fn show(&self) -> Result<(), String> {
        self.record("show")?;
        if !self.keep_hidden {
            self.state.set(MainWindowVisibility {
                visible: true,
                ..self.state.get()
            });
        }
        Ok(())
    }

    fn focus(&self) -> Result<(), String> {
        assert!(self.state.get().visible);
        assert!(!self.state.get().minimized);
        self.record("focus")
    }

    fn hide(&self) -> Result<(), String> {
        self.record("hide")?;
        self.state.set(MainWindowVisibility {
            visible: false,
            ..self.state.get()
        });
        self.record("hidden")
    }

    fn emit_shown(&self) -> Result<(), String> {
        self.record("shown")
    }

    fn emit_quit(&self) -> Result<(), String> {
        self.record("quit")
    }
}

#[test]
fn r19_菜单显示_重复启动_切换和退出均先恢复最小化() {
    for visible in [false, true] {
        for intent in [
            MainWindowIntent::Show,
            MainWindowIntent::Toggle,
            MainWindowIntent::Quit,
        ] {
            let window = FakeWindow::new(visible, true);
            apply_main_window_intent(&window, intent).unwrap();
            let mut expected = vec![
                "state",
                "unminimize",
                "state",
                "position_current",
                "show",
                "state",
                "focus",
                "shown",
            ];
            if intent == MainWindowIntent::Quit {
                expected.push("quit");
            }
            assert_eq!(window.calls(), expected);
            assert_eq!(
                window.state.get(),
                MainWindowVisibility {
                    visible: true,
                    minimized: false
                }
            );
        }
    }
}

#[test]
fn r19_只有正常可见窗口才走切换隐藏() {
    let window = FakeWindow::new(true, false);
    apply_main_window_intent(&window, MainWindowIntent::Toggle).unwrap();
    assert_eq!(window.calls(), ["state", "hide", "hidden"]);
    assert!(!window.state.get().visible);
}

#[test]
fn r19_普通隐藏窗仍恢复记录_不调用解除最小化() {
    for intent in [
        MainWindowIntent::Show,
        MainWindowIntent::Toggle,
        MainWindowIntent::Quit,
    ] {
        let window = FakeWindow::new(false, false);
        apply_main_window_intent(&window, intent).unwrap();
        let mut expected = vec!["state", "position_saved", "show", "state", "focus", "shown"];
        if intent == MainWindowIntent::Quit {
            expected.push("quit");
        }
        assert_eq!(window.calls(), expected);
    }
}

#[test]
fn r19_已显示窗再次显示或退出不覆盖当前外框() {
    for intent in [MainWindowIntent::Show, MainWindowIntent::Quit] {
        let window = FakeWindow::new(true, false);
        apply_main_window_intent(&window, intent).unwrap();
        let mut expected = vec![
            "state",
            "position_current",
            "show",
            "state",
            "focus",
            "shown",
        ];
        if intent == MainWindowIntent::Quit {
            expected.push("quit");
        }
        assert_eq!(window.calls(), expected);
    }
}

#[test]
fn r19_解除最小化失败或原生无效果不定位_不通知_不退出() {
    for fail in [false, true] {
        let mut window = FakeWindow::new(true, true);
        if fail {
            window.fail = Some("unminimize");
        } else {
            window.keep_minimized = true;
        }
        assert!(apply_main_window_intent(&window, MainWindowIntent::Quit).is_err());
        let expected = if fail {
            vec!["state", "unminimize"]
        } else {
            vec!["state", "unminimize", "state"]
        };
        assert_eq!(window.calls(), expected);
    }
}

#[test]
fn r19_状态查询失败不冒充正常窗口且不发退出意图() {
    for fail_query in [1, 2, 3] {
        let mut window = FakeWindow::new(true, true);
        window.fail_query = Some(fail_query);
        assert!(apply_main_window_intent(&window, MainWindowIntent::Quit).is_err());
        assert!(!window.calls().contains(&"shown"));
        assert!(!window.calls().contains(&"quit"));
        if fail_query < 3 {
            assert!(!window.calls().contains(&"position_current"));
        }
    }
}

#[test]
fn r19_显示失败或原生仍隐藏不聚焦_不通知_不退出() {
    for fail in [false, true] {
        let mut window = FakeWindow::new(false, false);
        if fail {
            window.fail = Some("show");
        } else {
            window.keep_hidden = true;
        }
        assert!(apply_main_window_intent(&window, MainWindowIntent::Quit).is_err());
        assert!(!window.calls().contains(&"focus"));
        assert!(!window.calls().contains(&"shown"));
        assert!(!window.calls().contains(&"quit"));
    }
}

#[test]
fn r19_定位失败仍尝试显示_成功后才通知草稿退出协商() {
    let mut window = FakeWindow::new(true, true);
    window.fail = Some("position_current");
    apply_main_window_intent(&window, MainWindowIntent::Quit).unwrap();
    assert_eq!(
        window.calls(),
        [
            "state",
            "unminimize",
            "state",
            "position_current",
            "show",
            "state",
            "focus",
            "shown",
            "quit",
        ]
    );
}

#[test]
fn r19_聚焦失败仍发送真实显示通知但不提交退出意图() {
    let mut window = FakeWindow::new(false, false);
    window.fail = Some("focus");
    assert!(apply_main_window_intent(&window, MainWindowIntent::Quit).is_err());
    assert!(window.state.get().visible);
    assert_eq!(window.calls().last(), Some(&"shown"));
    assert!(!window.calls().contains(&"quit"));
}

#[test]
fn r19_显示事件失败不继续退出_退出事件失败不直接结束进程() {
    for action in ["shown", "quit"] {
        let mut window = FakeWindow::new(false, false);
        window.fail = Some(action);
        assert!(apply_main_window_intent(&window, MainWindowIntent::Quit).is_err());
        assert_eq!(window.calls().last(), Some(&action));
        assert!(window.state.get().visible);
        if action == "shown" {
            assert!(!window.calls().contains(&"quit"));
        }
    }
}

#[test]
fn r19_隐藏失败保留可见状态_不继续执行显示或退出() {
    let mut window = FakeWindow::new(true, false);
    window.fail = Some("hide");
    assert!(apply_main_window_intent(&window, MainWindowIntent::Toggle).is_err());
    assert_eq!(window.calls(), ["state", "hide"]);
    assert!(window.state.get().visible);
}

#[test]
fn r19_连续切换读取最新状态_恢复后再隐藏再显示() {
    let window = FakeWindow::new(true, true);
    for expected in [true, false, true] {
        apply_main_window_intent(&window, MainWindowIntent::Toggle).unwrap();
        assert_eq!(window.state.get().visible, expected);
        assert!(!window.state.get().minimized);
    }
    let calls = window.calls();
    assert_eq!(
        calls.iter().filter(|&&call| call == "unminimize").count(),
        1
    );
    assert_eq!(calls.iter().filter(|&&call| call == "shown").count(), 2);
    assert_eq!(calls.iter().filter(|&&call| call == "hidden").count(), 1);
}

#[test]
fn r19_最小化_最大化或状态未知不覆盖正常位置记录() {
    for minimized in [None, Some(false), Some(true)] {
        for maximized in [None, Some(false), Some(true)] {
            assert_eq!(
                can_persist_main_window_position(minimized, maximized),
                minimized == Some(false) && maximized == Some(false),
            );
        }
    }
}
