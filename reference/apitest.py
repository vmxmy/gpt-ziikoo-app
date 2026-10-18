#!/usr/bin/env python3
"""API 站点梯度筛选测试工具。

用法:
  python3 apitest.py --site https://x.com --key sk-xxx --protocol responses --question thibault
  python3 apitest.py --question candy                # site/key/protocol 用 .env 里的默认值
  python3 apitest.py --list                          # 列出题库

梯度流程: 1 次 -> 5 次 -> 10 次 -> 15 次, 每关需达标准确数才晋级:
  Stage1 1/1, Stage2 >=4/5, Stage3 >=9/10, Stage4 >=14/15
  全部过关时总分最低 28/31 = 90.3%, 与"上架线 >=90%"对齐。
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

STAGES = [(1, 1), (5, 4), (10, 9), (15, 14)]  # (本轮调用次数, 晋级所需正确数)
LIST_THRESHOLD = 0.90
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
DEFAULT_ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")


def load_env(path):
    env = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            env[k] = v.replace("\\n", "\n").replace("\\t", "\t").replace('\\"', '"')
    return env


def load_questions(env):
    qs = {}
    i = 1
    while f"Q{i}_NAME" in env:
        qs[env[f"Q{i}_NAME"].lower()] = {
            "text": env.get(f"Q{i}_TEXT", ""),
            "type": env.get(f"Q{i}_TYPE", "contains"),
            "expected": env.get(f"Q{i}_EXPECTED", ""),
        }
        i += 1
    return qs


def score(answer, q):
    """返回 (是否正确, 判定说明)。"""
    t, exp = q["type"], q["expected"]
    if t == "yes_no":
        low = answer.lower().lstrip()
        got = "YES" if low.startswith("yes") else "NO" if low.startswith("no") else "OTHER"
        return got == exp.upper(), got
    if t == "numbers":
        nums = set(re.findall(r"\d+", answer))
        need = [n.strip() for n in exp.split(",") if n.strip()]
        missing = [n for n in need if n not in nums]
        return (not missing), ("ok" if not missing else f"missing {missing}")
    return exp in answer, ("ok" if exp in answer else "not found")


def build_request(site, key, protocol, model, question_text, effort=None):
    if protocol == "chat":
        url = site.rstrip("/") + "/v1/chat/completions"
        payload = {"model": model, "messages": [{"role": "user", "content": question_text}]}
        if effort:
            payload["reasoning_effort"] = effort
    else:
        url = site.rstrip("/") + "/v1/responses"
        payload = {"model": model, "input": question_text}
        if effort:
            payload["reasoning"] = {"effort": effort}
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key,
        "User-Agent": UA,
    })
    return req


def call_once(site, key, protocol, model, question_text, effort=None):
    with urllib.request.urlopen(build_request(site, key, protocol, model, question_text, effort), timeout=180) as r:
        return json.loads(r.read().decode(), strict=False)


def extract(d, protocol):
    try:
        if protocol == "chat":
            msg = d["choices"][0]["message"]
            a = (msg.get("content") or "").strip()
            rt = (d.get("usage", {}).get("completion_tokens_details", {}) or {}).get("reasoning_tokens")
        else:
            txts = [c.get("text", "") for o in d.get("output", []) if o.get("type") == "message"
                    for c in o.get("content", []) if c.get("type") == "output_text"]
            a = "".join(txts).strip()
            rt = (d.get("usage", {}).get("output_tokens_details", {}) or {}).get("reasoning_tokens")
        return a, rt
    except (KeyError, IndexError, TypeError):
        return "", None


def one_valid_run(label, site, key, protocol, model, question_text, q, effort=None):
    """带 3 次重试的单次有效调用。返回 (正确?, 说明) 或 None(站点不可达)。"""
    for attempt in range(1, 4):
        try:
            d = call_once(site, key, protocol, model, question_text, effort)
        except urllib.error.HTTPError as e:
            print(f"  {label} attempt {attempt}: HTTP {e.code}: {e.read()[:100]!r}", flush=True)
            continue
        except Exception as e:
            print(f"  {label} attempt {attempt}: EXC {type(e).__name__}: {str(e)[:90]}", flush=True)
            continue
        if d.get("error"):
            print(f"  {label} attempt {attempt}: API ERROR: {json.dumps(d['error'], ensure_ascii=False)[:120]}", flush=True)
            continue
        a, rt = extract(d, protocol)
        if not a:
            print(f"  {label} attempt {attempt}: empty answer, retry", flush=True)
            continue
        ok, note = score(a, q)
        print(f"  {label}: correct={ok} ({note}) | reasoning_tokens={rt} | answer={a[:70]!r}", flush=True)
        return ok, note
    return None


def main():
    p = argparse.ArgumentParser(description="API 站点梯度筛选测试")
    p.add_argument("--site", help="测试站点根地址, 如 https://x.com")
    p.add_argument("--key", help="API 密钥")
    p.add_argument("--protocol", choices=["chat", "responses"], help="测试协议")
    p.add_argument("--question", help="题库中的题目名 (见 --list)")
    p.add_argument("--model", help="模型名, 默认取 .env MODEL")
    p.add_argument("--effort", choices=["low", "medium", "high"], help="推理强度 (responses: reasoning.effort / chat: reasoning_effort)")
    p.add_argument("--env", default=DEFAULT_ENV, help=".env 路径 (默认脚本同目录)")
    p.add_argument("--list", action="store_true", help="列出题库后退出")
    args = p.parse_args()

    env = load_env(args.env)
    questions = load_questions(env)

    if args.list:
        print(f"题库 ({args.env}):")
        for name, q in questions.items():
            print(f"  {name:12s} type={q['type']:8s} expected={q['expected']!r}  text={q['text'][:50]!r}")
        return

    site = args.site or env.get("SITE")
    key = args.key or env.get("KEY")
    protocol = args.protocol or env.get("PROTOCOL")
    model = args.model or env.get("MODEL", "gpt-6-astra")
    if not (site and key and protocol and args.question):
        p.error("需要 --site --key --protocol --question (或在这些 .env 键里给默认值: SITE/KEY/PROTOCOL)")
    if args.question.lower() not in questions:
        p.error(f"题目 {args.question!r} 不在题库中, 可用: {', '.join(questions)}")

    q = questions[args.question.lower()]
    print(f"===== {site} [{protocol}] model={model} question={args.question} effort={args.effort or 'default'} =====", flush=True)

    total_calls = total_correct = 0
    eliminated = False
    for si, (n, need) in enumerate(STAGES, 1):
        print(f"[Stage {si}] {n} 次调用, 晋级需 >= {need} 正确", flush=True)
        ok = 0
        for i in range(1, n + 1):
            r = one_valid_run(f"S{si}-{i:02d}", site, key, protocol, model, q["text"], q, args.effort)
            if r is None:
                print(f"RESULT: 站点不可达 (Stage {si} 第 {i} 次连续 3 次无有效响应) | 判定: 不可上架", flush=True)
                sys.exit(1)
            ok += 1 if r[0] else 0
        total_calls += n
        total_correct += ok
        print(f"[Stage {si}] 正确 {ok}/{n} ({ok / n:.0%})", flush=True)
        if ok < need:
            print(f"RESULT: Stage {si} 淘汰 ({ok}/{n} < {need}) | 累计 {total_correct}/{total_calls} | 判定: 不可上架", flush=True)
            eliminated = True
            break

    if not eliminated:
        rate = total_correct / total_calls
        verdict = "可上架" if rate >= LIST_THRESHOLD else "不可上架"
        print(f"RESULT: 全部关卡完成 | 总正确率 {total_correct}/{total_calls} = {rate:.1%} | 判定: {verdict}", flush=True)


if __name__ == "__main__":
    main()
