"""Zero-dependency runner (pytest not required): python3 tests/e2e/run.py"""
import importlib.util, json, sys, traceback
from pathlib import Path
res = {"passed": [], "failed": [], "errors": []}
for f in sorted(Path(__file__).parent.glob("test_*.py")):
    spec = importlib.util.spec_from_file_location(f.stem, f); mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as e:
        res["errors"].append(f"{f.name}: {e}"); continue
    for n in dir(mod):
        if n.startswith("test_"):
            tid = f"{f.name}::{n}"
            try:
                getattr(mod, n)(); res["passed"].append(tid)
            except AssertionError:
                res["failed"].append(tid); traceback.print_exc()
            except Exception as e:
                res["errors"].append(f"{tid}: {e!r}"); traceback.print_exc()
print(json.dumps(res))
sys.exit(1 if res["failed"] or res["errors"] else 0)
