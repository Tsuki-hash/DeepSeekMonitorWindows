//! Lossless model identity for history/export, alongside the existing dashboard slots.
use crate::deepseek_api::ModelUsage;
use crate::usage::{cost_sum, model_slot, Entry};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawModelUsage {
    pub model: String,
    pub group_key: Option<String>,
    pub total_tokens: Option<u64>,
    pub request_count: Option<u64>,
    pub cache_hit_tokens: Option<u64>,
    pub cache_miss_tokens: Option<u64>,
    pub response_tokens: Option<u64>,
    pub other_tokens: Option<u64>,
    pub cost: Option<f64>,
    pub data_warning: Option<String>,
}

const MAX_SAFE_COUNT: u64 = 9_007_199_254_740_991;
fn count(value: &str) -> Option<u64> {
    let value = value.trim();
    let (integer, fractional) = value.split_once('.').unwrap_or((value, ""));
    if integer.is_empty()
        || !integer.bytes().all(|c| c.is_ascii_digit())
        || !fractional.bytes().all(|c| c == b'0')
    {
        return None;
    }
    integer
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= MAX_SAFE_COUNT)
}
fn sum(entries: &[Entry], include: impl Fn(&str) -> bool) -> Option<u64> {
    entries
        .iter()
        .filter(|entry| include(&entry.kind))
        .try_fold(0u64, |total, entry| {
            total
                .checked_add(count(&entry.amount)?)
                .filter(|value| *value <= MAX_SAFE_COUNT)
        })
}

pub fn raw_models(amount: &[ModelUsage], cost: &[ModelUsage]) -> Vec<RawModelUsage> {
    let mut tokens: BTreeMap<&str, Vec<_>> = BTreeMap::new();
    let mut costs = BTreeMap::new();
    for row in amount {
        tokens
            .entry(&row.model)
            .or_default()
            .extend(row.usage.iter().cloned());
    }
    for row in cost {
        *costs.entry(row.model.as_str()).or_insert(0.0) += cost_sum(&row.usage);
    }
    let names: std::collections::BTreeSet<_> = tokens.keys().chain(costs.keys()).copied().collect();
    names
        .into_iter()
        .map(|model| {
            let entries = tokens.get(model);
            let values = entries.map(Vec::as_slice).unwrap_or(&[]);
            let present = |kind: &str| entries.is_some_and(|e| e.iter().any(|x| x.kind == kind));
            let has_tokens = entries.is_some_and(|e| e.iter().any(|x| x.kind != "REQUEST"));
            let request = sum(values, |kind| kind == "REQUEST");
            let hit = sum(values, |kind| kind == "PROMPT_CACHE_HIT_TOKEN");
            let miss = sum(values, |kind| kind == "PROMPT_CACHE_MISS_TOKEN");
            let response = sum(values, |kind| kind == "RESPONSE_TOKEN");
            // Preserve the dashboard's zero-detail PROMPT_TOKEN fallback, but invalid
            // cache detail stays unknown and cannot be replaced by a prompt total.
            let prompt_fallback = hit == Some(0) && miss == Some(0);
            let other = sum(values, |kind| match kind {
                "REQUEST"
                | "PROMPT_CACHE_HIT_TOKEN"
                | "PROMPT_CACHE_MISS_TOKEN"
                | "RESPONSE_TOKEN" => false,
                "PROMPT_TOKEN" => prompt_fallback,
                _ => true,
            });
            let total = [hit, miss, response, other]
                .into_iter()
                .try_fold(0u64, |total, value| {
                    total
                        .checked_add(value?)
                        .filter(|value| *value <= MAX_SAFE_COUNT)
                });
            let invalid = values.iter().any(|entry| count(&entry.amount).is_none())
                || [request, hit, miss, response, other, total]
                    .iter()
                    .any(Option::is_none);
            RawModelUsage {
                model: model.to_owned(),
                group_key: model_slot(model).map(|(key, _)| key.to_owned()),
                total_tokens: has_tokens.then_some(total).flatten(),
                request_count: present("REQUEST").then_some(request).flatten(),
                cache_hit_tokens: present("PROMPT_CACHE_HIT_TOKEN").then_some(hit).flatten(),
                cache_miss_tokens: present("PROMPT_CACHE_MISS_TOKEN").then_some(miss).flatten(),
                response_tokens: present("RESPONSE_TOKEN").then_some(response).flatten(),
                other_tokens: has_tokens.then_some(other).flatten(),
                cost: costs.get(model).copied(),
                data_warning: invalid
                    .then(|| "平台 Token 计数异常，受影响的历史字段保留为未知".into()),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::Entry;
    fn row(model: &str, kind: &str, amount: &str) -> ModelUsage {
        ModelUsage {
            model: model.into(),
            usage: vec![Entry {
                kind: kind.into(),
                amount: amount.into(),
            }],
        }
    }
    #[test]
    fn invalid_counts_stay_unknown_and_valid_siblings_survive() {
        for value in [
            "",
            "not-a-number",
            "NaN",
            "Infinity",
            "-10",
            "1.5",
            "9007199254740992",
            "18446744073709551616",
        ] {
            let data = raw_models(
                &[
                    row("model", "RESPONSE_TOKEN", value),
                    row("model", "PROMPT_CACHE_HIT_TOKEN", "100.0"),
                ],
                &[],
            );
            assert_eq!(data[0].total_tokens, None, "{value}");
            assert_eq!(data[0].response_tokens, None, "{value}");
            assert_eq!(data[0].cache_hit_tokens, Some(100));
            assert!(data[0].data_warning.is_some());
        }
        let zero = raw_models(&[row("model", "RESPONSE_TOKEN", "0.0")], &[]);
        assert_eq!(zero[0].total_tokens, Some(0));
        assert!(zero[0].data_warning.is_none());
        let overflow = raw_models(
            &[
                row("model", "RESPONSE_TOKEN", "9007199254740991"),
                row("model", "RESPONSE_TOKEN", "1"),
            ],
            &[],
        );
        assert_eq!(overflow[0].response_tokens, None);
        assert!(overflow[0].data_warning.is_some());
    }
    #[test]
    fn prompt_fallback_preserves_cache_rules_without_masking_invalid_details() {
        let raw = |rows: Vec<ModelUsage>| raw_models(&rows, &[]).remove(0);
        assert_eq!(
            raw(vec![row("m", "PROMPT_TOKEN", "100.0")]).total_tokens,
            Some(100)
        );
        assert_eq!(
            raw(vec![
                row("m", "PROMPT_CACHE_HIT_TOKEN", "10"),
                row("m", "PROMPT_TOKEN", "100")
            ])
            .total_tokens,
            Some(10)
        );
        assert_eq!(
            raw(vec![
                row("m", "PROMPT_CACHE_HIT_TOKEN", "0"),
                row("m", "PROMPT_TOKEN", "100")
            ])
            .total_tokens,
            Some(100)
        );
        assert_eq!(
            raw(vec![
                row("m", "PROMPT_CACHE_HIT_TOKEN", ""),
                row("m", "PROMPT_TOKEN", "100")
            ])
            .total_tokens,
            None
        );
        let requests = raw(vec![
            row("m", "REQUEST", "NaN"),
            row("m", "RESPONSE_TOKEN", "20"),
        ]);
        assert_eq!(requests.total_tokens, Some(20));
        assert_eq!(requests.request_count, None);
    }
    #[test]
    fn 保留新旧名称与未知模型_重复数量累计一次对应费用() {
        let amount = vec![
            row("deepseek-flash", "RESPONSE_TOKEN", "10"),
            row("deepseek-flash", "RESPONSE_TOKEN", "20"),
            row("deepseek-v4-flash", "RESPONSE_TOKEN", "5"),
            row("new-model", "RESPONSE_TOKEN", "7"),
        ];
        let result = raw_models(&amount, &[]);
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].model, "deepseek-flash");
        assert_eq!(result[0].total_tokens, Some(30));
        assert_eq!(result[0].cost, None);
        assert_eq!(result[1].group_key.as_deref(), Some("flash"));
        assert_eq!(result[2].group_key, None);
    }
    #[test]
    fn 只有费用或请求数_缺失token不伪造零() {
        let result = raw_models(
            &[row("requests", "REQUEST", "2")],
            &[row("cost-only", "RESPONSE_TOKEN", "1")],
        );
        assert_eq!(result[0].total_tokens, None);
        assert!(result[0].cost.is_some());
        assert_eq!(result[1].request_count, Some(2));
        assert_eq!(result[1].total_tokens, None);
        assert_eq!(result[1].response_tokens, None);
    }
}
