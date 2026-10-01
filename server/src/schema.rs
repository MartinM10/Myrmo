//! Protocol validation against `protocol/trail.v1.schema.json`, compiled once.

use serde_json::{Value, json};
use std::sync::LazyLock;

static SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../protocol/trail.v1.schema.json"))
        .expect("schema is valid JSON")
});

static TRAIL: LazyLock<jsonschema::Validator> =
    LazyLock::new(|| jsonschema::draft7::new(&SCHEMA).expect("trail schema compiles"));

static OUTCOME: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    let schema = json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "definitions": SCHEMA["definitions"].clone(),
        "$ref": "#/definitions/outcome_report"
    });
    jsonschema::draft7::new(&schema).expect("outcome schema compiles")
});

fn errors(validator: &jsonschema::Validator, instance: &Value) -> Result<(), Vec<Value>> {
    let details: Vec<Value> = validator
        .iter_errors(instance)
        .take(20)
        .map(|e| json!({ "path": e.instance_path().to_string(), "message": e.to_string() }))
        .collect();
    if details.is_empty() {
        Ok(())
    } else {
        Err(details)
    }
}

pub fn validate_trail(instance: &Value) -> Result<(), Vec<Value>> {
    errors(&TRAIL, instance)
}

pub fn validate_outcome(instance: &Value) -> Result<(), Vec<Value>> {
    errors(&OUTCOME, instance)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn example_trail_is_valid() {
        let example: Value =
            serde_json::from_str(include_str!("../../protocol/examples/trail.distutils.json"))
                .unwrap();
        assert_eq!(validate_trail(&example), Ok(()));
    }

    #[test]
    fn rejects_absolute_patch_paths() {
        let mut example: Value =
            serde_json::from_str(include_str!("../../protocol/examples/trail.distutils.json"))
                .unwrap();
        example["solution"]["code_patches"][0]["file_path"] = json!("/home/x/req.txt");
        let errs = validate_trail(&example).unwrap_err();
        assert!(errs[0]["path"].as_str().unwrap().contains("code_patches"));
    }

    #[test]
    fn validates_outcome_reports() {
        let ok = json!({
            "protocol_version": "1.0",
            "solution_id": "3f2b8c1e-9a4d-4e2f-8b1a-2c3d4e5f6a7b",
            "outcome": "worked",
            "agent_info": {"model": "gpt-5", "framework": "crewai"}
        });
        assert_eq!(validate_outcome(&ok), Ok(()));
        let mut bad = ok.clone();
        bad["outcome"] = json!("great");
        assert!(validate_outcome(&bad).is_err());
    }
}
