from .probes import from_probe

DOCKER27 = {"name": "docker", "version": "27"}

TASKS = (
    from_probe(
        "docker-compose-env-file-missing", category="configuration", error_type="env file not found", runtime=DOCKER27,
        summary="Docker Compose 2.24 and later fail when a service lists an env_file that does not exist, instead of ignoring it as older versions did.",
        context="Running docker compose up on a checkout that has no .env file (it is git-ignored, or created by a setup step).",
        failing="cd /w && docker compose config 2>&1",
        failed_approaches=("cd /w && docker compose --env-file /dev/null config 2>&1", "cd /w && docker compose config --quiet 2>&1"),
        fix="cd /w && printf 'services:\\n  web:\\n    image: nginx\\n    env_file:\\n      - path: .env\\n        required: false\\n' > compose.yaml", verify="cd /w && docker compose config",
        root_cause="env_file is read by Compose itself, before containers start, and a missing file is now an error. The --env-file option and interpolation settings are about the project's .env, not about the files a service lists.",
        steps=("Create the file (touch .env), or", "mark it optional: env_file entries can be written as `- path: .env` with `required: false` (Compose 2.24 or later)."),
        tags=("docker", "compose", "env_file"), message="not found: stat",
    ),
    from_probe(
        "docker-compose-undefined-dependency", category="configuration", error_type="depends on undefined service", runtime=DOCKER27,
        summary="Docker Compose rejects a file in which a service depends_on a service that is not defined, with invalid compose project.",
        context="Running docker compose up on a file whose database service was removed, renamed or put behind a profile.",
        failing="cd /w && docker compose config 2>&1",
        failed_approaches=("cd /w && docker compose --profile db config 2>&1", "cd /w && docker compose config --no-normalize 2>&1"),
        fix="cd /w && printf 'services:\\n  web:\\n    image: nginx\\n    depends_on: [db]\\n  db:\\n    image: postgres:16\\n' > compose.yaml", verify="cd /w && docker compose config",
        root_cause="Every name in depends_on must be a service of the project. A service that exists only under a profile is not defined unless that profile is enabled, and a renamed service leaves the old name dangling.",
        steps=("Define the service, or correct the name in depends_on.", "If the dependency lives under a profile, enable it (--profile) or put the dependent service in the same profile."),
        tags=("docker", "compose", "depends_on"), message="depends on undefined service",
    ),
    from_probe(
        "k8s-helm-cluster-unreachable", category="configuration", error_type="Kubernetes cluster unreachable", runtime={"name": "helm", "version": "3.16"}, memory="1g",
        summary="helm install fails with Kubernetes cluster unreachable and a connection refused on localhost:8080 when no kubeconfig points helm at a cluster.",
        context="Running helm in a container or CI job that has no kubeconfig, or whose KUBECONFIG path is wrong.",
        failed_approaches=("helm install x /tmp/c --dry-run 2>&1", "helm install x /tmp/c --kubeconfig /nonexistent 2>&1"),
        fix="helm template x /tmp/c > /tmp/rendered.yaml", verify="grep -q 'kind: Deployment' /tmp/rendered.yaml",
        root_cause="helm talks to the cluster described by the kubeconfig (KUBECONFIG, or ~/.kube/config). With none it falls back to localhost:8080, where nothing listens. Even --dry-run installs contact the cluster to read its API versions.",
        steps=("Point helm at a cluster: set KUBECONFIG, or pass --kubeconfig and --kube-context.", "If you only need the manifests, helm template renders them without a cluster (add --validate if you do want the API checked)."),
        tags=("helm", "kubernetes", "kubeconfig"), message="cluster unreachable",
    ),
)
