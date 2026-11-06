//! 预算金额的有限十进制加法与比较，不经过二进制浮点求和。
//!
//! 只支持非负十进制，不做乘除或舍入。防御上限是 20 位整数和 4096 位
//! 小数（规范化后的实际位数），超限返回未知而不是截断；这不是货币精度。
//! 非负加法超过整数上限后不可能靠后续项恢复，且小数上限在各输入解析时
//! 独立检查，因此拆片/顺序不会改变是否超限。没有新增第三方依赖。

use std::cmp::Ordering;

const MAX_INTEGER_DIGITS: usize = 20;
const MAX_FRACTIONAL_DIGITS: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DecimalAmount {
    // 低位在前，每个元素为 0..=9；无高位零，无可消去的小数末尾零。
    digits: Vec<u8>,
    scale: usize,
}

impl DecimalAmount {
    pub(crate) fn zero() -> Self {
        Self {
            digits: vec![0],
            scale: 0,
        }
    }

    pub(crate) fn parse(raw: &str) -> Option<Self> {
        // 沿用来源金额的有限/非负/上界规则，但不采用该 f64 的数值。
        // 非零的浮点下溢仍按原始十进制保留，不能变成实测零。
        super::amount(raw)?;
        let raw = raw.trim();
        let negative = raw.starts_with('-');
        let unsigned = raw.strip_prefix(['+', '-']).unwrap_or(raw);
        let mut parts = unsigned.split(['e', 'E']);
        let mantissa = parts.next()?;
        let exponent = parts
            .next()
            .map(str::parse::<i64>)
            .transpose()
            .ok()?
            .unwrap_or(0);
        if parts.next().is_some() {
            return None;
        }
        let (integer, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
        if integer.is_empty() && fraction.is_empty()
            || !integer
                .bytes()
                .chain(fraction.bytes())
                .all(|digit| digit.is_ascii_digit())
        {
            return None;
        }
        let digits: Vec<u8> = integer.bytes().chain(fraction.bytes()).collect();
        let Some(first) = digits.iter().position(|digit| *digit != b'0') else {
            return Some(Self::zero());
        };
        if negative {
            return None;
        }
        let last = digits.iter().rposition(|digit| *digit != b'0')?;
        let shift = exponent
            .checked_sub(i64::try_from(fraction.len()).ok()?)?
            .checked_add(i64::try_from(digits.len() - last - 1).ok()?)?;
        let significant = &digits[first..=last];
        let integer_digits = i64::try_from(significant.len()).ok()?.checked_add(shift)?;
        if integer_digits > MAX_INTEGER_DIGITS as i64 {
            return None;
        }
        let scale = usize::try_from(shift.checked_neg()?.max(0)).ok()?;
        if scale > MAX_FRACTIONAL_DIGITS {
            return None;
        }
        let mut result = Self {
            digits: vec![0; usize::try_from(shift.max(0)).ok()?],
            scale,
        };
        result
            .digits
            .extend(significant.iter().rev().map(|digit| *digit - b'0'));
        Some(result)
    }

    /// 兼容既有 JSON number 配置：阈值含义是这个 number 的最短 round-trip
    /// 十进制文本（例如 0.8），不是其 IEEE-754 的完整二进制展开。
    /// 只能用于原本就是 number 的配置，不能用于已求和的显示金额。
    pub(crate) fn from_config_number(value: f64) -> Option<Self> {
        Self::parse(&value.to_string())
    }

    pub(crate) fn checked_add(mut self, other: &Self) -> Option<Self> {
        // 消费/复用累加器，而非每笔复制全部小数位。含 1e-4096 的响应
        // 随后累加大量零或整数时，只访问新项数位及必要进位。
        if other.is_zero() {
            return Some(self);
        }
        if self.is_zero() {
            return Some(other.clone());
        }
        if other.scale > self.scale {
            let shift = other.scale - self.scale;
            self.digits.splice(..0, std::iter::repeat_n(0, shift));
            self.scale = other.scale;
        }
        let right_shift = self.scale - other.scale;
        self.digits
            .resize(self.digits.len().max(other.digits.len() + right_shift), 0);
        let mut carry = 0;
        let mut position = right_shift;
        for digit in &other.digits {
            let value = self.digits[position] + *digit + carry;
            self.digits[position] = value % 10;
            carry = value / 10;
            position += 1;
        }
        while carry != 0 {
            if position == self.digits.len() {
                self.digits.push(carry);
                break;
            }
            let value = self.digits[position] + carry;
            self.digits[position] = value % 10;
            carry = value / 10;
            position += 1;
        }
        self.normalize();
        (self.digits.len() <= self.scale + MAX_INTEGER_DIGITS).then_some(self)
    }

    pub(crate) fn cmp(&self, other: &Self) -> Ordering {
        // 规范化的零没有有效数量级，不能把补齐小数位的零当成高位。
        match (self.is_zero(), other.is_zero()) {
            (true, true) => return Ordering::Equal,
            (true, false) => return Ordering::Less,
            (false, true) => return Ordering::Greater,
            (false, false) => {}
        }
        let scale = self.scale.max(other.scale);
        let left_shift = scale - self.scale;
        let right_shift = scale - other.scale;
        let left_width = self.digits.len() + left_shift;
        let right_width = other.digits.len() + right_shift;
        match left_width.cmp(&right_width) {
            Ordering::Equal => {}
            different => return different,
        }
        for position in (0..left_width).rev() {
            match self
                .digit_at(position, left_shift)
                .cmp(&other.digit_at(position, right_shift))
            {
                Ordering::Equal => {}
                different => return different,
            }
        }
        Ordering::Equal
    }

    fn digit_at(&self, position: usize, shift: usize) -> u8 {
        position
            .checked_sub(shift)
            .and_then(|index| self.digits.get(index))
            .copied()
            .unwrap_or(0)
    }

    fn is_zero(&self) -> bool {
        self.digits == [0]
    }

    fn normalize(&mut self) {
        while self.digits.len() > 1 && self.digits.last() == Some(&0) {
            self.digits.pop();
        }
        if self.digits == [0] {
            self.scale = 0;
            return;
        }
        let trailing = self
            .digits
            .iter()
            .take(self.scale)
            .take_while(|digit| **digit == 0)
            .count();
        self.digits.drain(..trailing);
        self.scale -= trailing;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decimal(raw: &str) -> DecimalAmount {
        DecimalAmount::parse(raw).unwrap()
    }

    #[test]
    fn r20_decimal_addition_preserves_equality_and_subcent_digits() {
        assert_eq!(
            decimal("0.10").checked_add(&decimal("0.70")),
            Some(decimal("0.80"))
        );
        assert_eq!(
            decimal("1e-6").checked_add(&decimal("0.799999")),
            Some(decimal(".80"))
        );
        let threshold = DecimalAmount::from_config_number(0.8).unwrap();
        for (raw, expected) in [
            ("0.799999", Ordering::Less),
            ("0.80", Ordering::Equal),
            ("0.800001", Ordering::Greater),
            ("0.79999999999999999999999999999999999999", Ordering::Less),
            (
                "0.80000000000000000000000000000000000001",
                Ordering::Greater,
            ),
        ] {
            assert_eq!(decimal(raw).cmp(&threshold), expected, "{raw}");
        }
        assert_eq!(decimal("1e-400").cmp(&decimal("0")), Ordering::Greater);
        assert_eq!(decimal("0").cmp(&decimal("1e-400")), Ordering::Less);
        assert_eq!(
            decimal("1e-400").checked_add(&decimal("2e-400")),
            Some(decimal("3e-400"))
        );
    }

    #[test]
    fn r20_decimal_normalization_zero_syntax_and_defensive_limits() {
        for zero in ["0", "-0", "+0.000", "0e10000", "0e-10000"] {
            assert_eq!(decimal(zero), DecimalAmount::zero(), "{zero}");
        }
        for raw in [".8", "08.00", "+8e-1", " 0.800 ", "8000e-4"] {
            assert_eq!(decimal(raw), decimal("0.8"), "{raw}");
        }
        for raw in [
            "", ".", "NaN", "inf", "-1", "-1e-400", "1e40", "1e-4097", "1e--2", "1e2e3",
        ] {
            assert_eq!(DecimalAmount::parse(raw), None, "{raw}");
        }
        let tiny = decimal("1e-4096");
        assert!(tiny.checked_add(&decimal("1")).is_some());
        let large = decimal("10000000000000000000");
        let mut sum = DecimalAmount::zero();
        for _ in 0..9 {
            sum = sum.checked_add(&large).unwrap();
        }
        assert!(
            sum.checked_add(&large).is_none(),
            "20 位整数累计溢出不能变成零"
        );
    }

    #[test]
    fn r20_decimal_sparse_addition_and_carry_are_order_independent() {
        let tiny = decimal("1e-4096");
        let mut sum = tiny.clone();
        for _ in 0..1000 {
            sum = sum.checked_add(&DecimalAmount::zero()).unwrap();
            sum = sum.checked_add(&decimal("1")).unwrap();
        }
        assert_eq!(sum, decimal("1000").checked_add(&tiny).unwrap());
        assert_eq!(
            decimal("0.999999").checked_add(&decimal("0.000001")),
            Some(decimal("1"))
        );
        assert_eq!(
            decimal("0.000001").checked_add(&decimal("0.999999")),
            Some(decimal("1"))
        );
    }
}
