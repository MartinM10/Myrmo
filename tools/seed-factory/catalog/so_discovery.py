"""Tasks started from error names found by discovery in Stack Overflow (reference only).

The discovery list told us that these errors exist. Each task below is written from scratch, reproduced in a pinned
image, and verified by the factory: no text or command of the question or its answers is used.
"""

from .base import Task

GIT = {"name": "git", "version": "2.43.0"}
WRITER = "claude-haiku-5-5"

TASKS = (
    Task(
        "so-git-unrelated-histories", "ubuntu:24.04", GIT, "dependency", "refusing to merge unrelated histories",
        "Git refuses to merge two repositories whose histories share no commit, so a pull between them stops with refusing to merge unrelated histories.",
        "Pulling a repository that was created separately (a scaffold, an imported project) into one that already has commits.",
        "apt-get update -qq && apt-get install -y -qq git && mkdir -p /tmp/a /tmp/b && "
        "cd /tmp/a && git init -q -b main && git config user.email a@example.test && git config user.name a && echo one > f && git add f && git commit -qm one && "
        "cd /tmp/b && git init -q -b main && git config user.email b@example.test && git config user.name b && echo two > g && git add g && git commit -qm two",
        "cd /tmp/a && git pull --no-rebase --no-edit /tmp/b main 2>&1",
        ("cd /tmp/a && git fetch -q /tmp/b main && git merge --no-edit FETCH_HEAD 2>&1",
         "cd /tmp/a && git merge-base main $(git -C /tmp/b rev-parse main) 2>&1"),
        "cd /tmp/a && git pull --no-rebase --no-edit --allow-unrelated-histories /tmp/b main >/dev/null 2>&1 && git log --oneline | wc -l",
        "cd /tmp/a && git pull --no-rebase --no-edit --allow-unrelated-histories /tmp/b main >/dev/null 2>&1 && git log --oneline | wc -l",
        "Git only merges histories that share an ancestor. Two independently created repositories have none, and since Git 2.9 the merge refuses unless you say the histories are meant to be combined.",
        ("Confirm the two repositories really are meant to be one project before combining them.",
         "Pass --allow-unrelated-histories to the pull or merge that joins them, then resolve any conflicts it reports."),
        ("git", "merge", "unrelated-histories"),
        ecosystem="git", written_by_model=WRITER,
    ),
    Task(
        "so-git-push-checked-out-branch", "ubuntu:24.04", GIT, "configuration", "branch is currently checked out",
        "A push to a non-bare repository is rejected because the target branch is checked out there, with remote rejected and branch is currently checked out.",
        "Pushing commits from a clone to a repository that someone is working in directly, for example a deployment or shared checkout.",
        "apt-get update -qq && apt-get install -y -qq git && mkdir -p /tmp/srv /tmp/work && "
        "cd /tmp/srv && git init -q -b main && git config user.email s@example.test && git config user.name s && echo base > README && git add README && git commit -qm base && "
        "cd /tmp/work && git clone -q /tmp/srv w && cd w && git config user.email w@example.test && git config user.name w && echo change > y && git add y && git commit -qm change",
        "cd /tmp/work/w && git push origin HEAD:main 2>&1",
        ("cd /tmp/work/w && git push --force origin HEAD:main 2>&1",
         "cd /tmp/work/w && git push origin HEAD:main --no-verify 2>&1"),
        "git -C /tmp/srv config receive.denyCurrentBranch updateInstead && cd /tmp/work/w && git push origin HEAD:main 2>&1",
        "git -C /tmp/srv config --get receive.denyCurrentBranch && cd /tmp/work/w && git push origin HEAD:main >/dev/null 2>&1 && git -C /tmp/srv log --oneline | wc -l",
        "Git refuses to update the branch checked out in a non-bare repository, because the working tree would become out of sync with the branch. receive.denyCurrentBranch decides what the receiving repository does instead.",
        ("Push to a bare repository, which has no checked-out branch, when you can.",
         "If the receiving repository is a plain checkout that must follow pushes, set receive.denyCurrentBranch to updateInstead on it, and only if its working tree is clean."),
        ("git", "push", "checked-out-branch"),
        ecosystem="git", written_by_model=WRITER,
    ),
)
