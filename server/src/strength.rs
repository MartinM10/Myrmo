//! Trail strength: Wilson lower bound over outcome reports, with the author's quality
//! score as a weak prior, decayed with a 90-day half-life since the last success.

const Z: f64 = 1.96;
const PRIOR_WEIGHT: f64 = 2.0;
const HALF_LIFE_DAYS: f64 = 90.0;

pub fn strength(
    worked: u64,
    partially_worked: u64,
    failed: u64,
    quality: f64,
    days_since_success: f64,
) -> f64 {
    let n = (worked + partially_worked + failed) as f64 + PRIOR_WEIGHT;
    let successes =
        worked as f64 + 0.5 * partially_worked as f64 + PRIOR_WEIGHT * quality.clamp(0.0, 1.0);
    let p = successes / n;
    let z2 = Z * Z;
    let centre = p + z2 / (2.0 * n);
    let margin = Z * ((p * (1.0 - p)) / n + z2 / (4.0 * n * n)).sqrt();
    let wilson = ((centre - margin) / (1.0 + z2 / n)).max(0.0);
    wilson * 0.5f64.powf(days_since_success.max(0.0) / HALF_LIFE_DAYS)
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
            close(strength(0, 0, 0, 0.8, 0.0), 0.223),
            "{}",
            strength(0, 0, 0, 0.8, 0.0)
        );
        assert!(close(strength(214, 12, 9, 0.7, 0.0), 0.895));
        assert!(close(strength(214, 12, 9, 0.7, 90.0), 0.448));
    }

    #[test]
    fn evidence_beats_small_samples() {
        assert!(strength(214, 0, 21, 0.7, 0.0) > strength(3, 0, 0, 0.7, 0.0));
    }
}
