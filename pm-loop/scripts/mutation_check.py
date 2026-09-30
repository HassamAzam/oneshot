"""Mutation check for the grooming rules: mutate only rule-bearing functions, run the suite, report survivors.

    python3 mutation_check.py      (from this folder; works on a temporary copy, never on these files)

A survivor is a rule no test protects: add a test, or delete the rule. Last run (2026-09-30):
177 mutants, 158 killed (89%); the 19 survivors are tuning values, fallbacks and formatting.
"""
import ast, json, subprocess, sys
from pathlib import Path

TARGETS = {
    "groom_gitlab.py": ["compose_labels", "check_labels", "existing_issue", "tests_mr_problem", "sweep", "add_section", "unlabelled"],
    "groom.py": ["_spec", "_finish_body", "create", "notify_sweep"],
    "resolve_plane_ticket.py": ["effective_route", "normalise_id", "resolve"],
    "jev_layers.py": ["decide"],
}
SWAP = {ast.Eq: ast.NotEq, ast.NotEq: ast.Eq, ast.Lt: ast.GtE, ast.LtE: ast.Gt, ast.Gt: ast.LtE, ast.GtE: ast.Lt,
        ast.In: ast.NotIn, ast.NotIn: ast.In, ast.Is: ast.IsNot, ast.IsNot: ast.Is}


def sites(tree, names):
    for fn in ast.walk(tree):
        if isinstance(fn, ast.FunctionDef) and fn.name in names:
            body = fn.body[1:] if fn.body and isinstance(fn.body[0], ast.Expr) and isinstance(getattr(fn.body[0], "value", None), ast.Constant) else fn.body
            for stmt in body:
                for node in ast.walk(stmt):
                    yield fn.name, node


def mutants(src, names, tree=None):
    tree = tree if tree is not None else ast.parse(src)
    count = 0
    for fname, node in list(sites(tree, names)):
        kinds = []
        if isinstance(node, ast.Compare):
            kinds += [("cmp", i) for i, op in enumerate(node.ops) if type(op) in SWAP]
        elif isinstance(node, ast.BoolOp):
            kinds.append(("bool", None))
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            kinds.append(("not", None))
        elif isinstance(node, ast.Constant) and isinstance(node.value, bool):
            kinds.append(("boolconst", None))
        elif isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            kinds.append(("num", None))
        elif isinstance(node, ast.If):
            kinds.append(("ifnot", None))
        for kind, idx in kinds:
            yield count, fname, kind, node, idx
            count += 1


def apply(src, target_count, names):
    tree = ast.parse(src)
    for count, fname, kind, node, idx in mutants(src, names, tree):
        if count != target_count:
            continue
        desc = f"{fname}:{node.lineno} {kind}"
        if kind == "cmp":
            node.ops[idx] = SWAP[type(node.ops[idx])]()
        elif kind == "bool":
            node.op = ast.Or() if isinstance(node.op, ast.And) else ast.And()
        elif kind == "not":
            node.op = ast.UAdd()
            node.operand = ast.Call(func=ast.Name(id="bool", ctx=ast.Load()), args=[node.operand], keywords=[])
        elif kind == "boolconst":
            node.value = not node.value
        elif kind == "num":
            node.value = node.value + 1
        elif kind == "ifnot":
            node.test = ast.UnaryOp(op=ast.Not(), operand=node.test)
        return desc, ast.unparse(tree), ast.get_source_segment(src, node) if kind != "ifnot" else f"if {ast.unparse(node.test.operand)[:70]}"
    return None


def main():
    import os, shutil, tempfile
    work = Path(tempfile.mkdtemp(prefix="pm-loop-mutation-"))
    for f in Path(__file__).resolve().parent.glob("*.py"):
        shutil.copy(f, work)
    os.chdir(work)
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    results = []
    for file, names in TARGETS.items():
        path = Path(file)
        src = path.read_text()
        total = sum(1 for _ in mutants(src, names))
        for n in range(total):
            out = apply(src, n, names)
            if not out:
                continue
            desc, mutated, snippet = out
            if mutated == ast.unparse(ast.parse(src)):
                raise SystemExit(f"harness bug: mutant {desc} did not change the code")
            path.write_text(mutated)
            r = subprocess.run([sys.executable, "-B", "-m", "pytest", "-x", "-q", "-p", "no:cacheprovider",
                                "test_groom.py"], capture_output=True, text=True, timeout=120, env=env)
            results.append({"file": file, "site": desc, "code": (snippet or "")[:90], "killed": r.returncode != 0})
            path.write_text(src)
    killed = sum(r["killed"] for r in results)
    print(f"mutants {len(results)}  killed {killed}  survived {len(results) - killed}  score {killed / len(results):.0%}")
    for r in results:
        if not r["killed"]:
            print(f"SURVIVED {r['file']} {r['site']}: {r['code']}")
    Path("mutation_results.json").write_text(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
