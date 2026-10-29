"""Run the official SWE-bench evaluator offline with airgapped containers and local httpbin ({§swebench-evaluator})."""

from argparse import ArgumentDefaultsHelpFormatter, ArgumentParser
import os
from pathlib import Path
import sys

START_TEST_OUTPUT = ">>>>> Start Test Output"

LOCAL_HTTPBIN_SERVER = r"""
import base64, gzip, hashlib, http.server, json, re, socketserver, ssl, threading, time
from urllib.parse import parse_qsl, urlparse

REALM = "me@kennethreitz.com"
NONCE = "dcd98b7102dd2f0e8b11d0f600bfb0c093"
OPAQUE = "5ccc069c403ebaf9f0171e9517f40e41"

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def _handle(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 0:
            self.rfile.read(length)
        parsed = urlparse(self.path)
        path = parsed.path
        qsl = parse_qsl(parsed.query, keep_blank_values=True)
        args = {}
        for k, v in qsl:
            if k in args:
                args[k] = [args[k], v] if not isinstance(args[k], list) else args[k] + [v]
            else:
                args[k] = v
        headers = {k: v for k, v in self.headers.items()}
        scheme = "https" if isinstance(self.connection, ssl.SSLSocket) else "http"
        host = self.headers.get("Host", "httpbin.org")
        full_url = f"{scheme}://{host}{self.path}"

        if path.startswith("/status/"):
            code = int(path.split("/")[2])
            self.send_response(code)
            if code in (301, 302, 303, 307):
                self.send_header("Location", "/redirect/1")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path.startswith("/redirect/"):
            n = int(path.split("/")[2])
            loc = "/get" if n <= 1 else f"/redirect/{n - 1}"
            self.send_response(302)
            self.send_header("Location", loc)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/redirect-to":
            self.send_response(302)
            self.send_header("Location", dict(qsl).get("url", "/get"))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path.startswith("/cookies/set"):
            self.send_response(302)
            for k, v in qsl:
                self.send_header("Set-Cookie", f"{k}={v}; Path=/")
            self.send_header("Location", "/cookies")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/cookies":
            cookies = {}
            for item in (self.headers.get("Cookie") or "").split(";"):
                if "=" in item:
                    k, v = item.strip().split("=", 1)
                    cookies[k] = v
            self._json(200, {"cookies": cookies})
            return
        if path == "/response-headers":
            self._json(200, dict(qsl), extra_headers=qsl)
            return
        if path.startswith("/basic-auth/"):
            _, _, user, passwd = path.split("/", 3)
            expected = "Basic " + base64.b64encode(f"{user}:{passwd}".encode()).decode()
            if self.headers.get("Authorization") == expected:
                self._json(200, {"authenticated": True, "user": user})
            else:
                self.send_response(401)
                self.send_header("WWW-Authenticate", 'Basic realm="Fake Realm"')
                self.send_header("Content-Length", "0")
                self.end_headers()
            return
        if path.startswith("/digest-auth/"):
            _, _, qop, user, passwd = path.split("/", 4)
            auth = self.headers.get("Authorization") or ""
            if auth.startswith("Digest "):
                fields = dict(re.findall(r'(\w+)=["]?([^",]+)["]?', auth[7:]))
                ha1 = hashlib.md5(f"{user}:{REALM}:{passwd}".encode()).hexdigest()
                ha2 = hashlib.md5(f"{self.command}:{fields.get('uri', self.path)}".encode()).hexdigest()
                resp = hashlib.md5(f"{ha1}:{NONCE}:{fields.get('nc','')}:{fields.get('cnonce','')}:{fields.get('qop',qop)}:{ha2}".encode()).hexdigest()
                if fields.get("username") == user and fields.get("response") == resp:
                    self._json(200, {"authenticated": True, "user": user})
                    return
            self.send_response(401)
            self.send_header("Set-Cookie", "fake=fake_value; Path=/")
            self.send_header("WWW-Authenticate", f'Digest realm="{REALM}", nonce="{NONCE}", qop="{qop}", opaque="{OPAQUE}"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/gzip":
            body = gzip.compress(json.dumps({"gzipped": True, "headers": headers}).encode())
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
            return
        if path.startswith("/delay/"):
            time.sleep(min(float(path.split("/")[2]), 6.0))
        self._json(200, {"args": args, "headers": headers, "url": full_url, "user-agent": headers.get("User-Agent", "")})

    def _json(self, code, payload, extra_headers=()):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        for k, v in extra_headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = do_OPTIONS = do_PATCH = _handle

http_srv = ThreadedHTTPServer(("127.0.0.1", 80), Handler)
https_srv = ThreadedHTTPServer(("127.0.0.1", 443), Handler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain("/tmp/swebench_httpbin.crt", "/tmp/swebench_httpbin.key")
https_srv.socket = ctx.wrap_socket(https_srv.socket, server_side=True)
threading.Thread(target=http_srv.serve_forever, daemon=True).start()
threading.Thread(target=https_srv.serve_forever, daemon=True).start()
time.sleep(3600)
""".strip()

CA_REFRESH_CMDS = (
    "_swebench_restore_cacert=0",
    "if [ -f requests/cacert.pem ] && git -c core.fileMode=false diff --quiet -- requests/cacert.pem; then",
    '    grep -q "httpbin.org" /etc/hosts || echo "127.0.0.1 httpbin.org" >> /etc/hosts',
    '    openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/swebench_httpbin.key -out /tmp/swebench_httpbin.crt -days 1 -subj "/CN=httpbin.org" 2>/dev/null',
    "    cp /tmp/swebench_httpbin.crt requests/cacert.pem",
    "    cat <<'SWEBENCH_HTTPBIN_EOF' > /tmp/swebench_httpbin.py",
    LOCAL_HTTPBIN_SERVER,
    "SWEBENCH_HTTPBIN_EOF",
    "    python /tmp/swebench_httpbin.py >/dev/null 2>&1 &",
    "    _swebench_httpbin_pid=$!",
    "    sleep 0.2",
    "    _swebench_restore_cacert=1",
    "fi",
)

CA_RESTORE_CMDS = (
    'if [ "${_swebench_restore_cacert:-0}" = 1 ]; then',
    '    kill "${_swebench_httpbin_pid:-}" 2>/dev/null || true',
    "    git checkout -- requests/cacert.pem",
    "fi",
)


def inject_eval_fixes(
    eval_script: str,
    restore_cmds: list[str] | None = None,
    start_marker: str = START_TEST_OUTPUT,
) -> str:
    """Insert asset-restore and airgapped local-httpbin guards around the test-output block."""
    before = [*(restore_cmds or []), *CA_REFRESH_CMDS]
    trailing_newline = eval_script.endswith("\n")
    lines = eval_script.rstrip("\n").split("\n") if eval_script else []
    for idx, line in enumerate(lines):
        if start_marker in line:
            rebuilt = "\n".join([*lines[:idx], *before, *lines[idx:], *CA_RESTORE_CMDS])
            return f"{rebuilt}\n" if trailing_newline else rebuilt
    rebuilt = "\n".join([*lines, *before, *CA_RESTORE_CMDS])
    return f"{rebuilt}\n" if trailing_newline else rebuilt


def install_harness_fixes(run_evaluation_mod, container_collection_cls) -> None:
    """Guard Docker container listing/creation and run grading containers offline."""
    original_list = container_collection_cls.list
    if not getattr(original_list, "_swebench_ignore_removed", False):
        def list_ignoring_removed(self, *args, **kwargs):
            kwargs.setdefault("ignore_removed", True)
            return original_list(self, *args, **kwargs)

        list_ignoring_removed._swebench_ignore_removed = True
        container_collection_cls.list = list_ignoring_removed

    original_create = getattr(container_collection_cls, "create", None)
    if original_create is not None and not getattr(original_create, "_swebench_airgapped", False):
        def create_airgapped(self, *args, **kwargs):
            if "network_mode" not in kwargs:
                kwargs.setdefault("network_disabled", True)
            return original_create(self, *args, **kwargs)

        create_airgapped._swebench_airgapped = True
        container_collection_cls.create = create_airgapped

    start_marker = getattr(run_evaluation_mod, "START_TEST_OUTPUT", START_TEST_OUTPUT)

    def _inject_asset_restore(eval_script: str, restore_cmds: list[str]) -> str:
        return inject_eval_fixes(eval_script, restore_cmds, start_marker=start_marker)

    run_evaluation_mod._inject_asset_restore = _inject_asset_restore


def main(argv: list[str] | None = None) -> None:
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("HF_DATASETS_OFFLINE", "1")
    here = Path(__file__).resolve().parent
    local_paths = {here, here.parent}
    sys.path[:] = [
        entry for entry in sys.path
        if Path(entry or ".").resolve() not in local_paths
    ]
    from docker.models.containers import ContainerCollection
    import swebench.harness.run_evaluation as run_evaluation
    from swebench.harness.utils import str2bool

    install_harness_fixes(run_evaluation, ContainerCollection)

    parser = ArgumentParser(
        description="Run evaluation harness for the given dataset and predictions.",
        formatter_class=ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("-d", "--dataset_name", default="SWE-bench/SWE-bench_Lite", type=str)
    parser.add_argument("-s", "--split", type=str, default="test")
    parser.add_argument("-i", "--instance_ids", nargs="+", type=str)
    parser.add_argument("-p", "--predictions_path", type=str, required=True)
    parser.add_argument("--max_workers", type=int, default=4)
    parser.add_argument("--open_file_limit", type=int, default=4096)
    parser.add_argument("-t", "--timeout", type=int, default=1_800)
    parser.add_argument("-id", "--run_id", type=str, required=True)
    parser.add_argument("--rewrite_reports", type=str2bool, default=False)
    parser.add_argument("--report_dir", type=str, default=".")
    parser.add_argument("--modal", type=str2bool, default=False)
    args = parser.parse_args(argv)
    run_evaluation.main(**vars(args))


if __name__ == "__main__":
    main()
