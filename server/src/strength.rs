//! Trail strength: Wilson lower bound over outcome reports, with the author's quality
//! score as a weak prior, decayed with a half-life since the last success: 90 days for a fix, longer for a procedure
//! or a fact.

use std::sync::LazyLock;

const Z: f64 = 1.96;
const PRIOR_WEIGHT: f64 = 2.0;
/// A fix goes stale with the versions it was found on.
const HALF_LIFE_DAYS: f64 = 90.0;
/// A procedure or a fact describes an organisation's own systems, which change on their own schedule: a VPN, a
/// disaster-recovery runbook or which machine does what can stay true for years without anyone needing it.
/// `MYRMO_KNOWLEDGE_HALF_LIFE_DAYS`, 365 by default; 0 means it never fades.
static KNOWLEDGE_HALF_LIFE_DAYS: LazyLock<f64> = LazyLock::new(|| {
    std::env::var("MYRMO_KNOWLEDGE_HALF_LIFE_DAYS")
        .ok()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|d| d.is_finite() && *d >= 0.0)
        .unwrap_or(365.0)
});

/// The half-life of a trail of this kind, in days; 0 means it does not fade.
pub fn half_life_days(kind: &str) -> f64 {
    match kind {
        "procedure" | "fact" => *KNOWLEDGE_HALF_LIFE_DAYS,
        _ => HALF_LIFE_DAYS,
    }
}

pub fn strength(
    worked: u64,
    partially_worked: u64,
    failed: u64,
    quality: f64,
    days_since_success: f64,
    half_life: f64,
) -> f64 {
    let n = (worked + partially_worked + failed) as f64 + PRIOR_WEIGHT;
    let successes =
        worked as f64 + 0.5 * partially_worked as f64 + PRIOR_WEIGHT * quality.clamp(0.0, 1.0);
    let p = successes / n;
    let z2 = Z * Z;
    let centre = p + z2 / (2.0 * n);
    let margin = Z * ((p * (1.0 - p)) / n + z2 / (4.0 * n * n)).sqrt();
    let wilson = ((centre - margin) / (1.0 + z2 / n)).max(0.0);
    if half_life <= 0.0 {
        return wilson;
    }
    wilson * 0.5f64.powf(days_since_success.max(0.0) / half_life)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 0.005
    }

    #[test]
    fn matches_documented_reference_points() {
        assert!(
            close(strength(0, 0, 0, 0.8, 0.0, HALF_LIFE_DAYS), 0.223),
            "{}",
            strength(0, 0, 0, 0.8, 0.0, HALF_LIFE_DAYS)
        );
        assert!(close(strength(214, 12, 9, 0.7, 0.0, HALF_LIFE_DAYS), 0.895));
        assert!(close(
            strength(214, 12, 9, 0.7, 90.0, HALF_LIFE_DAYS),
            0.448
        ));
    }

    #[test]
    fn a_procedure_or_a_fact_fades_slower_than_a_fix_and_can_be_kept_from_fading() {
        let fix = strength(3, 0, 0, 0.7, 365.0, half_life_days("fix"));
        let fact = strength(3, 0, 0, 0.7, 365.0, half_life_days("fact"));
        assert!(fact > 4.0 * fix, "a year on: fact {fact}, fix {fix}");
        assert_eq!(half_life_days("procedure"), half_life_days("fact"));
        assert!(
            close(
                strength(3, 0, 0, 0.7, 1000.0, 0.0),
                strength(3, 0, 0, 0.7, 0.0, 0.0)
            ),
            "0 never fades"
        );
    }

    #[test]
    fn evidence_beats_small_samples() {
        assert!(
            strength(214, 0, 21, 0.7, 0.0, HALF_LIFE_DAYS)
                > strength(3, 0, 0, 0.7, 0.0, HALF_LIFE_DAYS)
        );
    }
}
