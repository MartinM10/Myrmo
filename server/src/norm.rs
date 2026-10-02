//! Text normalisation shared by the risk rules and the prompt-injection scan. Both are
//! pattern matchers, and a pattern is only as good as the text it sees: zero-width characters,
//! compatibility forms and look-alike letters let the same words slip past it.

use unicode_normalization::UnicodeNormalization;

/// Characters that render as nothing (or reorder text) and exist mostly to split a word.
fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00ad}'
            | '\u{034f}'
            | '\u{061c}'
            | '\u{115f}'
            | '\u{1160}'
            | '\u{17b4}'
            | '\u{17b5}'
            | '\u{180e}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{206f}'
            | '\u{3164}'
            | '\u{feff}'
            | '\u{fe00}'..='\u{fe0f}'
            | '\u{e0000}'..='\u{e007f}'
    )
}

/// Compatibility-normalised text without invisible characters.
pub fn clean(text: &str) -> String {
    text.nfkc().filter(|c| !is_invisible(*c)).collect()
}

/// Cyrillic and Greek letters that look like Latin ones, folded to the Latin letter. Applied to
/// lowercase text only.
fn fold_confusable(c: char) -> char {
    match c {
        'а' | 'α' => 'a',
        'ь' | 'в' => 'b',
        'с' | 'ϲ' => 'c',
        'ԁ' => 'd',
        'е' | 'ε' => 'e',
        'ɡ' => 'g',
        'һ' => 'h',
        'і' | 'ι' | 'ӏ' | 'ı' => 'i',
        'ј' => 'j',
        'κ' | 'к' => 'k',
        'ⅼ' => 'l',
        'м' => 'm',
        'п' | 'η' => 'n',
        'о' | 'ο' => 'o',
        'р' | 'ρ' => 'p',
        'ѕ' => 's',
        'т' | 'τ' => 't',
        'υ' | 'ս' => 'u',
        'ν' | 'ѵ' => 'v',
        'ԝ' | 'ω' => 'w',
        'х' | 'χ' => 'x',
        'у' | 'γ' => 'y',
        other => other,
    }
}

/// Lowercase, invisible characters removed and look-alike letters folded: the form in which
/// natural-language patterns are matched.
pub fn fold(text: &str) -> String {
    clean(text)
        .to_lowercase()
        .chars()
        .map(fold_confusable)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_invisible_characters_and_compatibility_forms() {
        assert_eq!(clean("ig\u{200b}no\u{00ad}re"), "ignore");
        assert_eq!(clean("ｉｇｎｏｒｅ"), "ignore");
        assert_eq!(clean("a\u{202e}b"), "ab");
    }

    #[test]
    fn folds_look_alike_letters() {
        assert_eq!(fold("ignоre аll prеvious"), "ignore all previous");
        assert_eq!(fold("IGNORE"), "ignore");
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        assert_eq!(
            fold("No module named 'numpy' (línea 3)"),
            "no module named 'numpy' (línea 3)"
        );
    }
}
