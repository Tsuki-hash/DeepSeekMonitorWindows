//! Process-lifetime quit mailbox. Events only wake the renderer; they never
//! authorize exit, and unacknowledged intent survives listener registration.

use std::sync::Mutex;

#[derive(Default)]
struct QuitOrder {
    issued: u64,
    acknowledged: u64,
}

impl QuitOrder {
    fn publish(&mut self) -> Result<(), String> {
        self.issued = self.issued.checked_add(1).ok_or("退出请求序号已耗尽")?;
        Ok(())
    }

    fn pending(&self) -> Option<String> {
        (self.issued > self.acknowledged).then(|| self.issued.to_string())
    }

    fn acknowledge(&mut self, intent: u64) -> Result<(), String> {
        if intent == 0 || intent > self.issued {
            return Err("退出请求序号无效".into());
        }
        // A delayed ack cannot clear a newer click, or roll the watermark back.
        self.acknowledged = self.acknowledged.max(intent);
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct QuitIntent(Mutex<QuitOrder>);

impl QuitIntent {
    pub(crate) fn publish(&self) -> Result<(), String> {
        self.0.lock().map_err(|_| "退出请求状态不可用")?.publish()
    }

    pub(crate) fn pending(&self) -> Result<Option<String>, String> {
        Ok(self.0.lock().map_err(|_| "退出请求状态不可用")?.pending())
    }

    pub(crate) fn acknowledge(&self, intent: &str) -> Result<(), String> {
        let sequence = intent.parse::<u64>().map_err(|_| "退出请求序号无效")?;
        if sequence.to_string() != intent {
            return Err("退出请求序号无效".into());
        }
        self.0
            .lock()
            .map_err(|_| "退出请求状态不可用")?
            .acknowledge(sequence)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn r32_quit_before_listener_remains_pending_until_acknowledged() {
        let mailbox = QuitIntent::default();
        assert_eq!(mailbox.pending().unwrap(), None);
        mailbox.publish().unwrap();
        // Losing an event or reading the snapshot does not consume the intent.
        assert_eq!(mailbox.pending().unwrap(), Some("1".into()));
        assert_eq!(mailbox.pending().unwrap(), Some("1".into()));
        mailbox.acknowledge("1").unwrap();
        assert_eq!(mailbox.pending().unwrap(), None);
    }

    #[test]
    fn r32_delayed_and_duplicate_ack_do_not_clear_newer_quit() {
        let mailbox = QuitIntent::default();
        mailbox.publish().unwrap();
        mailbox.publish().unwrap();
        mailbox.acknowledge("1").unwrap();
        mailbox.acknowledge("1").unwrap();
        assert_eq!(mailbox.pending().unwrap(), Some("2".into()));
        mailbox.acknowledge("2").unwrap();
        mailbox.acknowledge("1").unwrap();
        assert_eq!(mailbox.pending().unwrap(), None);
        mailbox.publish().unwrap();
        assert_eq!(mailbox.pending().unwrap(), Some("3".into()));
    }

    #[test]
    fn r32_invalid_or_future_ack_never_discards_pending_quit() {
        let mailbox = QuitIntent::default();
        mailbox.publish().unwrap();
        for invalid in ["0", "2", "-1", "+1", "01", "", " 1", "18446744073709551616"] {
            assert!(mailbox.acknowledge(invalid).is_err());
            assert_eq!(mailbox.pending().unwrap(), Some("1".into()));
        }
    }

    #[test]
    fn r32_quit_sequence_is_lossless_past_javascript_integer_precision() {
        let mut order = QuitOrder {
            issued: 9_007_199_254_740_991,
            acknowledged: 9_007_199_254_740_991,
        };
        order.publish().unwrap();
        order.publish().unwrap();
        assert_eq!(order.pending(), Some("9007199254740993".into()));
    }

    #[test]
    fn r32_exhausted_quit_sequence_does_not_wrap_or_revive_old_intent() {
        let mut order = QuitOrder {
            issued: u64::MAX,
            acknowledged: u64::MAX,
        };
        assert!(order.publish().is_err());
        assert_eq!(order.pending(), None);
    }
}
