"""CI and cloud CLI errors that reproduce offline in a container.

Each task installs its tool (pinned) in the setup and then fails for a reason that is about the environment or the
configuration: missing credentials, a missing region, a git identity, a workflow file that the linter rejects. The
fixes change configuration or the environment, never application source code.
"""

from .base import Task

PY312 = {"name": "python", "version": "3.12"}
GIT = {"name": "git", "version": "2.47"}

AWSCLI = "awscli==1.46.1"
ACTIONLINT = "actionlint-py==1.7.12.25"

# A minimal workflow. Both variants share everything but the runner label, so each failure has one cause.
WORKFLOW_NO_RUNS_ON = "name: ci\\non: push\\njobs:\\n  build:\\n    steps:\\n      - run: echo hi\\n"
WORKFLOW_BAD_LABEL = "name: ci\\non: push\\njobs:\\n  build:\\n    runs-on: ubuntu-latst\\n    steps:\\n      - run: echo hi\\n"
WORKFLOW_FIXED = "name: ci\\non: push\\njobs:\\n  build:\\n    runs-on: ubuntu-24.04\\n    steps:\\n      - run: echo hi\\n"

TASKS = (
    Task(
        task_id="aws-cli-unable-locate-credentials",
        image="python:3.12-slim",
        runtime=PY312,
        category="configuration",
        error_type="Unable to locate credentials",
        summary="The AWS CLI stops with 'Unable to locate credentials' when a CI job runs an aws command and no access key is set in its environment or config files.",
        context="A CI job runs aws sts get-caller-identity or a deploy step on a runner that does not have the AWS keys exported.",
        setup="apt-get update -qq >/dev/null 2>&1; pip install -q " + AWSCLI + " && mkdir -p /w",
        failing_command="cd /w && aws sts get-caller-identity 2>&1",
        failed_approaches=(
            "cd /w && AWS_PROFILE=ci aws sts get-caller-identity 2>&1",
            "cd /w && AWS_REGION=us-east-1 aws sts get-caller-identity 2>&1",
        ),
        fix_command="export AWS_ACCESS_KEY_ID=placeholder AWS_SECRET_ACCESS_KEY=placeholder AWS_DEFAULT_REGION=us-east-1",
        verification_command="aws configure list | grep access_key | grep -q env && echo credentials-from-env",
        root_cause="The AWS CLI looks for credentials in a fixed order: command-line options, environment variables, the shared credentials and config files, then the instance metadata service. A profile name or a region does not supply keys, so with none of the sources set the CLI has nothing to sign the request with and stops before it contacts AWS.",
        steps=(
            "Provide the keys through the environment the job runs in (the CI secret store), or through a shared credentials file, and check the source with aws configure list.",
            "Setting AWS_PROFILE to a profile that does not exist fails differently ('config profile could not be found'); it does not add credentials.",
        ),
        tags=("aws", "aws-cli", "credentials", "ci", "configuration"),
        ecosystem="cloud-ci",
        written_by_model="claude-haiku-5-5",
        memory="1g",
    ),
    Task(
        task_id="aws-cli-region-not-specified",
        image="python:3.12-slim",
        runtime=PY312,
        category="configuration",
        error_type="You must specify a region",
        summary="The AWS CLI refuses a regional command with 'You must specify a region' when no default region is configured for the job.",
        context="A CI job runs aws ec2 describe-instances with credentials set but no region in the environment or the config file.",
        setup="apt-get update -qq >/dev/null 2>&1; pip install -q " + AWSCLI + " && mkdir -p /w",
        failing_command="cd /w && AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test aws ec2 describe-instances 2>&1",
        failed_approaches=(
            "cd /w && AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 aws ec2 describe-instances 2>&1",
            "cd /w && AWS_CONFIG_FILE=/nonexistent AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test aws ec2 describe-instances 2>&1",
        ),
        fix_command="export AWS_DEFAULT_REGION=us-east-1",
        verification_command="aws configure list | grep -q 'us-east-1' && echo region-set",
        root_cause="Regional endpoints cannot be chosen without a region, and the CLI does not guess one. AWS_REGION is read by the AWS CLI v2 and newer SDKs but not by the v1 CLI pinned here, so setting it does not help and the CLI still stops before sending a request. Pointing the CLI at a config file that does not exist changes nothing, because a missing config file just means no region.",
        steps=(
            "Set AWS_DEFAULT_REGION (or a region in the profile's config file) to the region the resources live in.",
            "If the CLI is the v1 release, use AWS_DEFAULT_REGION; AWS_REGION is only honoured by v2.",
        ),
        tags=("aws", "aws-cli", "region", "ci", "configuration"),
        ecosystem="cloud-ci",
        written_by_model="claude-haiku-5-5",
        memory="1g",
    ),
    Task(
        task_id="actionlint-runs-on-missing",
        image="python:3.12-slim",
        runtime=PY312,
        category="configuration",
        error_type="syntax-check",
        summary="actionlint rejects a GitHub Actions job that has no runs-on key, so the workflow check fails before anything is pushed to GitHub.",
        context="A workflow file was edited locally and a lint step in CI runs actionlint on .github/workflows before the jobs start.",
        setup="pip install -q " + ACTIONLINT + " && mkdir -p /w/.github/workflows && printf '" + WORKFLOW_NO_RUNS_ON + "' > /w/.github/workflows/ci.yml",
        failing_command="cd /w && actionlint .github/workflows/ci.yml 2>&1",
        failed_approaches=(
            "cd /w && actionlint -shellcheck= .github/workflows/ci.yml 2>&1",
            "cd /w && actionlint -ignore shellcheck .github/workflows/ci.yml 2>&1",
        ),
        fix_command="cd /w && printf '" + WORKFLOW_FIXED + "' > .github/workflows/ci.yml",
        verification_command="cd /w && actionlint .github/workflows/ci.yml && echo lint-ok",
        root_cause="Every job in a GitHub Actions workflow must say where it runs, with runs-on (or a reusable workflow call). A job without it is a syntax error for the Actions service too; the linter reports it as the syntax-check rule. Turning off the other checks does not touch this one.",
        steps=(
            "Add runs-on to the job, with a runner label GitHub provides, such as ubuntu-24.04.",
            "Run actionlint locally before pushing, so the CI lint step does not fail on the first run.",
        ),
        tags=("github-actions", "actionlint", "workflow", "ci", "configuration"),
        ecosystem="cloud-ci",
        written_by_model="claude-haiku-5-5",
    ),
    Task(
        task_id="actionlint-unknown-runner-label",
        image="python:3.12-slim",
        runtime=PY312,
        category="configuration",
        error_type="runner-label",
        summary="actionlint reports that a runs-on label is unknown, because the label is misspelled, so the GitHub Actions lint step fails on a workflow that looks correct.",
        context="A workflow sets runs-on to a label that was typed by hand, and the lint job runs actionlint before the workflow is pushed.",
        setup="pip install -q " + ACTIONLINT + " && mkdir -p /w/.github/workflows && printf '" + WORKFLOW_BAD_LABEL + "' > /w/.github/workflows/ci.yml",
        failing_command="cd /w && actionlint .github/workflows/ci.yml 2>&1",
        failed_approaches=(
            "cd /w && actionlint -shellcheck= .github/workflows/ci.yml 2>&1",
            "cd /w && actionlint -ignore shellcheck .github/workflows/ci.yml 2>&1",
        ),
        fix_command="cd /w && printf '" + WORKFLOW_FIXED.replace("ubuntu-24.04", "ubuntu-latest") + "' > .github/workflows/ci.yml",
        verification_command="cd /w && actionlint .github/workflows/ci.yml && echo lint-ok",
        root_cause="The runs-on label must be one GitHub provides or one the project declares for a self-hosted runner. 'ubuntu-latst' is neither, and actionlint checks the label against its list of known labels, reporting the rule as runner-label. The other lint checks do not change that result.",
        steps=(
            "Correct the label to a runner GitHub provides (ubuntu-latest, or a pinned one such as ubuntu-24.04).",
            "For a self-hosted runner, declare its labels in the actionlint configuration file (actionlint.yaml) instead of relaxing the check.",
        ),
        tags=("github-actions", "actionlint", "runner-label", "ci", "configuration"),
        ecosystem="cloud-ci",
        written_by_model="claude-haiku-5-5",
    ),
    Task(
        task_id="git-commit-identity-unknown",
        image="python:3.12-slim",
        runtime=GIT,
        category="configuration",
        error_type="identity unknown",
        summary="git commit fails in a CI container with 'Author identity unknown' because the job has no user.name or user.email configured and cannot detect an email address.",
        context="A CI job creates a commit, a tag or a generated-file commit, on a runner that has no git identity in its global configuration.",
        setup="apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq git >/dev/null 2>&1; mkdir -p /w && git -C /w init -q",
        failing_command="cd /w && git commit --allow-empty -m init 2>&1",
        failed_approaches=(
            "cd /w && git -c user.name=ci commit --allow-empty -m init 2>&1",
            "cd /w && GIT_AUTHOR_NAME=ci GIT_COMMITTER_NAME=ci git commit --allow-empty -m init 2>&1",
        ),
        fix_command="git config --global user.name ci && git config --global user.email ci",
        verification_command="cd /w && git commit --allow-empty -q -m init && git log --oneline",
        root_cause="git needs both a name and an email for every commit. Without user.name and user.email in the configuration, it tries to build the email from the host name and fails when that gives no usable domain. Passing only the name on the command line, or only the author variables, leaves the committer's email unset, so the commit still fails.",
        steps=(
            "Set user.name and user.email in the configuration the job uses (git config --global, or in the CI image), with an address the project accepts.",
            "Set the variables that match the commit: GIT_AUTHOR_* and GIT_COMMITTER_* both need a name and an email.",
        ),
        tags=("git", "ci", "identity", "commit", "configuration"),
        ecosystem="cloud-ci",
        written_by_model="claude-haiku-5-5",
    ),
)
