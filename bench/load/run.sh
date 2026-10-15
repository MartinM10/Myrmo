#!/usr/bin/env bash
# Measure what one Myrmo colony node sustains on this machine, with one command.
#
#   ./bench/load/run.sh                    10,000 trails, 64 virtual users, 30 s per path
#   ./bench/load/run.sh --trails 100000    the size of the published runs (indexing takes longer)
#   ./bench/load/run.sh --vus 32 --seconds 60 --keep
#
# Needs Docker with Compose v2 and nothing else: the colony, the trail loader and k6 run in containers of their own
# project (myrmo-bench), publish no ports, and are removed at the end (--keep leaves them running). The first run
# builds the server and the embedding service, which takes several minutes; later runs reuse the images.
# Prints a summary to paste into a GitHub issue and keeps it in bench/results/load-<date>-<time>/.
set -euo pipefail

TRAILS=10000
VUS=64
PER_PATH=30
KEEP=0

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; }
number() { case "$2" in '' | *[!0-9]* | 0) echo "$1 needs a positive whole number" >&2; exit 2 ;; esac; }
while [ $# -gt 0 ]; do
  case "$1" in
    --trails) number "$1" "${2:-}"; TRAILS="$2"; shift 2 ;;
    --vus) number "$1" "${2:-}"; VUS="$2"; shift 2 ;;
    --seconds) number "$1" "${2:-}"; PER_PATH="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/../.."
step() { printf '\n==> %s\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker is not installed: https://docs.docker.com/get-docker/"
docker info >/dev/null 2>&1 || die "Docker is installed but not running (start Docker Desktop, or the docker service)"
docker compose version >/dev/null 2>&1 || die "this needs Docker Compose v2 (the 'docker compose' command)"

compose() { docker compose -f bench/load/compose.yml "$@"; }
gateway() { compose exec -T gateway curl -fsS "http://localhost:8080$1"; }
field() { sed -n "s/.*\"$1\":\([0-9]*\).*/\1/p"; }

# The machine, as its owner would describe it, and what Docker is allowed to use of it (Docker Desktop runs in a VM
# with its own CPU and memory limits, which bound the numbers more than the hardware does).
gib() { awk -v b="$1" 'BEGIN { printf "%.0f GiB", b / 1073741824 }'; }
case "$(uname -s)" in
  Darwin)
    os="macOS $(sw_vers -productVersion 2>/dev/null)"
    cpu="$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
    cores="$(sysctl -n hw.physicalcpu 2>/dev/null) cores, $(sysctl -n hw.logicalcpu 2>/dev/null) threads"
    ram="$(gib "$(sysctl -n hw.memsize 2>/dev/null)")"
    ;;
  Linux)
    os="$( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || echo Linux)"
    grep -qi microsoft /proc/version 2>/dev/null && os="$os on WSL2"
    cpu="$(sed -n 's/^model name[[:space:]]*: //p' /proc/cpuinfo | head -1)"
    [ -n "$cpu" ] || cpu="$(lscpu 2>/dev/null | sed -n 's/^Model name:[[:space:]]*//p' | head -1)"
    physical="$(lscpu -p=core,socket 2>/dev/null | grep -v '^#' | sort -u | wc -l | tr -d ' ')"
    cores="${physical:-?} cores, $(nproc) threads"
    ram="$(gib "$(($(awk '/MemTotal/ {print $2}' /proc/meminfo) * 1024))")"
    ;;
  MINGW* | MSYS* | CYGWIN*)
    os="Windows"
    cpu="$(powershell.exe -NoProfile -Command '(Get-CimInstance Win32_Processor).Name' 2>/dev/null | tr -d '\r')"
    cores="${NUMBER_OF_PROCESSORS:-?} threads"
    ram="?"
    ;;
  *) os="$(uname -s)"; cpu=""; cores="?"; ram="?" ;;
esac
IFS='|' read -r d_os d_cpus d_mem d_arch d_version <<<"$(docker info --format '{{.OperatingSystem}}|{{.NCPU}}|{{.MemTotal}}|{{.Architecture}}|{{.ServerVersion}}')"
export MYRMO_BENCH_MACHINE="${cpu:-unknown CPU} ($cores), $ram RAM, $os, $(uname -m)"
export MYRMO_BENCH_DOCKER="Docker $d_version on $d_os ($d_arch), $d_cpus CPUs and $(gib "$d_mem") available to containers"
version="$(sed -n 's/.*"server": *"\([^"]*\)".*/\1/p' .release-please-manifest.json)"
commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
git diff --quiet HEAD 2>/dev/null || commit="$commit with local changes"
export MYRMO_BENCH_COLONY="server $version (commit $commit), $(printf "%'d" "$TRAILS" 2>/dev/null || echo "$TRAILS") synthetic trails, embeddings on CPU (one embed container), enrichers paused during the run"
export MYRMO_BENCH_TRAILS="$TRAILS" MYRMO_BENCH_VUS="$VUS" MYRMO_BENCH_SECONDS="$PER_PATH"
export MYRMO_BENCH_OUT="$PWD/bench/results/load-$(date -u +%Y%m%d-%H%M%S)"
# k6 runs as its own user in its container: on Linux it can only write here if everyone can.
mkdir -p "$MYRMO_BENCH_OUT" && chmod 777 "$MYRMO_BENCH_OUT"

echo "Machine: $MYRMO_BENCH_MACHINE"
echo "Docker:  $MYRMO_BENCH_DOCKER"
echo "Run:     $TRAILS trails, $VUS virtual users, ${PER_PATH}s per path (about $((5 * (PER_PATH + 5) / 60 + 1)) min of load)"

if [ -n "$(compose ps -aq 2>/dev/null)" ]; then
  echo "A previous benchmark colony is still there; removing it."
  compose down -v --remove-orphans >/dev/null 2>&1
fi
cleanup() {
  if [ "$KEEP" = 1 ]; then
    printf '\nThe benchmark colony is still running. Remove it with: docker compose -f bench/load/compose.yml down -v\n'
  else
    compose --profile tools down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

step "1/5 Building and starting the colony (the first run builds the images: several minutes)"
compose up -d --build --quiet-pull gateway enricher
for _ in $(seq 1 150); do
  gateway /readyz >/dev/null 2>&1 && break
  sleep 2
done
gateway /readyz >/dev/null 2>&1 || die "the colony did not become ready; see: docker compose -f bench/load/compose.yml logs"

step "2/5 Publishing $TRAILS synthetic trails"
compose run --rm --quiet-pull populate

step "3/5 Waiting until every trail is indexed"
last=-1
stalled=0
while :; do
  depth="$(gateway /readyz | field queue_depth || true)"
  indexed="$(gateway /v1/stats | field trails || true)"
  printf '\r    indexed %s, waiting %s   ' "${indexed:-0}" "${depth:-?}"
  [ "${depth:-1}" = 0 ] && break
  if [ "${indexed:-0}" = "$last" ]; then stalled=$((stalled + 5)); else stalled=0; fi
  [ "$stalled" -lt 180 ] || die "indexing stopped making progress; see: docker compose -f bench/load/compose.yml logs enricher"
  last="${indexed:-0}"
  sleep 5
done
echo

step "4/5 Pausing the enrichers, so each path is measured alone"
compose stop enricher >/dev/null 2>&1

step "5/5 Running the load: one path at a time"
status=0
compose run --rm --quiet-pull loadtest || status=$?

[ -s "$MYRMO_BENCH_OUT/summary.md" ] || die "k6 wrote no summary (exit $status); the raw output is above"
echo
echo "------------------------------------------------------------------------------------------"
cat "$MYRMO_BENCH_OUT/summary.md"
echo "------------------------------------------------------------------------------------------"
[ "$status" = 0 ] || echo "Note: at least one path had more than 1% errors (k6 exit $status). The numbers above still stand, errors included."
echo "Saved in ${MYRMO_BENCH_OUT#"$PWD"/}/"
echo "Share it: https://github.com/MartinM10/Myrmo/issues/new?template=benchmark-result.yml (paste the block above)"
