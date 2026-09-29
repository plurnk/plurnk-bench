# Terminal-Bench and FrontierHarness

[run.sh](run.sh) connects Harbor to the Plurnk agent driver. It passes Harbor's
arguments through unchanged; task selection, images, and grading remain Harbor's
responsibility.

Run commands from the repository root after the [shared setup](../README.md#setup).
Install Harbor, have Docker running, and download the desired task dataset.
Declare the model alias in Plurnk's configuration and supply its provider
credentials through the invoking environment.

## One task

```sh
terminal_bench/run.sh -p /path/to/task -m your-model-alias
```

The driver installs and starts the daemon and client inside the task environment.
To select exact publications, pass `--agent-kwarg service_version=<version>` and
`--agent-kwarg client_version=<version>`.

## FrontierHarness selection

[frontier.manifest.json](frontier.manifest.json) records the task selection and
its sources. Populate its Terminal-Bench and DeepSWE task caches before planning:

```sh
harbor dataset download terminal-bench/terminal-bench-2-1 -o .cache/terminal-bench-2-1
terminal_bench/frontier.sh --preflight
PLURNK_MODEL="your-model-alias" terminal_bench/frontier.sh
```

See [DeepSWE setup](../deepswe/README.md#prerequisites) for its task cache.
Here `--preflight` prints the plan; it does not run an installation or a model.
Optional task names restrict the selection. `PLURNK_BENCH_JOBS` controls parallel
tasks. The runner resolves service/client versions once and records them with the
manifest and launch settings; explicit `PLURNK_BENCH_SERVICE_VERSION` and
`PLURNK_BENCH_CLIENT_VERSION` override that selection.

```sh
node terminal_bench/frontier.mjs summary /path/to/run
```

The summary separates grades from setup, cancellation, and execution outcomes.
Missing rewards are not failed tasks; a passing reward does not hide a teardown error.

## Diagnose without inference

Harbor retains installation output at `<trial>/agent/setup/install.log`.
Pass `--install-only` through `run.sh` to check setup with the same task and
package versions. Installation success alone does not prove agent-phase connectivity.

For a task with public setup access and a `no-network` agent policy, run the
deterministic network probe using Harbor's Python environment:

```sh
python -m terminal_bench.network_probe /path/to/task <provider-https-url> <unrelated-https-url> \
  --service-version <version> --client-version <version>
```

It checks provider access, unrelated-host denial, and restoration of the baseline
using unauthenticated HTTPS, with no model or verifier call. See
[SPEC.md](../SPEC.md#frontier-egress-probe-restricted-inference-connectivity).
