"""Kubernetes manifest, Helm chart and Kustomize errors that reproduce offline, with no cluster.

Every command here runs in a pinned image. The Helm and Kustomize binaries are downloaded (pinned versions) in the setup,
and the setup is silenced: a failing download aborts the task instead of becoming its error. The failing commands only
render, lint or parse manifests; none of them talks to an API server. The fixes change manifests, chart files or
kustomization files, never application code.
"""

from .base import Task

PYTHON = {"name": "python", "version": "3.12"}
HELM = {"name": "helm", "version": "3.16.2"}
KUSTOMIZE = {"name": "kustomize", "version": "5.4.3"}
IMAGE = "python:3.12-slim-bookworm"

CURL = "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl ca-certificates >/dev/null 2>&1"
HELM_TOOL = (
    CURL + " && curl -fsSL https://get.helm.sh/helm-v3.16.2-linux-amd64.tar.gz | tar xz -C /tmp"
    " && mv /tmp/linux-amd64/helm /usr/local/bin/helm"
)
KUSTOMIZE_TOOL = (
    CURL + " && curl -fsSL https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv5.4.3/"
    "kustomize_v5.4.3_linux_amd64.tar.gz | tar xz -C /usr/local/bin kustomize"
)


def write(path: str, text: str) -> str:
    """A shell step that writes `text` to `path` (directory created first)."""
    directory = path.rsplit("/", 1)[0]
    return f"mkdir -p {directory} && cat > {path} <<'SEED_EOF'\n{text}SEED_EOF"


DEPLOYMENT = """apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app: web
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27
"""

CHART_TEMPLATE = """apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app: web
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: {{ .Values.image.repository }}:{{ .Values.image.tag }}
"""


def chart(chart_yaml: str, values: str, template: str, helpers: str = "") -> str:
    steps = [write("/tmp/app/chart/Chart.yaml", chart_yaml), write("/tmp/app/chart/values.yaml", values),
             write("/tmp/app/chart/templates/deployment.yaml", template)]
    if helpers:
        steps.append(write("/tmp/app/chart/templates/_helpers.tpl", helpers))
    return "\n".join(steps)


TASKS = (
    Task(
        task_id="k8s-helm-chart-missing-version",
        image=IMAGE,
        runtime=HELM,
        category="configuration",
        error_type="chart.metadata.version is required",
        summary="helm lint fails with validation: chart.metadata.version is required when Chart.yaml has no version field.",
        context="Linting or packaging a chart copied from a template that defines only name and description.",
        setup=HELM_TOOL + "\n" + chart(
            "apiVersion: v2\nname: web\ndescription: demo chart\n",
            "image:\n  repository: nginx\n  tag: \"1.27\"\n",
            CHART_TEMPLATE,
        ),
        failing_command="helm lint /tmp/app/chart 2>&1",
        failed_approaches=("helm template web /tmp/app/chart 2>&1", "helm lint --strict /tmp/app/chart 2>&1"),
        fix_command=write("/tmp/app/chart/Chart.yaml", "apiVersion: v2\nname: web\nversion: 0.1.0\ndescription: demo chart\n"),
        verification_command="helm lint /tmp/app/chart",
        root_cause="Helm requires every chart to declare its own version in Chart.yaml; a missing version is a metadata error, and template rendering never runs until the metadata validates.",
        steps=(
            "Add a version field to Chart.yaml that follows SemVer 2 (for example 0.1.0).",
            "Run helm lint on the chart again and confirm it exits zero.",
        ),
        tags=("helm", "kubernetes", "chart", "chart-yaml"),
        ecosystem="kubernetes",
        written_by_model="claude-haiku-5-5",
    ),
    Task(
        task_id="k8s-helm-chart-missing-apiversion",
        image=IMAGE,
        runtime=HELM,
        category="configuration",
        error_type="chart.metadata.apiVersion is required",
        summary="helm lint fails with validation: chart.metadata.apiVersion is required when Chart.yaml omits apiVersion.",
        context="Reusing a Chart.yaml written for an older chart layout that did not set apiVersion.",
        setup=HELM_TOOL + "\n" + chart(
            "name: web\nversion: 0.1.0\ndescription: demo chart\n",
            "image:\n  repository: nginx\n  tag: \"1.27\"\n",
            CHART_TEMPLATE,
        ),
        failing_command="helm lint /tmp/app/chart 2>&1",
        failed_approaches=("helm lint --strict /tmp/app/chart 2>&1", "helm lint --quiet /tmp/app/chart 2>&1"),
        fix_command=write("/tmp/app/chart/Chart.yaml", "apiVersion: v2\nname: web\nversion: 0.1.0\ndescription: demo chart\n"),
        verification_command="helm lint /tmp/app/chart",
        root_cause="Chart.yaml must declare apiVersion: v2 for Helm 3 charts. Without it Helm cannot tell which chart format it is reading, and validation stops before templates are rendered.",
        steps=(
            "Add apiVersion: v2 as the first field of Chart.yaml.",
            "Lint the chart again and check that it exits zero.",
        ),
        tags=("helm", "kubernetes", "chart", "apiversion"),
        ecosystem="kubernetes",
        written_by_model="claude-haiku-5-5",
    ),
    Task(
        task_id="k8s-helm-values-key-required",
        image=IMAGE,
        runtime=HELM,
        category="configuration",
        error_type="image.tag is required",
        summary="helm template fails with execution error: image.tag is required because values.yaml names the key version, not tag.",
        context="A chart whose values file was renamed to version while the template still requires the tag key.",
        setup=HELM_TOOL + "\n" + chart(
            "apiVersion: v2\nname: web\nversion: 0.1.0\ndescription: demo chart\n",
            "image:\n  repository: nginx\n  version: \"1.27\"\n",
            CHART_TEMPLATE.replace(
                "{{ .Values.image.tag }}", "{{ required \"image.tag is required\" .Values.image.tag }}"
            ),
        ),
        failing_command="helm template web /tmp/app/chart 2>&1",
        failed_approaches=("helm template web /tmp/app/chart --set image.tag= 2>&1",
                           "helm template web /tmp/app/chart --set image.version=1.27 2>&1"),
        fix_command=write("/tmp/app/chart/values.yaml", "image:\n  repository: nginx\n  tag: \"1.27\"\n"),
        verification_command="helm template web /tmp/app/chart | grep -q 'image: nginx:1.27'",
        root_cause="The template requires image.tag. The values file provides image.version, so the key the template reads is absent. Setting the value on the command line with a different key does not change the chart's own values.",
        steps=(
            "Rename the key in values.yaml to the name the template reads (image.tag), or change the template to read image.version.",
            "Render the chart with helm template and check the image reference.",
        ),
        tags=("helm", "kubernetes", "values", "required"),
        ecosystem="kubernetes",
        written_by_model="claude-haiku-5-5",
    ),
    Task(
        task_id="k8s-helm-values-yaml-indent",
        image=IMAGE,
        runtime=HELM,
        category="configuration",
        error_type="error converting YAML to JSON",
        summary="helm template fails with error converting YAML to JSON because a nested key in values.yaml is indented unevenly.",
        context="Editing values.yaml by hand so that the tag key is indented by three spaces under image.",
        setup=HELM_TOOL + "\n" + chart(
            "apiVersion: v2\nname: web\nversion: 0.1.0\ndescription: demo chart\n",
            "image:\n  repository: nginx\n   tag: \"1.27\"\n",
            CHART_TEMPLATE,
        ),
        failing_command="helm template web /tmp/app/chart 2>&1",
        failed_approaches=("helm lint /tmp/app/chart 2>&1", "helm template web /tmp/app/chart --set image.tag=1.27 2>&1"),
        fix_command=write("/tmp/app/chart/values.yaml", "image:\n  repository: nginx\n  tag: \"1.27\"\n"),
        verification_command="helm template web /tmp/app/chart | grep -q 'image: nginx:1.27'",
        root_cause="In YAML, sibling keys share an indentation level. A key indented deeper than its sibling is parsed as a continuation of the previous value, so the file is no longer valid YAML and Helm cannot read it. Passing --set does not bypass the parse of values.yaml.",
        steps=(
            "Align repository and tag at the same indentation (two spaces under image).",
            "Render the chart and check that the image reference is correct.",
        ),
        tags=("helm", "kubernetes", "values", "yaml", "indentation"),
        ecosystem="kubernetes",
        written_by_model="claude-haiku-5-5",
    ),
    Task(
        task_id="k8s-helm-template-undefined-include",
        image=IMAGE,
        runtime=HELM,
        category="configuration",
        error_type="no template associated",
        summary="helm template fails because a template includes web.labels, but the helpers file defines the template as web.labelset.",
        context="Renaming a named template in _helpers.tpl without updating the include in deployment.yaml.",
        setup=HELM_TOOL + "\n" + chart(
            "apiVersion: v2\nname: web\nversion: 0.1.0\ndescription: demo chart\n",
            "image:\n  repository: nginx\n  tag: \"1.27\"\n",
            CHART_TEMPLATE.replace("  labels:\n    app: web\nspec", "  labels:\n    {{- include \"web.labels\" . | nindent 4 }}\nspec"),
            helpers="{{- define \"web.labelset\" -}}\napp: web\n{{- end -}}\n",
        ),
        failing_command="helm template web /tmp/app/chart 2>&1",
        failed_approaches=("helm template web /tmp/app/chart --debug 2>&1", "helm lint /tmp/app/chart 2>&1"),
        fix_command="sed -i 's/\"web.labels\"/\"web.labelset\"/' /tmp/app/chart/templates/deployment.yaml",
        verification_command="helm template web /tmp/app/chart | grep -q 'app: web'",
        root_cause="include can only call a named template that is defined somewhere in the chart. The name in the include and the name in define must match exactly; the error is in the chart's template names, not in the application.",
        steps=(
            "Use the defined name (web.labelset) in the include in deployment.yaml, or rename the define to web.labels.",
            "Render the chart and confirm the labels are included.",
        ),
        tags=("helm", "kubernetes", "templates", "include"),
        ecosystem="kubernetes",
        written_by_model="claude-haiku-5-5",
    ),
    Task(
        task_id="k8s-kustomize-missing-resource",
        image=IMAGE,
        runtime=KUSTOMIZE,
        category="configuration",
        error_type="accumulating resources",
        summary="kustomize build fails with accumulating resources: lstat no such file or directory because the kustomization names deployment.yml.",
        context="A base directory whose kustomization.yaml names a manifest file with a different extension than the file on disk.",
        setup=KUSTOMIZE_TOOL + "\n" + write("/tmp/app/base/deployment.yaml", DEPLOYMENT)
        + "\n" + write("/tmp/app/base/kustomization.yaml", "resources:\n- deployment.yml\n"),
        failing_command="kustomize build /tmp/app/base 2>&1",
        failed_approaches=("kustomize build /tmp/app/base/deployment.yaml 2>&1",
                           "kustomize build --load-restrictor LoadRestrictionsNone /tmp/app/base 2>&1"),
        fix_command="sed -i 's/deployment\\.yml$/deployment.yaml/' /tmp/app/base/kustomization.yaml",
        verification_command="kustomize build /tmp/app/base | grep -q 'kind: Deployment'",
        root_cause="Kustomize reads each entry of resources from disk when it builds. The name in kustomization.yaml does not match the file, so the accumulation step fails before any manifest is merged.",
        steps=(
            "Correct the resource name in kustomization.yaml to the manifest that exists (deployment.yaml).",
            "Build the directory and check that the Deployment is in the output.",
        ),
        tags=("kustomize", "kubernetes", "resources"),
        ecosystem="kubernetes",
        written_by_model="claude-haiku-5-5",
    ),
    Task(
        task_id="k8s-kustomize-duplicate-key",
        image=IMAGE,
        runtime=KUSTOMIZE,
        category="configuration",
        error_type="already defined",
        summary="kustomize build fails with mapping key replicas already defined because a manifest sets replicas twice.",
        context="A Deployment manifest edited by two people, each adding a replicas line in a different place.",
        setup=KUSTOMIZE_TOOL + "\n" + write(
            "/tmp/app/base/deployment.yaml",
            DEPLOYMENT.replace("  replicas: 1\n", "  replicas: 1\n  replicas: 3\n"),
        ) + "\n" + write("/tmp/app/base/kustomization.yaml", "resources:\n- deployment.yaml\n"),
        failing_command="kustomize build /tmp/app/base 2>&1",
        failed_approaches=("kustomize build /tmp/app/base/deployment.yaml 2>&1",
                           "kustomize build /tmp/app/base --enable-alpha-plugins 2>&1"),
        fix_command=write("/tmp/app/base/deployment.yaml", DEPLOYMENT.replace("  replicas: 1\n", "  replicas: 3\n")),
        verification_command="kustomize build /tmp/app/base | grep -q 'replicas: 3'",
        root_cause="YAML mappings cannot repeat a key; the parser rejects the second replicas entry rather than choosing one. Only one replicas value should remain in the Deployment spec.",
        steps=(
            "Remove the duplicate replicas line and keep the value that is intended.",
            "Build the kustomization and confirm the replica count in the output.",
        ),
        tags=("kustomize", "kubernetes", "yaml", "duplicate-key"),
        ecosystem="kubernetes",
        written_by_model="claude-haiku-5-5",
    ),
    Task(
        task_id="k8s-kustomize-unknown-field",
        image=IMAGE,
        runtime=KUSTOMIZE,
        category="configuration",
        error_type="unknown field",
        summary="kustomize build fails with json: unknown field resource because a kustomization.yaml misspells resources as resource.",
        context="A kustomization.yaml typed by hand with the singular form of the resources key.",
        setup=KUSTOMIZE_TOOL + "\n" + write("/tmp/app/base/deployment.yaml", DEPLOYMENT)
        + "\n" + write("/tmp/app/base/kustomization.yaml", "resource:\n- deployment.yaml\n"),
        failing_command="kustomize build /tmp/app/base 2>&1",
        failed_approaches=("kustomize build /tmp/app/base/deployment.yaml 2>&1",
                           "kustomize build --load-restrictor LoadRestrictionsNone /tmp/app/base 2>&1"),
        fix_command="sed -i 's/^resource:/resources:/' /tmp/app/base/kustomization.yaml",
        verification_command="kustomize build /tmp/app/base | grep -q 'kind: Deployment'",
        root_cause="Kustomize decodes kustomization.yaml strictly. A field that is not part of the schema, such as resource instead of resources, is an error and is never ignored, so the build stops.",
        steps=(
            "Rename the key to resources in kustomization.yaml.",
            "Build the directory and confirm the Deployment appears in the output.",
        ),
        tags=("kustomize", "kubernetes", "kustomization", "yaml"),
        ecosystem="kubernetes",
        written_by_model="claude-haiku-5-5",
    ),
    Task(
        task_id="k8s-kustomize-duplicate-resource",
        image=IMAGE,
        runtime=KUSTOMIZE,
        category="configuration",
        error_type="already registered id",
        summary="kustomize build fails with may not add resource with an already registered id because two listed files define the same Deployment.",
        context="A base that lists a copied manifest next to the original, so the same Deployment name is added twice.",
        setup=KUSTOMIZE_TOOL + "\n" + write("/tmp/app/base/deployment.yaml", DEPLOYMENT)
        + "\n" + write("/tmp/app/base/deployment-copy.yaml", DEPLOYMENT)
        + "\n" + write("/tmp/app/base/kustomization.yaml", "resources:\n- deployment.yaml\n- deployment-copy.yaml\n"),
        failing_command="kustomize build /tmp/app/base 2>&1",
        failed_approaches=("kustomize build /tmp/app/base/deployment-copy.yaml 2>&1",
                           "kustomize build --load-restrictor LoadRestrictionsNone /tmp/app/base 2>&1"),
        fix_command="sed -i '/deployment-copy.yaml/d' /tmp/app/base/kustomization.yaml",
        verification_command="kustomize build /tmp/app/base | grep -q 'kind: Deployment'",
        root_cause="Each resource in a kustomization has an identity made of group, kind, namespace and name. Two entries with the same identity cannot be merged, so the copy must be removed from resources rather than renamed in the output.",
        steps=(
            "Remove the duplicate file from the resources list.",
            "Build the directory and confirm one Deployment is in the output.",
        ),
        tags=("kustomize", "kubernetes", "resources", "duplicate"),
        ecosystem="kubernetes",
        written_by_model="claude-haiku-5-5",
    ),
    Task(
        task_id="k8s-helm-template-unknown-function",
        image=IMAGE,
        runtime=HELM,
        category="configuration",
        error_type="function not defined",
        summary="helm template fails with parse error: function toYMAL not defined because a chart template misspells the toYaml function.",
        context="A chart template edited by hand where the pipeline function name was typed in capitals with letters swapped.",
        setup=HELM_TOOL + "\n" + chart(
            "apiVersion: v2\nname: web\nversion: 0.1.0\ndescription: demo chart\n",
            "image:\n  repository: nginx\n  tag: \"1.27\"\npullPolicy: IfNotPresent\n",
            CHART_TEMPLATE.replace(
                "          image: {{ .Values.image.repository }}:{{ .Values.image.tag }}\n",
                "          image: {{ .Values.image.repository }}:{{ .Values.image.tag }}\n"
                "          imagePullPolicy: {{ toYMAL .Values.pullPolicy }}\n",
            ),
        ),
        failing_command="helm template web /tmp/app/chart 2>&1",
        failed_approaches=("helm lint /tmp/app/chart 2>&1", "helm template web /tmp/app/chart --set pullPolicy=Always 2>&1"),
        fix_command="sed -i 's/toYMAL/toYaml/' /tmp/app/chart/templates/deployment.yaml",
        verification_command="helm template web /tmp/app/chart | grep -q 'imagePullPolicy: IfNotPresent'",
        root_cause="Go templates resolve function names when the template is parsed. An unknown name such as toYMAL is a parse error for the whole file, whatever the values are; the built-in Helm function is toYaml.",
        steps=(
            "Replace toYMAL with the Helm function toYaml in the template.",
            "Render the chart and confirm the pull policy is in the output.",
        ),
        tags=("helm", "kubernetes", "templates", "functions"),
        ecosystem="kubernetes",
        written_by_model="claude-haiku-5-5",
    ),
    Task(
        task_id="k8s-helm-values-schema-type",
        image=IMAGE,
        runtime=HELM,
        category="configuration",
        error_type="values don't meet the specifications",
        summary="helm template fails because values.yaml sets replicaCount as a string while values.schema.json requires an integer.",
        context="A values file that quotes a number, which the chart's values schema rejects as a string.",
        setup=HELM_TOOL + "\n" + chart(
            "apiVersion: v2\nname: web\nversion: 0.1.0\ndescription: demo chart\n",
            "replicaCount: \"2\"\nimage:\n  repository: nginx\n  tag: \"1.27\"\n",
            CHART_TEMPLATE.replace("replicas: 1", "replicas: {{ .Values.replicaCount }}"),
        ) + "\n" + write(
            "/tmp/app/chart/values.schema.json",
            '{"$schema": "https://json-schema.org/draft-07/schema#", "type": "object", "properties": '
            '{"replicaCount": {"type": "integer", "minimum": 1}}}\n',
        ),
        failing_command="helm template web /tmp/app/chart 2>&1",
        failed_approaches=("helm template web /tmp/app/chart --set-string replicaCount=2 2>&1",
                           "helm lint /tmp/app/chart --strict 2>&1"),
        fix_command="sed -i 's/replicaCount: \"2\"/replicaCount: 2/' /tmp/app/chart/values.yaml",
        verification_command="helm template web /tmp/app/chart | grep -q 'replicas: 2'",
        root_cause="Helm validates the merged values against values.schema.json before rendering. A quoted number is a string in YAML, so it fails the integer type; the value itself must be written as a number in the values file.",
        steps=(
            "Write replicaCount as an unquoted integer in values.yaml.",
            "Render the chart and check the replica count in the output.",
        ),
        tags=("helm", "kubernetes", "values", "schema"),
        ecosystem="kubernetes",
        written_by_model="claude-haiku-5-5",
    ),
    Task(
        task_id="k8s-yaml-tab-indentation",
        image=IMAGE,
        runtime=PYTHON,
        category="data",
        error_type="found character that cannot start any token",
        summary="PyYAML rejects a Kubernetes manifest because a line is indented with a tab character, which YAML does not allow.",
        context="A manifest edited in an editor that inserts tabs, then parsed by a validation step written in Python.",
        setup="python -m pip install -q PyYAML==6.0.2\n" + write(
            "/tmp/app/deploy.yaml",
            DEPLOYMENT.replace("  replicas: 1\n", "\treplicas: 1\n"),
        ),
        failing_command="python -c \"import yaml; yaml.safe_load(open('/tmp/app/deploy.yaml'))\" 2>&1",
        failed_approaches=("python -m json.tool /tmp/app/deploy.yaml 2>&1",
                           "python -c \"import yaml; yaml.safe_load(open('/tmp/app/deploy.yaml'))\" 2>&1 | grep -c tab"),
        fix_command="sed -i 's/\\t/  /g' /tmp/app/deploy.yaml",
        verification_command="python -c \"import yaml; d = yaml.safe_load(open('/tmp/app/deploy.yaml')); print(d['spec']['replicas'])\"",
        root_cause="YAML uses spaces for indentation and forbids tab characters there; a tab at the start of a line cannot begin a token. The parser reports the tab, so the file must be re-indented with spaces.",
        steps=(
            "Replace the tab characters in the manifest with two spaces per indentation level.",
            "Parse the manifest again and read a field from it to confirm it loads.",
        ),
        tags=("yaml", "kubernetes", "indentation", "tabs"),
        ecosystem="kubernetes",
        written_by_model="claude-haiku-5-5",
    ),
)
