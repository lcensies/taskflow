"""Black-box helpers for taskflow-rich-transcript-view e2e tests (stdlib only)."""
import glob, json, os, re, subprocess, tempfile, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NODE = ["node", "--conditions=development", "--experimental-strip-types", "--no-warnings"]
TERMINAL = ("completed", "failed", "cancelled", "done")


def clean_env(**extra):
    env = {k: v for k, v in os.environ.items()
           if not (k.startswith("PI_TASKFLOW_CTX") or k.startswith("TASKFLOW_DETACHED")
                   or k in ("PI_TASKFLOW_NODE_ID", "PI_TASKFLOW_STEER_FILE"))}
    env.update(extra)
    return env


def header(host):
    return {"type": "taskflow_transcript", "host": host, "v": 1}


def parse(lines):
    text = "\n".join(l if isinstance(l, str) else json.dumps(l) for l in lines) + "\n"
    r = subprocess.run(NODE + [str(ROOT / "tests/e2e/_parse_driver.mts")], input=text,
                       capture_output=True, text=True, env=clean_env(), cwd=ROOT)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout.strip().splitlines()[-1])


def pi_msg(content, role="assistant", **extra):
    return {"type": "message_end", "message": {"role": role, "content": content, **extra}}


FAKE_CODEX = """#!/usr/bin/env node
const o = (x) => console.log(JSON.stringify(x));
o({type:"thread.started",thread_id:"t"});
o({type:"item.started",item:{id:"i1",type:"command_execution",command:"echo hi",status:"in_progress"}});
o({type:"item.completed",item:{id:"i1",type:"command_execution",command:"echo hi",aggregated_output:"hi\\n",exit_code:0,status:"completed"}});
o({type:"item.completed",item:{id:"i2",type:"agent_message",text:"CANNED FINAL"}});
o({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}});
"""

FAKE_CLAUDE = """#!/usr/bin/env node
const o = (x) => console.log(JSON.stringify(x));
o({type:"system",subtype:"init",session_id:"s"});
o({type:"assistant",message:{role:"assistant",content:[{type:"tool_use",id:"t1",name:"Bash",input:{command:"ls"}}],usage:{input_tokens:1,output_tokens:1}}});
o({type:"user",message:{role:"user",content:[{type:"tool_result",tool_use_id:"t1",content:"a\\nb",is_error:false}]}});
o({type:"assistant",message:{role:"assistant",content:[{type:"text",text:"CLAUDE FINAL"}],usage:{input_tokens:1,output_tokens:1}}});
o({type:"result",subtype:"success",is_error:false,result:"CLAUDE FINAL",usage:{input_tokens:1,output_tokens:2},total_cost_usd:0});
"""


class Sandbox:
    """Temp cwd + fake host binary + a stdio MCP server for one host."""

    def __init__(self, host, fake_src):
        self.host = host
        self.dir = tempfile.mkdtemp(prefix="tf-rich-")
        fake = Path(self.dir) / f"fake-{host}"
        fake.write_text(fake_src)
        fake.chmod(0o755)
        Path(self.dir, ".pi/agents").mkdir(parents=True)
        Path(self.dir, ".pi/agents/echo.md").write_text("---\nname: echo\ndescription: echo\n---\nYou echo.\n")
        env = clean_env(HOME=self.dir, TASKFLOW_AGENT_DIR=self.dir + "/agent",
                        PI_TASKFLOW_CLAUDE_UNSAFE_BYPASS="1")
        env[f"PI_TASKFLOW_{host.upper()}_BIN"] = str(fake)
        self.p = subprocess.Popen(NODE + [str(ROOT / f"packages/{host}-taskflow/src/mcp/bin.ts")],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True, env=env, cwd=self.dir)
        self.i = 0
        self.rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                "clientInfo": {"name": "t", "version": "0"}})
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.p.stdin.flush()

    def rpc(self, method, params=None):
        self.i += 1
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.i, "method": method, "params": params or {}}) + "\n")
        self.p.stdin.flush()
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError(self.p.stderr.read())
            d = json.loads(line)
            if d.get("id") == self.i:
                return d

    def run_flow(self, flow, timeout=60):
        r = self.rpc("tools/call", {"name": "taskflow_run", "arguments": {"define": flow, "mode": "background"}})
        rid = re.search(r"run (\S+)", r["result"]["content"][0]["text"]).group(1)
        deadline = time.time() + timeout
        while time.time() < deadline:
            st = glob.glob(f"{self.dir}/.pi/taskflows/runs/*/{rid}.json")
            if st:
                s = json.loads(Path(st[0]).read_text())
                if s["status"] in TERMINAL:
                    return rid, s
            time.sleep(0.25)
        raise TimeoutError(rid)

    def transcript(self, flow, rid, node):
        p = Path(f"{self.dir}/.pi/taskflows/runs/{flow}/{rid}/{node}.ndjson")
        return p.read_text().splitlines() if p.exists() else None

    def close(self):
        self.p.kill()
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)
